import { resolvedCodexBin } from "../../services/codex-runner.js";
import { installJsonLogger } from "../../services/sse.js";
import { nanoid } from "nanoid";
import {
  stripAnsi,
  estTokens,
  estTokensForMessages,
  joinMessages,
  impliedEffortForModel,
  normalizeModel,
  applyCors as applyCorsUtil,
} from "../../utils.js";
import { config as CFG } from "../../config/index.js";
import { selectBackendMode } from "../../services/backend-mode.js";
import { acceptedModelIds } from "../../config/models.js";
import { resolveChoiceIndexFromPayload } from "./choice-index.js";
import { modelNotFoundBody, invalidRequestBody, tokensExceededBody } from "../../lib/errors.js";
import {
  appendUsage,
  appendProtoEvent,
  extractUseToolBlocks,
  LOG_PROTO,
  logSanitizerSummary,
  logSanitizerToggle,
} from "../../dev-logging.js";
import {
  buildBackendArgs,
  createFinishReasonTracker,
  extractFinishReasonFromMessage,
  logFinishReasonTelemetry,
  coerceAssistantContent,
  validateOptionalChatParams,
  resolveChatCopilotDetection,
  resolveOutputMode,
} from "./shared.js";
import { createToolCallAggregator } from "../../lib/tool-call-aggregator.js";
import {
  buildCanonicalXml,
  extractTextualUseToolBlock,
  getToolOutputOptions,
  normalizeToolCallSnapshot,
  trimTrailingTextAfterToolBlocks,
} from "./tool-output.js";
import { normalizeToolCalls } from "./tool-call-normalizer.js";
import { buildToolCallDeltaFromDynamicRequest } from "../../lib/tools/dynamic-tools.js";
import {
  sanitizeMetadataTextSegment,
  extractMetadataFromPayload,
  normalizeMetadataKey,
} from "../../lib/metadata-sanitizer.js";
import { createJsonRpcChildAdapter } from "../../services/transport/child-adapter.js";
import { normalizeChatJsonRpcRequest, ChatJsonRpcNormalizationError } from "./request.js";
import { requireModel } from "./require-model.js";
import { mapTransportError } from "../../services/transport/index.js";
import {
  applyProxyTraceHeaders,
  ensureReqId,
  setHttpContext,
  getHttpContext,
} from "../../lib/request-context.js";
import { logHttpRequest } from "../../dev-trace/http.js";
import { maybeInjectIngressGuardrail } from "../../lib/ingress-guardrail.js";
import { captureChatNonStream } from "./capture.js";
import {
  summarizeTextParts,
  summarizeToolCalls,
} from "../../lib/observability/transform-summary.js";
import { logStructured } from "../../services/logging/schema.js";

export { buildCanonicalXml, extractTextualUseToolBlock } from "./tool-output.js";

export const buildAssistantMessage = ({
  snapshot = [],
  choiceContent = "",
  normalizedContent = "",
  canonicalReason = "stop",
  isObsidianOutput = true,
  functionCallPayload = null,
} = {}) => {
  const toolOutputOptions = getToolOutputOptions();
  const { records: toolCallRecords, truncated: toolCallsTruncated } = normalizeToolCallSnapshot(
    snapshot,
    toolOutputOptions
  );
  const hasToolCalls = toolCallRecords.length > 0;
  let assistantContent = choiceContent && choiceContent.length ? choiceContent : normalizedContent;
  if (canonicalReason === "content_filter") {
    assistantContent = null;
  } else if (hasToolCalls) {
    assistantContent = isObsidianOutput
      ? buildCanonicalXml(toolCallRecords, toolOutputOptions) ||
        extractTextualUseToolBlock(choiceContent, toolOutputOptions) ||
        normalizedContent ||
        choiceContent
      : null;
  } else if (functionCallPayload) {
    assistantContent = null;
  }

  const message = { role: "assistant" };
  if (hasToolCalls) {
    message.tool_calls = toolCallRecords.map((entry) => ({
      ...entry,
      function:
        entry.function && typeof entry.function === "object"
          ? { ...entry.function }
          : entry.function,
    }));
    message.content = assistantContent;
  } else if (functionCallPayload) {
    message.function_call = { ...functionCallPayload };
    message.content = assistantContent;
  } else {
    message.content = assistantContent;
  }

  const normalizedMessage = normalizeToolCalls(message);
  if (
    typeof normalizedMessage.content === "string" &&
    normalizedMessage.content.includes("</use_tool>")
  ) {
    normalizedMessage.content = trimTrailingTextAfterToolBlocks(normalizedMessage.content);
  }

  const normalizedToolCallCount = normalizedMessage.tool_calls?.length ?? 0;
  const normalizedHasToolCalls = normalizedToolCallCount > 0;

  return {
    message: normalizedMessage,
    hasToolCalls: normalizedHasToolCalls,
    toolCallsTruncated,
    toolCallCount: normalizedToolCallCount,
  };
};

