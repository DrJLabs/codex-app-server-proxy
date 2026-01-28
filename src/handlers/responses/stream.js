import { config as CFG } from "../../config/index.js";
import {
  applyDefaultProxyOutputModeHeader,
  resolveResponsesOutputMode,
  splitResponsesTools,
} from "./shared.js";
import {
  logResponsesIngressRaw,
  summarizeResponsesIngress,
  summarizeTools,
} from "./ingress-logging.js";
import { applyProxyTraceHeaders, ensureReqId, setHttpContext } from "../../lib/request-context.js";
import { detectCopilotRequest as detectCopilotRequestV2 } from "../../lib/copilot-detect.js";
import { invalidRequestBody, modelNotFoundBody } from "../../lib/errors.js";
import { normalizeResponsesRequest, ResponsesJsonRpcNormalizationError } from "./native/request.js";
import { ensureResponsesCapabilities } from "./native/capabilities.js";
import { runNativeResponses } from "./native/execute.js";
import { createJsonRpcChildAdapter } from "../../services/transport/child-adapter.js";
import { mapTransportError } from "../../services/transport/index.js";
import { createResponsesStreamAdapter } from "./stream-adapter.js";
import { createStreamMetadataSanitizer } from "../chat/stream-metadata-sanitizer.js";
import { applyGuardHeaders, setupStreamGuard } from "../../services/concurrency-guard.js";
import { logStructured } from "../../services/logging/schema.js";
import {
  extractMetadataFromPayload,
  metadataKeys,
  normalizeMetadataKey,
  sanitizeMetadataTextSegment,
} from "../../lib/metadata-sanitizer.js";
import {
  appendProtoEvent,
  appendUsage,
  logSanitizerSummary,
  logSanitizerToggle,
} from "../../dev-logging.js";
import { applyCors as applyCorsUtil, normalizeModel } from "../../utils.js";
import { acceptedModelIds } from "../../config/models.js";
import { setSSEHeaders, computeKeepaliveMs, startKeepalives } from "../../services/sse.js";

const DEFAULT_MODEL = CFG.CODEX_MODEL;
const ACCEPTED_MODEL_IDS = acceptedModelIds(DEFAULT_MODEL);
const MAX_RESP_CHOICES = Math.max(1, Number(CFG.PROXY_MAX_CHAT_CHOICES || 1));
const REQ_TIMEOUT_MS = CFG.PROXY_TIMEOUT_MS;
const STREAM_IDLE_TIMEOUT_MS = CFG.PROXY_STREAM_IDLE_TIMEOUT_MS;
const SANDBOX_MODE = CFG.PROXY_SANDBOX_MODE;
const APPROVAL_POLICY = CFG.PROXY_APPROVAL_POLICY;
const CORS_ENABLED = CFG.PROXY_ENABLE_CORS.toLowerCase() !== "false";
const CORS_ALLOWED = CFG.PROXY_CORS_ALLOWED_ORIGINS;
const MAX_CONCURRENCY = Number(CFG.PROXY_SSE_MAX_CONCURRENCY || 0) || 0;
const TEST_ENDPOINTS_ENABLED = String(CFG.PROXY_TEST_ENDPOINTS || "false").toLowerCase() === "true";
const KILL_ON_DISCONNECT = String(CFG.PROXY_KILL_ON_DISCONNECT || "false").toLowerCase() === "true";
const SANITIZE_METADATA = !!CFG.PROXY_SANITIZE_METADATA;

const buildInvalidChoiceError = (value) =>
  invalidRequestBody(
    "n",
    `n must be an integer between 1 and ${MAX_RESP_CHOICES}; received ${value}`
  );
const buildUnsupportedChoiceError = (value) =>
  invalidRequestBody("n", `n must be 1 for /v1/responses; received ${value}`, "n_unsupported");

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

const applyCors = (req, res) => applyCorsUtil(req, res, CORS_ENABLED, CORS_ALLOWED);