const DEFAULT_MODEL = CFG.CODEX_MODEL;
const SANDBOX_MODE = CFG.PROXY_SANDBOX_MODE;
const CODEX_WORKDIR = CFG.PROXY_CODEX_WORKDIR;
const FORCE_PROVIDER = CFG.CODEX_FORCE_PROVIDER.trim();
const IS_DEV_ENV = (CFG.PROXY_ENV || "").toLowerCase() === "dev";
const ACCEPTED_MODEL_IDS = acceptedModelIds(DEFAULT_MODEL);
const REQ_TIMEOUT_MS = CFG.PROXY_TIMEOUT_MS;
const NONSTREAM_TRUNCATE_MS = CFG.PROXY_NONSTREAM_TRUNCATE_AFTER_MS;
const KILL_ON_DISCONNECT = CFG.PROXY_KILL_ON_DISCONNECT.toLowerCase() !== "false";
const CORS_ENABLED = CFG.PROXY_ENABLE_CORS.toLowerCase() !== "false";
const CORS_ALLOWED = CFG.PROXY_CORS_ALLOWED_ORIGINS;
const applyCors = (req, res) => applyCorsUtil(req, res, CORS_ENABLED, CORS_ALLOWED);
const MAX_CHAT_CHOICES = Math.max(1, Number(CFG.PROXY_MAX_CHAT_CHOICES || 1));
const ENABLE_PARALLEL_TOOL_CALLS = IS_DEV_ENV && CFG.PROXY_ENABLE_PARALLEL_TOOL_CALLS;
const SANITIZE_METADATA = !!CFG.PROXY_SANITIZE_METADATA;
const APPROVAL_POLICY = CFG.PROXY_APPROVAL_POLICY;

const logUsageFailure = ({
  req,
  res,
  reqId,
  started,
  route,
  mode,
  statusCode,
  reason = "error",
  errorCode,
  requestedModel,
  effectiveModel,
  stream = false,
}) => {
  try {
    const ctx = getHttpContext(res) || {};
    appendUsage({
      req_id: reqId,
      route: ctx.route || route,
      mode: ctx.mode || mode,
      method: req.method || "POST",
      status_code: statusCode,
      status: statusCode,
      stream,
      requested_model: requestedModel,
      effective_model: effectiveModel,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_est: 0,
      completion_tokens_est: 0,
      total_tokens_est: 0,
      duration_ms: Math.max(Date.now() - started, 0),
      emission_trigger: reason,
      usage_included: false,
      user_agent: req.headers["user-agent"] || "",
      error_code: errorCode,
    });
  } catch (err) {
    if (IS_DEV_ENV) {
      console.error("[dev][usage][nonstream] failed to append usage", err);
    }
  }
};

const resolveEmissionTrigger = (trail, fallback = "error") => {
  if (!Array.isArray(trail) || trail.length === 0) return fallback;
  const last = trail[trail.length - 1];
  if (!last) return fallback;
  if (typeof last === "string") return last || fallback;
  if (typeof last === "object") {
    return last.canonical || last.raw || last.source || fallback;
  }
  return fallback;
};

const buildInvalidChoiceError = (value) =>
  invalidRequestBody(
    "n",
    `n must be an integer between 1 and ${MAX_CHAT_CHOICES}; received ${value}`
  );

const normalizeChoiceCount = (raw) => {
  if (raw === undefined || raw === null) return { ok: true, value: 1 };
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return { ok: true, value: raw };
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isInteger(parsed)) {
      return { ok: true, value: parsed };
    }
  }
  return { ok: false, error: buildInvalidChoiceError(raw) };
};

const respondWithJson = (res, statusCode, payload) => {
  let body = payload;
  const transform = res?.locals?.responseTransform;
  if (typeof transform === "function") {
    try {
      const transformed = transform(payload, statusCode);
      if (transformed !== undefined) body = transformed;
    } catch (transformErr) {
      console.error("[proxy][chat.nonstream] response transform failed", transformErr);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: "Internal server error during response transformation.",
            type: "server_error",
            code: "response_transform_failed",
          },
        });
      }
      return;
    }
  }

  if (res.headersSent) {
    console.error("[proxy][chat.nonstream] attempted to send JSON after headers were already sent");
    return;
  }

  try {
    res.status(statusCode).json(body);
    return;
  } catch (err) {
    console.error("[proxy][chat.nonstream] res.json() failed, falling back", err);
  }

  if (res.headersSent) {
    console.error("[proxy][chat.nonstream] headers sent during fallback attempt; cannot recover");
    return;
  }

  try {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  } catch (fallbackErr) {
    console.error("[proxy][chat.nonstream] fallback JSON response failed", fallbackErr);
  }
};

// POST /v1/chat/completions with stream=false
export async function postChatNonStream(req, res) {
  const route = res.locals?.routeOverride || "/v1/chat/completions";
  const mode = res.locals?.modeOverride || "chat_nonstream";
  setHttpContext(res, { route, mode });
  const reqId = ensureReqId(res);
  applyProxyTraceHeaders(res);
  installJsonLogger(res);
  const started = Date.now();
  let responded = false;
  const unknownFinishReasons = new Set();
  const finishReasonTracker = createFinishReasonTracker({
    fallback: "stop",
    onUnknown: (info) => {
      if (!info) return;
      const value = info.value || info.raw;
      if (value) unknownFinishReasons.add(value);
    },
  });
  const toolCallAggregator = createToolCallAggregator();
  let assistantFunctionCall = null;
  let hasToolCalls = false;
  let hasFunctionCall = false;
  const choiceStates = new Map();

  const getChoiceState = (choiceIndex = 0) => {
    const normalized = Number.isInteger(choiceIndex) && choiceIndex >= 0 ? choiceIndex : 0;
    if (!choiceStates.has(normalized)) {
      choiceStates.set(normalized, {
        index: normalized,
        content: "",
      });
    }
    return choiceStates.get(normalized);
  };

  const choiceHasToolCalls = (choiceIndex = 0) => {
    const normalized = Number.isInteger(choiceIndex) && choiceIndex >= 0 ? choiceIndex : 0;
    return toolCallAggregator.hasCalls({ choiceIndex: normalized });
  };

  const determineChoiceFinishReason = (choiceIndex, fallbackReason, hasChoiceTools = false) => {
    if (hasChoiceTools || choiceHasToolCalls(choiceIndex)) return "tool_calls";
    if (fallbackReason === "tool_calls") return "stop";
    return fallbackReason;
  };

  const getPrimaryContent = () => {
    if (choiceStates.size) {
      const sorted = Array.from(choiceStates.keys()).sort((a, b) => a - b);
      for (const idx of sorted) {
        const state = choiceStates.get(idx);
        if (state?.content) return state.content;
      }
    }
    return "";
  };

  const sanitizedMetadataSummary = { count: 0, keys: new Set(), sources: new Set() };
  const seenSanitizedRemovalSignatures = new Set();

  logSanitizerToggle({
    enabled: SANITIZE_METADATA,
    trigger: "request",
    route: "/v1/chat/completions",
    mode: "chat_nonstream",
    reqId,
  });

  const getSanitizerSummaryData = () => ({
    count: sanitizedMetadataSummary.count,
    keys: Array.from(sanitizedMetadataSummary.keys),
    sources: Array.from(sanitizedMetadataSummary.sources),
  });

  const recordSanitizedMetadata = ({ stage, eventType, metadata, removed, sources }) => {
    if (!SANITIZE_METADATA) return;
    const metadataObject =
      metadata && typeof metadata === "object" && Object.keys(metadata).length ? metadata : null;
    const removedEntries = Array.isArray(removed)
      ? removed.filter((entry) => entry && typeof entry === "object")
      : [];
    if (metadataObject) {
      for (const key of Object.keys(metadataObject)) {
        const normalizedKey = normalizeMetadataKey(key);
        if (normalizedKey) sanitizedMetadataSummary.keys.add(normalizedKey);
      }
    }
    const uniqueRemovedEntries = [];
    if (removedEntries.length) {
      for (const entry of removedEntries) {
        const normalizedKey = normalizeMetadataKey(entry.key);
        const signature = `${normalizedKey || ""}::${entry.raw || ""}`;
        if (!signature.trim()) continue;
        if (seenSanitizedRemovalSignatures.has(signature)) continue;
        seenSanitizedRemovalSignatures.add(signature);
        if (normalizedKey) sanitizedMetadataSummary.keys.add(normalizedKey);
        uniqueRemovedEntries.push({ ...entry, key: normalizedKey || entry.key });
      }
      sanitizedMetadataSummary.count += uniqueRemovedEntries.length;
    }
    const sourceList = Array.isArray(sources)
      ? sources.filter((source) => typeof source === "string" && source)
      : [];
    for (const source of sourceList) sanitizedMetadataSummary.sources.add(source);
    if (!metadataObject && !uniqueRemovedEntries.length) return;
    appendProtoEvent({
      ts: Date.now(),
      req_id: reqId,
      route: "/v1/chat/completions",
      mode: "chat_nonstream",
      kind: "metadata_sanitizer",
      toggle_enabled: true,
      stage,
      event_type: eventType,
      metadata: metadataObject || undefined,
      removed_lines: uniqueRemovedEntries.length ? uniqueRemovedEntries : undefined,
      metadata_sources: sourceList.length ? sourceList : undefined,
    });
  };

  const applyMetadataSanitizer = (segment, metadataInfo, { stage, eventType }) => {
    if (!SANITIZE_METADATA) return segment;
    const metadata = metadataInfo?.metadata || {};
    const { text: sanitizedText, removed } = sanitizeMetadataTextSegment(segment ?? "", metadata);
    if (metadataInfo || (removed && removed.length)) {
      recordSanitizedMetadata({
        stage,
        eventType,
        metadata: metadataInfo ? metadata : null,
        removed,
        sources: metadataInfo?.sources,
      });
    }
    return sanitizedText;
  };

  const trackToolSignals = (payload, fallbackChoiceIndex = null) => {
    if (!payload || typeof payload !== "object") return;
    const resolvedChoiceIndex = (() => {
      const idx = resolveChoiceIndexFromPayload(payload);
      if (Number.isInteger(idx) && idx >= 0) return idx;
      if (Number.isInteger(fallbackChoiceIndex) && fallbackChoiceIndex >= 0)
        return fallbackChoiceIndex;
      return 0;
    })();
    const toolCalls = payload.tool_calls || payload.toolCalls;
    if (Array.isArray(toolCalls) && toolCalls.length) {
      hasToolCalls = true;
    }
    const functionCall = payload.function_call || payload.functionCall;
    if (functionCall && typeof functionCall === "object") {
      assistantFunctionCall = functionCall;
      hasFunctionCall = true;
    }
    if (payload.message && typeof payload.message === "object") {
      trackToolSignals(payload.message, resolvedChoiceIndex);
    }
    if (payload.delta && typeof payload.delta === "object")
      trackToolSignals(payload.delta, resolvedChoiceIndex);
    if (Array.isArray(payload.deltas)) {
      for (const item of payload.deltas) trackToolSignals(item, resolvedChoiceIndex);
    }
    if (payload.arguments && typeof payload.arguments === "object") {
      trackToolSignals(payload.arguments, resolvedChoiceIndex);
    }
  };

  const body = req.body || {};
  const originalBody = (() => {
    try {
      return structuredClone(body);
    } catch {
      try {
        return JSON.parse(JSON.stringify(body));
      } catch {
        return {};
      }
    }
  })();
  res.locals = res.locals || {};
  res.locals.request_body_original = originalBody;
  logHttpRequest({
    req,
    res,
    route,
    mode,
    body,
  });

  const model = requireModel({
    req,
    res,
    body,
    reqId,
    started,
    route: "/v1/chat/completions",
    mode: "chat_nonstream",
    logUsageFailure,
    applyCors,
    sendJson: (statusCode, payload) => respondWithJson(res, statusCode, payload),
  });
  if (!model) return;

  let messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    logUsageFailure({
      req,
      res,
      reqId,
      started,
      route: "/v1/chat/completions",
      mode: "chat_nonstream",
      statusCode: 400,
      reason: "invalid_request",
      errorCode: "messages_required",
    });
    applyCors(req, res);
    return respondWithJson(res, 400, {
      error: {
        message: "messages[] required",
        type: "invalid_request_error",
        param: "messages",
        code: "invalid_request_error",
      },
    });
  }

  const guardrailResult = maybeInjectIngressGuardrail({
    req,
    res,
    messages,
    enabled: CFG.PROXY_INGRESS_GUARDRAIL,
    route,
    mode,
    endpointMode: res.locals?.endpoint_mode || "chat_completions",
  });
  if (guardrailResult.injected) {
    messages = guardrailResult.messages;
  }
  const { copilotDetection } = resolveChatCopilotDetection({
    headers: req?.headers,
    messages,
    markers: guardrailResult.markers,
  });
  res.locals.copilot_detected = copilotDetection.copilot_detected;
  res.locals.copilot_detect_tier = copilotDetection.copilot_detect_tier;
  res.locals.copilot_detect_reasons = copilotDetection.copilot_detect_reasons;

  const {
    ok: choiceOk,
    value: requestedChoiceCount = 1,
    error: choiceError,
  } = normalizeChoiceCount(body.n);
  if (!choiceOk) {
    logUsageFailure({
      req,
      res,
      reqId,
      started,
      route: "/v1/chat/completions",
      mode: "chat_nonstream",
      statusCode: 400,
      reason: "invalid_request",
      errorCode: choiceError?.error?.code || "invalid_choice",
    });
    applyCors(req, res);
    return respondWithJson(res, 400, choiceError);
  }
  if (requestedChoiceCount < 1 || requestedChoiceCount > MAX_CHAT_CHOICES) {
    logUsageFailure({
      req,
      res,
      reqId,
      started,
      route: "/v1/chat/completions",
      mode: "chat_nonstream",
      statusCode: 400,
      reason: "invalid_request",
      errorCode: "invalid_choice_range",
    });
    applyCors(req, res);
    return respondWithJson(res, 400, buildInvalidChoiceError(requestedChoiceCount));
  }
  const choiceCount = requestedChoiceCount;
  const outputMode = resolveOutputMode({
    headerValue: req.headers["x-proxy-output-mode"],
    defaultValue: CFG.PROXY_OUTPUT_MODE,
    copilotDefault: "obsidian-xml",
    copilotDetection: CFG.PROXY_COPILOT_AUTO_DETECT ? copilotDetection : null,
  });
  res.setHeader("x-proxy-output-mode", outputMode);
  const isObsidianOutput = outputMode === "obsidian-xml";
  res.locals.output_mode_requested = req.headers["x-proxy-output-mode"]
    ? String(req.headers["x-proxy-output-mode"])
    : null;
  res.locals.output_mode_effective = outputMode;
  if (!res.locals.endpoint_mode) res.locals.endpoint_mode = "chat";

  const backendMode = selectBackendMode();
  const idleTimeoutMs = CFG.PROXY_IDLE_TIMEOUT_MS;

  const optionalValidation = validateOptionalChatParams(body, {
    allowJsonSchema: true,
  });
  if (!optionalValidation.ok) {
    logUsageFailure({
      req,
      res,
      reqId,
      started,
      route: "/v1/chat/completions",
      mode: "chat_nonstream",
      statusCode: 400,
      reason: "invalid_optional_params",
      errorCode: optionalValidation.error?.error?.code,
    });
    applyCors(req, res);
    return respondWithJson(res, 400, optionalValidation.error);
  }

  const { requested: requestedModel, effective: effectiveModel } = normalizeModel(
    model,
    DEFAULT_MODEL,
    Array.from(ACCEPTED_MODEL_IDS)
  );
  try {
    console.log(
      `[proxy] model requested=${requestedModel} effective=${effectiveModel} stream=${!!body.stream}`
    );
  } catch {}
  if (!ACCEPTED_MODEL_IDS.has(requestedModel)) {
    logUsageFailure({
      req,
      res,
      reqId,
      started,
      route: "/v1/chat/completions",
      mode: "chat_nonstream",
      statusCode: 404,
      reason: "model_not_found",
      errorCode: "model_not_found",
      requestedModel,
    });
    applyCors(req, res);
    return respondWithJson(res, 404, modelNotFoundBody(requestedModel));
  }

  let reasoningEffort = (
    body.reasoning?.effort ||
    body.reasoning_effort ||
    body.reasoningEffort ||
    ""
  )
    .toString()
    .toLowerCase();
  const allowEffort = new Set(["low", "medium", "high", "xhigh"]);
  if (!reasoningEffort) {
    const implied = impliedEffortForModel(requestedModel);
    if (implied) reasoningEffort = implied;
  }

  const args = buildBackendArgs({
    backendMode,
    SANDBOX_MODE,
    effectiveModel,
    FORCE_PROVIDER,
    reasoningEffort,
    allowEffort,
    enableParallelTools: ENABLE_PARALLEL_TOOL_CALLS,
  });

  const prompt = joinMessages(messages);
  const promptTokensEst = estTokensForMessages(messages);
  const MAX_TOKENS = CFG.PROXY_MAX_PROMPT_TOKENS;
  if (MAX_TOKENS > 0 && promptTokensEst > MAX_TOKENS) {
    logUsageFailure({
      req,
      res,
      reqId,
      started,
      route: "/v1/chat/completions",
      mode: "chat_nonstream",
      statusCode: 403,
      reason: "tokens_exceeded",
      requestedModel,
      effectiveModel,
      errorCode: "prompt_too_large",
    });
    applyCors(req, res);
    return respondWithJson(res, 403, tokensExceededBody("messages"));
  }

  if (IS_DEV_ENV) {
    const endpointMode = res.locals?.endpoint_mode || "chat";
    const prefix = `[dev][prompt][chat][req_id=${reqId}][endpoint=${endpointMode}]`;
    try {
      console.log(`${prefix} messages=`, JSON.stringify(messages));
      console.log(`${prefix} joined=\n` + prompt);
      appendProtoEvent({
        ts: Date.now(),
        req_id: reqId,
        route: "/v1/chat/completions",
        mode: "chat",
        kind: "submission",
        payload: { messages, joined: prompt },
      });
    } catch (e) {
      console.error(`${prefix} error:`, e);
    }
  }

  console.log(`[proxy] spawning backend=${backendMode}:`, resolvedCodexBin, args.join(" "));

  let normalizedRequest = null;
  try {
    normalizedRequest = normalizeChatJsonRpcRequest({
      body,
      messages,
      prompt,
      effectiveModel,
      choiceCount,
      stream: false,
      reasoningEffort,
      sandboxMode: SANDBOX_MODE,
      codexWorkdir: CODEX_WORKDIR,
      approvalMode: APPROVAL_POLICY,
    });
  } catch (err) {
    if (err instanceof ChatJsonRpcNormalizationError) {
      logUsageFailure({
        req,
        res,
        reqId,
        started,
        route: "/v1/chat/completions",
        mode: "chat_nonstream",
        statusCode: err.statusCode || 400,
        reason: "normalization_error",
        errorCode: err.body?.error?.code || err.code,
        requestedModel,
        effectiveModel,
      });
      applyCors(req, res);
      return respondWithJson(res, err.statusCode, err.body);
    }
    applyCors(req, res);
    throw err;
  }

  const nonStreamTrace = { reqId, route: "/v1/chat/completions", mode: "chat_nonstream" };
  const child = createJsonRpcChildAdapter({
    reqId,
    timeoutMs: REQ_TIMEOUT_MS,
    normalizedRequest,
    trace: nonStreamTrace,
  });
  if (SANITIZE_METADATA) {
    appendProtoEvent({
      ts: Date.now(),
      req_id: reqId,
      route: "/v1/chat/completions",
      mode: "chat_nonstream",
      kind: "metadata_sanitizer_state",
      toggle_enabled: true,
    });
  }
  let out = "",
    err = "";

  const timeout = setTimeout(() => {
    if (responded) return;
    responded = true;
    try {
      child.kill("SIGKILL");
    } catch {}
    applyCors(req, res);
    logUsageFailure({
      req,
      res,
      reqId,
      started,
      route: "/v1/chat/completions",
      mode: "chat_nonstream",
      statusCode: 504,
      reason: "backend_idle_timeout",
      errorCode: "idle_timeout",
      requestedModel,
      effectiveModel,
    });
    respondWithJson(res, 504, {
      error: { message: "backend idle timeout", type: "timeout_error", code: "idle_timeout" },
    });
  }, REQ_TIMEOUT_MS);

  // Dev-only safeguard: early terminate child; finalizeResponse will run on 'close'
  const maybeEarlyTruncate = () => {
    if (!NONSTREAM_TRUNCATE_MS) return { stop() {} };
    const t = setTimeout(() => {
      if (responded) return;
      try {
        child.kill("SIGTERM");
      } catch {}
    }, NONSTREAM_TRUNCATE_MS);
    return {
      stop() {
        try {
          clearTimeout(t);
        } catch {}
      },
    };
  };
  const early = maybeEarlyTruncate();

  res.setHeader("x-codex-stop-after-tools-mode", CFG.PROXY_STOP_AFTER_TOOLS_MODE || "burst");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  let buf2 = "";
  let prompt_tokens = 0;
  let completion_tokens = 0;
  let idleReset = () => {};
  let idleCancel = () => {};
  let sawTaskComplete = false;
  let totalToolCallCount = 0;
  let hasTruncatedToolCalls = false;
  let summaryEmitted = false;
  const computeFinal = () =>
    getPrimaryContent() ||
    stripAnsi(out).trim() ||
    stripAnsi(err).trim() ||
    "No output from backend.";

  const logToolBlocks = () => {
    try {
      const final = computeFinal();
      const { blocks } = extractUseToolBlocks(final, 0);
      let idxTool = 0;
      for (const b of blocks || []) {
        appendProtoEvent({
          ts: Date.now(),
          req_id: reqId,
          route: "/v1/chat/completions",
          mode: "chat_nonstream",
          kind: "tool_block",
          idx: ++idxTool,
          char_start: b.start,
          char_end: b.end,
          tool: b.name,
          path: b.path,
          query: b.query,
        });
      }
    } catch {}
  };

  const finalizeResponse = ({ statusCode = 200, finishReason, errorBody } = {}) => {
    if (responded) return;
    responded = true;
    clearTimeout(timeout);
    idleCancel();
    early?.stop?.();

    const final = computeFinal();
    const toolCallsSnapshot = toolCallAggregator.snapshot();
    const toolCallsPayload = toolCallsSnapshot.length ? toolCallsSnapshot : null;
    if (toolCallsPayload) hasToolCalls = true;
    const functionCallPayload = hasFunctionCall ? assistantFunctionCall : null;
    if (toolCallAggregator.hasCalls()) hasToolCalls = true;

    if (finishReason) finishReasonTracker.record(finishReason, "finalize");

    const resolveWithContext = () =>
      finishReasonTracker.resolve({
        hasToolCalls,
        hasFunctionCall,
      });

    let resolvedFinish = resolveWithContext();
    if (!sawTaskComplete && resolvedFinish.reason === "stop") {
      finishReasonTracker.record("stop", "fallback_truncation");
      resolvedFinish = resolveWithContext();
    }

    const canonicalReason = resolvedFinish.reason;
    const reasonSource = resolvedFinish.source;
    const unknownReasons = resolvedFinish.unknown || [];
    const reasonTrail = resolvedFinish.trail || [];

    const defaultContent = getPrimaryContent();
    const normalizedContent = defaultContent && defaultContent.length ? defaultContent : null;

    const buildAssistantMessageForChoice = (idx) => {
      const snapshot = toolCallAggregator.snapshot({ choiceIndex: idx });
      const state = getChoiceState(idx);
      const choiceContent = state.content && state.content.length ? state.content : final;
      const result = buildAssistantMessage({
        snapshot,
        choiceContent,
        normalizedContent,
        canonicalReason,
        isObsidianOutput,
        functionCallPayload,
      });
      if (Number.isFinite(result.toolCallCount)) {
        totalToolCallCount += result.toolCallCount;
      }
      if (result.toolCallsTruncated) {
        hasTruncatedToolCalls = true;
      }
      return result;
    };

    const pt =
      Number.isFinite(prompt_tokens) && prompt_tokens > 0 ? prompt_tokens : promptTokensEst;
    const contentForTokenEst = normalizedContent || "";
    const ct =
      Number.isFinite(completion_tokens) && completion_tokens > 0
        ? completion_tokens
        : contentForTokenEst
          ? estTokens(contentForTokenEst)
          : 0;

    if (statusCode === 200) {
      logToolBlocks();
      try {
        if (toolCallAggregator.hasCalls()) {
          const snapshots = [];
          for (let idx = 0; idx < choiceCount; idx += 1) {
            const snapshot = toolCallAggregator.snapshot({ choiceIndex: idx });
            if (snapshot.length) snapshots.push({ choice_index: idx, tool_calls: snapshot });
          }
          appendProtoEvent({
            ts: Date.now(),
            req_id: reqId,
            route: "/v1/chat/completions",
            mode: "chat_nonstream",
            kind: "tool_call_summary",
            tool_calls: snapshots.flatMap((entry) =>
              entry.tool_calls.map((record) => ({ ...record, choice_index: entry.choice_index }))
            ),
            tool_calls_by_choice: snapshots,
            parallel_supported: toolCallAggregator.supportsParallelCalls(),
            tool_call_count_total: totalToolCallCount,
            tool_call_truncated_total: hasTruncatedToolCalls ? 1 : 0,
            stop_after_tools_mode: CFG.PROXY_STOP_AFTER_TOOLS_MODE || "burst",
            stop_after_tools_enabled: Boolean(CFG.PROXY_STOP_AFTER_TOOLS),
            tool_block_max: Number(CFG.PROXY_TOOL_BLOCK_MAX || 0),
            suppress_tail_after_tools: Boolean(CFG.PROXY_SUPPRESS_TAIL_AFTER_TOOLS),
          });
        }
      } catch {}
      const {
        count: sanitizedMetadataCount,
        keys: sanitizedMetadataKeys,
        sources: sanitizedMetadataSources,
      } = getSanitizerSummaryData();
      if (SANITIZE_METADATA) {
        logSanitizerSummary({
          enabled: true,
          route: "/v1/chat/completions",
          mode: "chat_nonstream",
          reqId,
          count: sanitizedMetadataCount,
          keys: sanitizedMetadataKeys,
          sources: sanitizedMetadataSources,
        });
      }
      const httpCtx = getHttpContext(res);
      appendUsage({
        req_id: reqId,
        route: httpCtx.route || "/v1/chat/completions",
        mode: httpCtx.mode || "chat_nonstream",
        method: req.method || "POST",
        status_code: statusCode,
        requested_model: requestedModel,
        effective_model: effectiveModel,
        stream: false,
        prompt_tokens_est: pt,
        completion_tokens_est: ct * choiceCount,
        total_tokens_est: pt + ct * choiceCount,
        duration_ms: Date.now() - started,
        status: statusCode,
        user_agent: req.headers["user-agent"] || "",
        finish_reason: canonicalReason,
        finish_reason_source: reasonSource,
        has_tool_calls: !!toolCallsPayload,
        has_function_call: !!functionCallPayload,
        tool_call_parallel_supported: toolCallAggregator.supportsParallelCalls(),
        tool_call_emitted: toolCallAggregator.hasCalls(),
        tool_call_count_total: totalToolCallCount,
        tool_call_truncated_total: hasTruncatedToolCalls ? 1 : 0,
        stop_after_tools_mode: CFG.PROXY_STOP_AFTER_TOOLS_MODE || "burst",
        choice_count: choiceCount,
        metadata_sanitizer_enabled: SANITIZE_METADATA,
        sanitized_metadata_count: SANITIZE_METADATA ? sanitizedMetadataCount : 0,
        sanitized_metadata_keys: SANITIZE_METADATA ? sanitizedMetadataKeys : [],
        sanitized_metadata_sources: SANITIZE_METADATA ? sanitizedMetadataSources : [],
        output_mode: outputMode,
      });
      logFinishReasonTelemetry({
        route: "/v1/chat/completions",
        reqId,
        reason: canonicalReason,
        source: reasonSource,
        hasToolCalls: !!toolCallsPayload,
        hasFunctionCall: !!functionCallPayload,
        unknownReasons: unknownReasons.length ? unknownReasons : Array.from(unknownFinishReasons),
        trail: reasonTrail,
        choiceCount,
      });
      if (SANITIZE_METADATA) {
        appendProtoEvent({
          ts: Date.now(),
          req_id: reqId,
          route: "/v1/chat/completions",
          mode: "chat_nonstream",
          kind: "metadata_sanitizer_summary",
          sanitized_count: sanitizedMetadataCount,
          sanitized_keys: sanitizedMetadataKeys,
          sanitized_sources: sanitizedMetadataSources,
        });
      }
    }

    if (IS_DEV_ENV && statusCode === 200) {
      try {
        console.log("[dev][response][chat][nonstream] content=\n" + final);
      } catch (e) {
        console.error("[dev][response][chat][nonstream] error:", e);
      }
    }

    applyCors(req, res);

    if (statusCode !== 200 && errorBody) {
      if (!summaryEmitted) {
        summaryEmitted = true;
        try {
          logStructured(
            {
              component: "chat",
              event: "chat_transform_summary",
              level: "info",
              req_id: reqId,
              trace_id: res.locals?.trace_id,
              route: "/v1/chat/completions",
              mode: "chat_nonstream",
              model: requestedModel,
            },
            {
              endpoint_mode: res.locals?.endpoint_mode || "chat",
              copilot_trace_id: res.locals?.copilot_trace_id || null,
              output_mode_requested: res.locals?.output_mode_requested ?? null,
              output_mode_effective: res.locals?.output_mode_effective ?? null,
              response_shape_version: "chat_v1_nonstream_openai",
              finish_reason: canonicalReason || null,
              status: statusCode,
              tool_calls_detected: 0,
              tool_calls_emitted: 0,
              tool_names: [],
              tool_names_truncated: false,
              output_text_bytes: 0,
              output_text_hash: null,
              xml_in_text: false,
              tool_use_items: 0,
            }
          );
        } catch {}
      }
      const emissionTrigger = resolveEmissionTrigger(reasonTrail);
      logUsageFailure({
        req,
        res,
        reqId,
        started,
        route: "/v1/chat/completions",
        mode: "chat_nonstream",
        statusCode,
        reason: emissionTrigger,
        errorCode: errorBody?.error?.code,
        requestedModel,
        effectiveModel,
      });
      respondWithJson(res, statusCode, errorBody);
      return;
    }

    const aggregatedPromptTokens = pt;
    const aggregatedCompletionTokens = ct * choiceCount;
    const aggregatedUsage = {
      prompt_tokens: aggregatedPromptTokens,
      completion_tokens: aggregatedCompletionTokens,
      total_tokens: aggregatedPromptTokens + aggregatedCompletionTokens,
    };

    const choices = Array.from({ length: choiceCount }, (_, idx) => {
      const { message, hasToolCalls: choiceHasTools } = buildAssistantMessageForChoice(idx);
      return {
        index: idx,
        message,
        finish_reason: determineChoiceFinishReason(idx, canonicalReason, choiceHasTools),
      };
    });

    res.setHeader("x-codex-tool-call-count", String(totalToolCallCount));
    res.setHeader("x-codex-tool-call-truncated", String(hasTruncatedToolCalls));

    const payload = {
      id: `chatcmpl-${nanoid()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices,
      usage: aggregatedUsage,
    };

    if (!summaryEmitted) {
      summaryEmitted = true;
      try {
        const contentParts = [];
        const toolCalls = [];
        for (const choice of choices) {
          const message = choice?.message || {};
          if (typeof message.content === "string") {
            contentParts.push(message.content);
          } else if (Array.isArray(message.content)) {
            message.content.forEach((item) => {
              if (item && typeof item.text === "string") {
                contentParts.push(item.text);
              } else if (typeof item === "string") {
                contentParts.push(item);
              }
            });
          }
          if (Array.isArray(message.tool_calls)) {
            toolCalls.push(...message.tool_calls);
          }
          if (message.function_call) {
            toolCalls.push({
              id: message.function_call?.id,
              type: "function",
              function: {
                name: message.function_call?.name,
                arguments: message.function_call?.arguments,
              },
            });
          }
        }
        const textSummary = summarizeTextParts(contentParts);
        const toolSummary = summarizeToolCalls(toolCalls);
        logStructured(
          {
            component: "chat",
            event: "chat_transform_summary",
            level: "info",
            req_id: reqId,
            trace_id: res.locals?.trace_id,
            route: "/v1/chat/completions",
            mode: "chat_nonstream",
            model: requestedModel,
          },
          {
            endpoint_mode: res.locals?.endpoint_mode || "chat",
            copilot_trace_id: res.locals?.copilot_trace_id || null,
            output_mode_requested: res.locals?.output_mode_requested ?? null,
            output_mode_effective: res.locals?.output_mode_effective ?? null,
            response_shape_version: "chat_v1_nonstream_openai",
            finish_reason: canonicalReason || null,
            status: statusCode,
            tool_calls_detected: toolSummary.tool_call_count,
            tool_calls_emitted: toolSummary.tool_call_count,
            tool_names: toolSummary.tool_names,
            tool_names_truncated: toolSummary.tool_names_truncated,
            output_text_bytes: textSummary.output_text_bytes,
            output_text_hash: textSummary.output_text_hash,
            xml_in_text: textSummary.xml_in_text,
            tool_use_items: 0,
          }
        );
      } catch {}
    }

    captureChatNonStream({
      req,
      res,
      requestBody: originalBody,
      responseBody: payload,
      outputModeEffective: outputMode,
    });

    respondWithJson(res, statusCode, payload);
  };

  ({ reset: idleReset, cancel: idleCancel } = (() => {
    let timer;
    return {
      reset() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (responded) return;
          finalizeResponse({
            statusCode: 504,
            errorBody: {
              error: {
                message: "backend idle timeout",
                type: "timeout_error",
                code: "idle_timeout",
              },
            },
          });
          try {
            child.kill("SIGTERM");
          } catch {}
        }, idleTimeoutMs);
      },
      cancel() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  })());

  idleReset();

  child.stdout.on("data", (d) => {
    idleReset();
    const s = typeof d === "string" ? d : d.toString("utf8");
    out += s;
    buf2 += s;
    if (LOG_PROTO)
      appendProtoEvent({
        ts: Date.now(),
        req_id: reqId,
        route: "/v1/chat/completions",
        mode: "chat_nonstream",
        kind: "stdout",
        chunk: s,
      });
    let idx;
    while ((idx = buf2.indexOf("\n")) >= 0) {
      const line = buf2.slice(0, idx);
      buf2 = buf2.slice(idx + 1);
      const t = line.trim();
      if (!t) continue;
      try {
        const evt = JSON.parse(t);
        const tp = (evt && (evt.msg?.type || evt.type)) || "";
        appendProtoEvent({
          ts: Date.now(),
          req_id: reqId,
          route: "/v1/chat/completions",
          mode: "chat_nonstream",
          kind: "event",
          event: evt,
        });
        const payload = evt.msg || evt;
        if (payload) {
          const finishCandidate = extractFinishReasonFromMessage(payload);
          if (finishCandidate) finishReasonTracker.record(finishCandidate, tp || "event");
          trackToolSignals(payload);
        }
        const metadataInfo = SANITIZE_METADATA ? extractMetadataFromPayload(payload) : null;
        if (tp === "dynamic_tool_call_request") {
          const toolCallDelta = buildToolCallDeltaFromDynamicRequest(payload);
          if (toolCallDelta) {
            trackToolSignals(toolCallDelta);
            const choiceIndex = resolveChoiceIndexFromPayload(toolCallDelta, evt.msg, evt) ?? 0;
            const { updated } = toolCallAggregator.ingestDelta(toolCallDelta, {
              choiceIndex,
            });
            if (updated) hasToolCalls = true;
          }
        } else if (tp === "agent_message_delta" || tp === "agent_message") {
          const isDelta = tp === "agent_message_delta";
          const payloadData = isDelta
            ? (evt.msg?.delta ?? evt.delta)
            : (evt.msg?.message ?? evt.message);
          const choiceIndex = resolveChoiceIndexFromPayload(payloadData, evt.msg, evt) ?? 0;
          const choiceState = getChoiceState(choiceIndex);

          let textSegment = "";
          let hasTextSegment = false;

          if (typeof payloadData === "string") {
            textSegment = payloadData;
            hasTextSegment = Boolean(textSegment);
            toolCallAggregator.ingestMessage(
              { message: { content: payloadData } },
              { choiceIndex, emitIfMissing: true }
            );
            if (toolCallAggregator.hasCalls({ choiceIndex })) hasToolCalls = true;
          } else if (payloadData && typeof payloadData === "object") {
            if (isDelta) {
              const { updated } = toolCallAggregator.ingestDelta(payloadData, {
                choiceIndex,
              });
              if (updated) hasToolCalls = true;
            } else {
              toolCallAggregator.ingestMessage(payloadData, {
                choiceIndex,
                emitIfMissing: true,
              });
              if (toolCallAggregator.hasCalls({ choiceIndex })) hasToolCalls = true;
            }
            textSegment = coerceAssistantContent(payloadData.content ?? payloadData.text ?? "");
            hasTextSegment = Boolean(textSegment);
          }

          const sanitizedSegment = SANITIZE_METADATA
            ? applyMetadataSanitizer(textSegment, metadataInfo, {
                stage: tp,
                eventType: tp,
              })
            : textSegment;

          if (isDelta) {
            choiceState.content += sanitizedSegment || "";
          } else if (hasTextSegment) {
            choiceState.content = sanitizedSegment;
          }
        } else if (tp === "metadata") {
          if (SANITIZE_METADATA && metadataInfo) {
            recordSanitizedMetadata({
              stage: "metadata_event",
              eventType: tp,
              metadata: metadataInfo.metadata,
              removed: [],
              sources: metadataInfo.sources,
            });
          }
        } else if (tp === "token_count") {
          prompt_tokens = Number(evt.msg?.prompt_tokens ?? evt.msg?.promptTokens ?? prompt_tokens);
          completion_tokens = Number(
            evt.msg?.completion_tokens ?? evt.msg?.completionTokens ?? completion_tokens
          );
        } else if (tp === "task_complete") {
          sawTaskComplete = true;
          finishReasonTracker.record(
            extractFinishReasonFromMessage(evt.msg || evt),
            "task_complete"
          );
        }
      } catch {}
    }
  });
  child.stderr.on("data", (d) => {
    idleReset();
    err += d.toString("utf8");
    if (LOG_PROTO)
      appendProtoEvent({
        ts: Date.now(),
        req_id: reqId,
        route: "/v1/chat/completions",
        mode: "chat_nonstream",
        kind: "stderr",
        chunk: d.toString("utf8"),
      });
  });

  const finalizeSuccess = () => finalizeResponse();
  const finalizeFailure = (
    error,
    fallbackMessage = "Internal server error from backend process."
  ) => {
    const mapped = mapTransportError(error);
    if (mapped) {
      return finalizeResponse({
        statusCode: mapped.statusCode,
        errorBody: mapped.body,
      });
    }
    const message =
      typeof error === "string"
        ? error
        : error?.message || fallbackMessage || "Internal server error";
    return finalizeResponse({
      statusCode: 500,
      errorBody: {
        error: {
          message,
          type: "server_error",
          code: "backend_error",
        },
      },
    });
  };

  // Stabilize: respond when stdout ends or the process exits, whichever happens first
  child.stdout.on("end", finalizeSuccess);
  child.on("exit", finalizeSuccess);
  child.on("error", (error) => {
    console.error("[proxy][chat.nonstream] child process error", error);
    finalizeFailure(error);
  });
  child.stdout.on("error", (error) => {
    console.error("[proxy][chat.nonstream] stdout error", error);
    finalizeFailure(error, "Internal server error from backend stdout.");
  });
  try {
    const submission = {
      id: reqId,
      op: { type: "user_input", items: [{ type: "text", text: prompt }] },
    };
    child.stdin.write(JSON.stringify(submission) + "\n");
  } catch {}
  req.on("close", () => {
    if (KILL_ON_DISCONNECT) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  });
}