const buildToolsPayload = ({ definitions, toolChoice, parallelToolCalls }) => {
  const payload = {};
  if (definitions) payload.definitions = definitions;
  if (toolChoice !== undefined) payload.choice = toolChoice;
  if (parallelToolCalls !== undefined) payload.parallelToolCalls = parallelToolCalls;
  return Object.keys(payload).length ? payload : undefined;
};

const countToolDefinitions = (payload) => {
  if (!payload || typeof payload !== "object") return 0;
  const defs =
    payload.definitions ||
    payload.tools ||
    payload.tool_definitions ||
    payload.toolDefinitions ||
    payload.functions;
  return Array.isArray(defs) ? defs.length : 0;
};

const buildPromptFromItems = (items) => {
  if (!Array.isArray(items)) return "";
  const textItems = items
    .filter((item) => item && item.type === "text" && typeof item.data?.text === "string")
    .map((item) => item.data.text);
  return textItems.join("\n");
};

export async function postResponsesStream(req, res) {
  const route = "/v1/responses";
  const mode = "responses_stream";
  setHttpContext(res, { route, mode });
  const reqId = ensureReqId(res);
  applyProxyTraceHeaders(res);
  const started = Date.now();
  const originalBody = req.body || {};

  res.locals = res.locals || {};
  const locals = res.locals;
  locals.endpoint_mode = "responses";
  locals.routeOverride = route;
  locals.modeOverride = mode;

  const ingressSummary = summarizeResponsesIngress(originalBody, req);
  const copilotDetection = detectCopilotRequestV2({
    headers: req?.headers,
    markers: ingressSummary,
    responsesSummary: ingressSummary,
  });
  locals.copilot_detected = copilotDetection.copilot_detected;
  locals.copilot_detect_tier = copilotDetection.copilot_detect_tier;
  locals.copilot_detect_reasons = copilotDetection.copilot_detect_reasons;

  const outputModeRequested = req.headers["x-proxy-output-mode"]
    ? String(req.headers["x-proxy-output-mode"])
    : null;
  const { effective: outputModeEffective } = resolveResponsesOutputMode({
    req,
    defaultValue: CFG.PROXY_RESPONSES_OUTPUT_MODE,
  });
  const restoreOutputMode = applyDefaultProxyOutputModeHeader(req, outputModeEffective);
  locals.output_mode_requested = outputModeRequested;
  locals.output_mode_effective = outputModeEffective;

  logResponsesIngressRaw({
    req,
    res,
    body: originalBody,
    outputModeRequested,
    outputModeEffective,
    ingressSummary,
    copilotDetection,
  });

  const { ok: nOk, value: nValue = 1, error: nError } = normalizeChoiceCount(originalBody?.n);
  if (!nOk || nValue < 1 || nValue > MAX_RESP_CHOICES) {
    const choiceError = nError || buildInvalidChoiceError(originalBody?.n);
    applyCors(req, res);
    res.status(400).json(choiceError);
    restoreOutputMode();
    return;
  }
  if (nValue > 1) {
    applyCors(req, res);
    res.status(400).json(buildUnsupportedChoiceError(originalBody?.n));
    restoreOutputMode();
    return;
  }

  const model = typeof originalBody.model === "string" ? originalBody.model.trim() : "";
  if (!model) {
    applyCors(req, res);
    res.status(400).json(invalidRequestBody("model", "model is required", "model_required"));
    restoreOutputMode();
    return;
  }
  const { requested: requestedModel, effective: effectiveModel } = normalizeModel(
    model,
    DEFAULT_MODEL,
    Array.from(ACCEPTED_MODEL_IDS)
  );
  if (!ACCEPTED_MODEL_IDS.has(requestedModel)) {
    applyCors(req, res);
    res.status(404).json(modelNotFoundBody(requestedModel));
    restoreOutputMode();
    return;
  }

  let normalized;
  try {
    normalized = normalizeResponsesRequest(originalBody);
  } catch (err) {
    if (err instanceof ResponsesJsonRpcNormalizationError) {
      applyCors(req, res);
      res.status(err.statusCode || 400).json(err.body);
      restoreOutputMode();
      return;
    }
    restoreOutputMode();
    throw err;
  }

  const normalizedToolsSummary = summarizeTools(normalized.tools, {
    maxTypes: 10,
    maxNames: 20,
  });
  logStructured(
    {
      component: "responses",
      event: "responses_ingress_normalized",
      level: "info",
      req_id: reqId,
      trace_id: res.locals?.trace_id,
      route,
      mode,
      method: req.method,
    },
    {
      model: effectiveModel,
      stream: true,
      has_tools: Array.isArray(normalized.tools) && normalized.tools.length > 0,
      tool_count: normalizedToolsSummary.tool_count,
      tool_types: normalizedToolsSummary.tool_types,
      tool_types_truncated: normalizedToolsSummary.tool_types_truncated,
      tool_names: normalizedToolsSummary.tool_names,
      tool_names_truncated: normalizedToolsSummary.tool_names_truncated,
    }
  );

  const { nativeTools, functionTools } = splitResponsesTools(normalized.tools);
  const toolDefinitions = nativeTools.concat(functionTools);
  const capabilityCheck = await ensureResponsesCapabilities({
    toolsRequested: nativeTools.length > 0 || functionTools.length > 0,
  });
  if (!capabilityCheck.ok) {
    applyCors(req, res);
    res.status(capabilityCheck.statusCode).json(capabilityCheck.body);
    restoreOutputMode();
    return;
  }

  const guardContext = setupStreamGuard({
    res,
    reqId,
    route,
    maxConc: MAX_CONCURRENCY,
    testEndpointsEnabled: TEST_ENDPOINTS_ENABLED,
    send429: () => {
      applyCors(req, res);
      res.status(429).json({
        error: {
          message: "too many concurrent streams",
          type: "rate_limit_error",
          code: "concurrency_exceeded",
        },
      });
    },
  });

  if (!guardContext.acquired) {
    restoreOutputMode();
    return;
  }

  const releaseGuard = (outcome) => guardContext.release(outcome);
  applyGuardHeaders(res, guardContext.token, TEST_ENDPOINTS_ENABLED);

  const fallbackMax = Number(CFG.PROXY_RESPONSES_DEFAULT_MAX_TOKENS || 0);
  const maxOutputTokens = normalized.maxOutputTokens ?? (fallbackMax > 0 ? fallbackMax : undefined);
  const toolsPayload = buildToolsPayload({
    definitions: toolDefinitions.length ? toolDefinitions : undefined,
    toolChoice: toolDefinitions.length ? normalized.toolChoice : undefined,
    parallelToolCalls: toolDefinitions.length ? normalized.parallelToolCalls : undefined,
  });
  const includeUsage = Boolean(originalBody?.stream_options?.include_usage);

  const turn = {
    model: effectiveModel,
    items: normalized.inputItems,
    cwd: CFG.PROXY_CODEX_WORKDIR,
    approvalPolicy: APPROVAL_POLICY,
    sandboxPolicy: SANDBOX_MODE ? { type: SANDBOX_MODE } : undefined,
    summary: "auto",
    includeApplyPatchTool: true,
  };
  if (Number.isInteger(nValue) && nValue > 0) turn.choiceCount = nValue;
  if (toolsPayload) turn.tools = toolsPayload;
  if (normalized.developerInstructions) {
    turn.developerInstructions = normalized.developerInstructions;
  }
  if (normalized.finalOutputJsonSchema !== undefined) {
    turn.finalOutputJsonSchema = normalized.finalOutputJsonSchema;
  }

  const message = {
    items: normalized.inputItems,
    includeUsage,
    stream: true,
  };
  if (maxOutputTokens !== undefined) message.maxOutputTokens = maxOutputTokens;
  if (toolsPayload) message.tools = toolsPayload;
  if (normalized.responseFormat !== undefined) message.responseFormat = normalized.responseFormat;
  if (normalized.finalOutputJsonSchema !== undefined) {
    message.finalOutputJsonSchema = normalized.finalOutputJsonSchema;
  }

  const ingressToolCount = toolDefinitions.length;
  const turnToolCount = countToolDefinitions(turn.tools);
  const messageToolCount = countToolDefinitions(message.tools);
  const toolsMismatch = ingressToolCount !== turnToolCount || ingressToolCount !== messageToolCount;
  logStructured(
    {
      component: "responses",
      event: "responses_tools_projection",
      level: toolsMismatch ? "warn" : "info",
      req_id: reqId,
      route,
      mode,
    },
    {
      ingress_tool_count: ingressToolCount,
      turn_tool_count: turnToolCount,
      message_tool_count: messageToolCount,
      mismatch: toolsMismatch,
    }
  );

  const normalizedRequest = { turn, message };
  const child = createJsonRpcChildAdapter({
    reqId,
    timeoutMs: REQ_TIMEOUT_MS,
    normalizedRequest,
    trace: { reqId, route, mode },
  });

  let responded = false;
  let usage = null;
  let idleTimer = null;
  let keepalive = null;

  const adapterBody = {
    ...originalBody,
    tools: normalized.tools ?? originalBody.tools,
    tool_choice: normalized.toolChoice ?? originalBody.tool_choice,
    toolChoice: normalized.toolChoice ?? originalBody.toolChoice,
  };
  const streamAdapter = createResponsesStreamAdapter(res, adapterBody, req);

  const cleanupStream = () => {
    if (keepalive) {
      try {
        if (typeof keepalive.stop === "function") keepalive.stop();
        else clearInterval(keepalive);
      } catch {}
      keepalive = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const handleConnectionClose = (outcome) => {
    if (responded || res.writableEnded) return;
    responded = true;
    cleanupStream();
    if (KILL_ON_DISCONNECT) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    releaseGuard(outcome || "client_abort");
    restoreOutputMode();
  };

  const respondStreamFailure = (error) => {
    if (responded) return;
    responded = true;
    cleanupStream();
    releaseGuard("error");
    streamAdapter.fail(error);
    restoreOutputMode();
  };

  const resetIdle = () => {
    if (!STREAM_IDLE_TIMEOUT_MS || STREAM_IDLE_TIMEOUT_MS <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      respondStreamFailure({ message: "backend idle timeout", code: "idle_timeout" });
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  res.status(200);
  applyCors(req, res);
  setSSEHeaders(res);
  const keepaliveMs = computeKeepaliveMs(req);
  keepalive = startKeepalives(res, keepaliveMs);
  res.on("close", () => handleConnectionClose("client_abort"));
  res.on("finish", () => handleConnectionClose("completed"));
  req.on?.("aborted", () => handleConnectionClose("client_abort"));

  const metadataSanitizer = createStreamMetadataSanitizer({
    sanitizeMetadata: SANITIZE_METADATA,
    reqId,
    route,
    mode,
    appendProtoEvent,
    logSanitizerToggle,
    metadataKeys,
    normalizeMetadataKey,
    sanitizeMetadataTextSegment,
    appendContentSegment: (segment, { choiceIndex } = {}) => {
      streamAdapter.handleEvent({
        type: "text_delta",
        delta: segment,
        choiceIndex: Number.isInteger(choiceIndex) ? choiceIndex : 0,
      });
    },
    scheduleStopAfterTools: () => {},
  });

  const {
    enqueueSanitizedSegment,
    flushSanitizedSegments,
    getSummaryData: getSanitizerSummaryData,
  } = metadataSanitizer;

  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    resetIdle();
    const choiceIndex = Number.isInteger(event.choiceIndex) ? event.choiceIndex : 0;
    if (event.type === "text_delta") {
      const delta = event.delta;
      if (SANITIZE_METADATA) {
        enqueueSanitizedSegment(
          delta,
          event.metadataInfo,
          { stage: "agent_message_delta", eventType: "agent_message_delta" },
          { choiceIndex }
        );
      } else {
        streamAdapter.handleEvent(event);
      }
      return;
    }
    if (event.type === "text") {
      const text = event.text;
      if (SANITIZE_METADATA) {
        enqueueSanitizedSegment(
          text,
          event.metadataInfo,
          { stage: "agent_message", eventType: "agent_message" },
          { choiceIndex }
        );
      } else {
        streamAdapter.handleEvent(event);
      }
      return;
    }
    if (event.type === "usage") {
      if (event.usage && typeof event.usage === "object") {
        usage = event.usage;
      }
      if (!includeUsage) return;
    }
    if (event.type === "finish" && SANITIZE_METADATA) {
      flushSanitizedSegments({ stage: "finish", eventType: "finish" });
    }
    streamAdapter.handleEvent(event);
  };

  const requestTimeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
    respondStreamFailure({ message: "backend timeout", code: "timeout" });
  }, REQ_TIMEOUT_MS);

  resetIdle();

  try {
    const prompt = buildPromptFromItems(normalized.inputItems);
    child.stdin.write(JSON.stringify({ prompt }) + "\n");
  } catch (error) {
    logStructured(
      {
        component: "responses",
        event: "responses_stream_submit_failed",
        level: "warn",
        req_id: reqId,
        route: "/v1/responses",
        mode: "responses_stream",
      },
      {
        message: error?.message,
      }
    );
  }

  try {
    await Promise.race([
      runNativeResponses({
        adapter: child,
        onEvent: handleEvent,
        sanitizeMetadata: SANITIZE_METADATA,
        extractMetadataFromPayload,
      }),
      new Promise((_resolve, reject) => child.once("error", reject)),
    ]);
  } catch (error) {
    clearTimeout(requestTimeout);
    cleanupStream();
    const mapped = mapTransportError(error);
    if (mapped?.body?.error) {
      respondStreamFailure(mapped.body.error);
    } else {
      respondStreamFailure(error);
    }
    return;
  }

  clearTimeout(requestTimeout);
  cleanupStream();
  if (responded || res.writableEnded) {
    releaseGuard("completed");
    restoreOutputMode();
    return;
  }

  if (SANITIZE_METADATA) {
    flushSanitizedSegments({ stage: "finalize", eventType: "finalize" });
  }

  await streamAdapter.finalize();
  responded = true;
  releaseGuard("completed");

  const sanitizerSummary = getSanitizerSummaryData();
  if (SANITIZE_METADATA) {
    logSanitizerSummary({
      enabled: true,
      route,
      mode,
      reqId,
      count: sanitizerSummary.count,
      keys: sanitizerSummary.keys,
      sources: sanitizerSummary.sources,
    });
  }

  const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? null;
  const totalTokens =
    usage?.total_tokens ??
    (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null);

  appendUsage({
    req_id: reqId,
    route,
    mode,
    method: req.method || "POST",
    status_code: res.statusCode || 200,
    requested_model: requestedModel,
    effective_model: effectiveModel,
    stream: true,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    duration_ms: Date.now() - started,
    status: res.statusCode || 200,
    user_agent: req.headers["user-agent"] || "",
    metadata_sanitizer_enabled: SANITIZE_METADATA,
    sanitized_metadata_count: SANITIZE_METADATA ? sanitizerSummary.count : 0,
    sanitized_metadata_keys: SANITIZE_METADATA ? sanitizerSummary.keys : [],
    sanitized_metadata_sources: SANITIZE_METADATA ? sanitizerSummary.sources : [],
  });

  restoreOutputMode();
}
