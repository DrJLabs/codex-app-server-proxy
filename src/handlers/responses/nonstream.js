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
import { captureResponsesNonStream } from "./capture.js";
import { logStructured, sha256 } from "../../services/logging/schema.js";
import {
  appendProtoEvent,
  appendUsage,
  logSanitizerSummary,
  logSanitizerToggle,
} from "../../dev-logging.js";
import {
  summarizeTextParts,
  summarizeToolCalls,
  summarizeToolUseItems,
} from "../../lib/observability/transform-summary.js";
import { invalidRequestBody, modelNotFoundBody } from "../../lib/errors.js";
import { applyProxyTraceHeaders, ensureReqId } from "../../lib/request-context.js";
import { detectCopilotRequest as detectCopilotRequestV2 } from "../../lib/copilot-detect.js";
import { normalizeResponsesRequest, ResponsesJsonRpcNormalizationError } from "./native/request.js";
import { ensureResponsesCapabilities } from "./native/capabilities.js";
import { buildResponsesEnvelope } from "./native/envelope.js";
import { runNativeResponses } from "./native/execute.js";
import { createJsonRpcChildAdapter } from "../../services/transport/child-adapter.js";
import { mapTransportError } from "../../services/transport/index.js";
import { createToolCallAggregator } from "../../lib/tool-call-aggregator.js";
import { parseToolCallText } from "./tool-call-parser.js";
import {
  extractMetadataFromPayload,
  normalizeMetadataKey,
  sanitizeMetadataTextSegment,
} from "../../lib/metadata-sanitizer.js";
import { normalizeModel, applyCors as applyCorsUtil } from "../../utils.js";
import { acceptedModelIds } from "../../config/models.js";
import {
  buildDynamicTools,
  buildToolCallDeltaFromDynamicRequest,
} from "../../lib/tools/dynamic-tools.js";
import { RESPONSES_INTERNAL_TOOLS_INSTRUCTION } from "../../lib/prompts/internal-tools-instructions.js";

const DEFAULT_MODEL = CFG.CODEX_MODEL;
const ACCEPTED_MODEL_IDS = acceptedModelIds(DEFAULT_MODEL);
const MAX_RESP_CHOICES = Math.max(1, Number(CFG.PROXY_MAX_CHAT_CHOICES || 1));
const REQ_TIMEOUT_MS = CFG.PROXY_TIMEOUT_MS;
const IDLE_TIMEOUT_MS = CFG.PROXY_IDLE_TIMEOUT_MS;
const SANDBOX_MODE = CFG.PROXY_SANDBOX_MODE;
const APPROVAL_POLICY = CFG.PROXY_APPROVAL_POLICY;
const CORS_ENABLED = CFG.PROXY_ENABLE_CORS.toLowerCase() !== "false";
const CORS_ALLOWED = CFG.PROXY_CORS_ALLOWED_ORIGINS;
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

const countDynamicTools = (dynamicTools) => (Array.isArray(dynamicTools) ? dynamicTools.length : 0);

const respondToToolOutputs = (child, toolOutputs, { reqId, route, mode } = {}) => {
  if (!child || !Array.isArray(toolOutputs) || toolOutputs.length === 0) return [];
  const transport = child.transport;
  if (!transport || typeof transport.respondToToolCall !== "function") return toolOutputs;
  const unmatched = [];
  toolOutputs.forEach((toolOutput) => {
    const callId = toolOutput?.callId;
    if (!callId) return;
    const outputText = toolOutput?.output ?? "";
    const outputBytes = Buffer.byteLength(String(outputText), "utf8");
    logStructured(
      {
        component: "responses",
        event: "tool_call_output",
        level: "debug",
        req_id: reqId,
        route,
        mode,
      },
      {
        tool_call_id: callId,
        tool_name: toolOutput?.toolName ?? null,
        tool_output_bytes: outputBytes,
        tool_output_hash: sha256(outputText),
      }
    );
    const ok = transport.respondToToolCall(callId, {
      output: toolOutput.output,
      success: toolOutput.success,
    });
    if (!ok) {
      logStructured(
        {
          component: "responses",
          event: "responses_tool_output_unmatched",
          level: "warn",
          req_id: reqId,
          route,
          mode,
        },
        { call_id: callId }
      );
      unmatched.push(toolOutput);
    }
  });
  return unmatched;
};

const formatShimToolOutputLine = (toolOutput) => {
  const callId = toolOutput?.callId ?? "";
  const outputText =
    typeof toolOutput?.output === "string"
      ? toolOutput.output
      : (() => {
          try {
            return JSON.stringify(toolOutput?.output ?? "");
          } catch {
            return String(toolOutput?.output ?? "");
          }
        })();
  return `[function_call_output call_id=${callId} output=${outputText}]`;
};

const appendShimToolOutputs = (transport, toolOutputs, turn, message, logMeta) => {
  if (!transport || typeof transport.consumeShimToolCall !== "function") return;
  toolOutputs.forEach((toolOutput) => {
    const shimEntry = transport.consumeShimToolCall(toolOutput?.callId);
    if (!shimEntry) return;
    const line = formatShimToolOutputLine(toolOutput);
    const item = { type: "text", data: { text: line } };
    turn.items.push(item);
    message.items.push(item);
    logStructured(
      {
        component: "responses",
        event: "responses_tool_output_shimmed",
        level: "info",
        req_id: logMeta?.reqId,
        route: logMeta?.route,
        mode: logMeta?.mode,
      },
      { call_id: toolOutput?.callId, tool_name: shimEntry.toolName ?? null }
    );
  });
};

const mapFinishStatus = (reason) => {
  const normalized = String(reason || "").toLowerCase();
  if (normalized === "length" || normalized === "content_filter") return "incomplete";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "failed";
  return "completed";
};

const normalizeToolChoiceMode = (toolChoice) => {
  if (typeof toolChoice !== "string") return null;
  return toolChoice.trim().toLowerCase();
};

const resolveForcedToolName = (toolChoice) => {
  if (!toolChoice || typeof toolChoice !== "object") return "";
  if (typeof toolChoice.name === "string" && toolChoice.name.trim()) {
    return toolChoice.name.trim();
  }
  if (typeof toolChoice.function?.name === "string" && toolChoice.function.name.trim()) {
    return toolChoice.function.name.trim();
  }
  return "";
};

const buildToolParseOptions = (tools, toolChoice) => {
  let allowedTools = new Set();
  const strictTools = new Map();
  const toolSchemas = new Map();

  if (Array.isArray(tools)) {
    tools.forEach((tool) => {
      if (!tool || typeof tool !== "object") return;
      const fn = tool.function || tool.fn;
      const name =
        (typeof fn?.name === "string" && fn.name.trim()) ||
        (typeof tool.name === "string" && tool.name.trim()) ||
        "";
      if (!name) return;
      allowedTools.add(name);
      strictTools.set(name, (fn?.strict ?? tool.strict) === true);
      toolSchemas.set(name, fn?.parameters ?? tool.parameters ?? null);
    });
  }

  const forcedName = resolveForcedToolName(toolChoice);
  if (forcedName) {
    allowedTools = new Set([forcedName]);
  }

  const mode = normalizeToolChoiceMode(toolChoice);
  if (mode === "none") {
    return { enabled: false, allowedTools, strictTools, toolSchemas };
  }

  return {
    enabled: mode !== "none",
    allowedTools,
    strictTools,
    toolSchemas,
  };
};

const appendChoiceText = (store, choiceIndex, text) => {
  if (typeof text !== "string" || !text) return;
  const index = Number.isInteger(choiceIndex) && choiceIndex >= 0 ? choiceIndex : 0;
  if (!store.has(index)) store.set(index, []);
  store.get(index).push(text);
};

const buildPromptFromItems = (items) => {
  if (!Array.isArray(items)) return "";
  const textItems = items
    .filter((item) => item && item.type === "text" && typeof item.data?.text === "string")
    .map((item) => item.data.text);
  return textItems.join("\n");
};

export async function postResponsesNonStream(req, res) {
  applyProxyTraceHeaders(res);
  const reqId = ensureReqId(res);
  const started = Date.now();
  const originalBody = req.body || {};

  res.locals = res.locals || {};
  const locals = res.locals;
  locals.endpoint_mode = "responses";
  locals.routeOverride = "/v1/responses";
  locals.modeOverride = "responses_nonstream";
  logSanitizerToggle({
    enabled: SANITIZE_METADATA,
    trigger: "request",
    route: locals.routeOverride,
    mode: locals.modeOverride,
    reqId,
  });

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
      trace_id: locals.trace_id,
      route: locals.routeOverride,
      mode: locals.modeOverride,
      method: req.method,
    },
    {
      model: effectiveModel,
      stream: false,
      has_tools: Array.isArray(normalized.tools) && normalized.tools.length > 0,
      tool_count: normalizedToolsSummary.tool_count,
      tool_types: normalizedToolsSummary.tool_types,
      tool_types_truncated: normalizedToolsSummary.tool_types_truncated,
      tool_names: normalizedToolsSummary.tool_names,
      tool_names_truncated: normalizedToolsSummary.tool_names_truncated,
    }
  );

  const { nativeTools, functionTools } = splitResponsesTools(normalized.tools);
  const capabilityCheck = await ensureResponsesCapabilities({
    toolsRequested: nativeTools.length > 0 || functionTools.length > 0,
  });
  if (!capabilityCheck.ok) {
    applyCors(req, res);
    res.status(capabilityCheck.statusCode).json(capabilityCheck.body);
    restoreOutputMode();
    return;
  }

  const fallbackMax = Number(CFG.PROXY_RESPONSES_DEFAULT_MAX_TOKENS || 0);
  const maxOutputTokens = normalized.maxOutputTokens ?? (fallbackMax > 0 ? fallbackMax : undefined);
  const dynamicTools = buildDynamicTools(functionTools, normalized.toolChoice);

  const developerInstructions = normalized.developerInstructions || "";
  const baseInstructions = CFG.PROXY_DISABLE_INTERNAL_TOOLS
    ? RESPONSES_INTERNAL_TOOLS_INSTRUCTION
    : undefined;
  const appServerConfig = CFG.PROXY_DISABLE_INTERNAL_TOOLS
    ? {
        features: {
          streamable_shell: false,
          unified_exec: false,
          view_image_tool: false,
          apply_patch_freeform: false,
        },
        tools: {
          web_search: false,
          view_image: false,
        },
      }
    : undefined;

  const turn = {
    model: effectiveModel,
    items: normalized.inputItems,
    cwd: CFG.PROXY_CODEX_WORKDIR,
    approvalPolicy: APPROVAL_POLICY,
    sandboxPolicy: SANDBOX_MODE ? { type: SANDBOX_MODE } : undefined,
    summary: "auto",
  };
  if (Number.isInteger(nValue) && nValue > 0) turn.choiceCount = nValue;
  if (dynamicTools !== undefined) turn.dynamicTools = dynamicTools;
  if (developerInstructions) {
    turn.developerInstructions = developerInstructions;
  }
  if (appServerConfig) {
    turn.config = appServerConfig;
  }
  if (baseInstructions) {
    turn.baseInstructions = baseInstructions;
  }
  if (normalized.outputSchema !== undefined) {
    turn.outputSchema = normalized.outputSchema;
  }

  const message = {
    items: normalized.inputItems,
    includeUsage: true,
  };
  if (maxOutputTokens !== undefined) message.maxOutputTokens = maxOutputTokens;
  if (normalized.responseFormat !== undefined) message.responseFormat = normalized.responseFormat;
  if (normalized.outputSchema !== undefined) {
    message.outputSchema = normalized.outputSchema;
  }
  if (dynamicTools !== undefined) message.dynamicTools = dynamicTools;

  const ingressToolCount = functionTools.length;
  const turnToolCount = countDynamicTools(turn.dynamicTools);
  const messageToolCount = countDynamicTools(message.dynamicTools);
  const toolsMismatch = ingressToolCount !== turnToolCount;
  logStructured(
    {
      component: "responses",
      event: "responses_tools_projection",
      level: toolsMismatch ? "warn" : "info",
      req_id: reqId,
      route: "/v1/responses",
      mode: "responses_nonstream",
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
    trace: {
      reqId,
      route: "/v1/responses",
      mode: "responses_nonstream",
      trace_id: locals.trace_id || null,
      copilot_trace_id: locals.copilot_trace_id || null,
    },
  });
  const unmatchedToolOutputs = respondToToolOutputs(child, normalized.toolOutputs, {
    reqId,
    route: "/v1/responses",
    mode: "responses_nonstream",
  });
  if (unmatchedToolOutputs.length) {
    appendShimToolOutputs(child.transport, unmatchedToolOutputs, turn, message, {
      reqId,
      route: "/v1/responses",
      mode: "responses_nonstream",
    });
  }

  let responded = false;
  let usage = null;
  let finishReason = null;
  let finishTrigger = null;
  const toolCallAggregator = createToolCallAggregator();
  const textParts = new Map();
  const textDeltas = new Map();
  const sanitizedMetadataSummary = { count: 0, keys: new Set(), sources: new Set() };
  const seenSanitizedRemovalSignatures = new Set();
  const mergedMetadataInfo = { metadata: {}, sources: new Set() };

  const mergeMetadataInfo = (info) => {
    if (info && typeof info === "object") {
      const metadata = info.metadata && typeof info.metadata === "object" ? info.metadata : {};
      for (const [rawKey, rawValue] of Object.entries(metadata)) {
        const normalizedKey = normalizeMetadataKey(rawKey);
        if (!normalizedKey) continue;
        // eslint-disable-next-line security/detect-object-injection
        mergedMetadataInfo.metadata[normalizedKey] = rawValue;
      }
      if (Array.isArray(info.sources)) {
        for (const source of info.sources) {
          if (typeof source === "string" && source) mergedMetadataInfo.sources.add(source);
        }
      }
    }
    const hasMetadata = Object.keys(mergedMetadataInfo.metadata).length > 0;
    const hasSources = mergedMetadataInfo.sources.size > 0;
    if (!hasMetadata && !hasSources) return null;
    return {
      metadata: { ...mergedMetadataInfo.metadata },
      sources: Array.from(mergedMetadataInfo.sources),
    };
  };

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
        const rawValue = entry.raw !== undefined && entry.raw !== null ? String(entry.raw) : "";
        const rawLength = rawValue ? rawValue.length : 0;
        const rawHash = rawValue ? sha256(rawValue) : null;
        const signature = `${normalizedKey || ""}::${rawHash || ""}::${rawLength}`;
        if (!signature.trim()) continue;
        if (seenSanitizedRemovalSignatures.has(signature)) continue;
        seenSanitizedRemovalSignatures.add(signature);
        if (normalizedKey) sanitizedMetadataSummary.keys.add(normalizedKey);
        uniqueRemovedEntries.push({
          key: normalizedKey || entry.key,
          raw_length: rawLength || undefined,
          raw_hash: rawHash || undefined,
        });
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
      route: locals.routeOverride || "/v1/responses",
      mode: locals.modeOverride || "responses_nonstream",
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
    const mergedInfo = mergeMetadataInfo(metadataInfo);
    const metadata = mergedInfo?.metadata || {};
    const { text: sanitizedText, removed } = sanitizeMetadataTextSegment(segment ?? "", metadata);
    if (mergedInfo || (removed && removed.length)) {
      recordSanitizedMetadata({
        stage,
        eventType,
        metadata: mergedInfo ? mergedInfo.metadata : null,
        removed,
        sources: mergedInfo?.sources,
      });
    }
    return sanitizedText;
  };

  let idleTimer = null;
  const cancelIdle = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };
  const respondIdleTimeout = () => {
    if (responded) return;
    responded = true;
    cancelIdle();
    try {
      child.kill("SIGKILL");
    } catch {}
    if (!res.headersSent) {
      applyCors(req, res);
      res.status(504).json({
        error: { message: "backend idle timeout", type: "timeout_error", code: "idle_timeout" },
      });
    }
    restoreOutputMode();
  };
  const resetIdle = () => {
    if (!IDLE_TIMEOUT_MS || IDLE_TIMEOUT_MS <= 0) return;
    cancelIdle();
    idleTimer = setTimeout(respondIdleTimeout, IDLE_TIMEOUT_MS);
  };

  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    resetIdle();
    const choiceIndex = Number.isInteger(event.choiceIndex) ? event.choiceIndex : 0;
    if (event.type === "text_delta") {
      const sanitized = applyMetadataSanitizer(event.delta, event.metadataInfo, {
        stage: "agent_message_delta",
        eventType: "agent_message_delta",
      });
      appendChoiceText(textDeltas, choiceIndex, sanitized);
      return;
    }
    if (event.type === "text") {
      const sanitized = applyMetadataSanitizer(event.text, event.metadataInfo, {
        stage: "agent_message",
        eventType: "agent_message",
      });
      appendChoiceText(textParts, choiceIndex, sanitized);
      return;
    }
    if (event.type === "dynamic_tool_call") {
      const payload = event.messagePayload || event.payload?.msg || event.payload;
      const delta =
        event.toolCallDelta || buildToolCallDeltaFromDynamicRequest(payload || event.payload);
      if (delta?.tool_calls?.length) {
        toolCallAggregator.ingestMessage(
          { tool_calls: delta.tool_calls },
          { choiceIndex, emitIfMissing: true }
        );
      }
      return;
    }
    if (event.type === "tool_calls_delta") {
      if (Array.isArray(event.tool_calls)) {
        toolCallAggregator.ingestDelta({ tool_calls: event.tool_calls }, { choiceIndex });
      }
      return;
    }
    if (event.type === "tool_calls") {
      if (Array.isArray(event.tool_calls)) {
        toolCallAggregator.ingestMessage(
          { tool_calls: event.tool_calls },
          { choiceIndex, emitIfMissing: true }
        );
      }
      return;
    }
    if (event.type === "function_call_delta") {
      if (event.function_call && typeof event.function_call === "object") {
        toolCallAggregator.ingestDelta({ function_call: event.function_call }, { choiceIndex });
      }
      return;
    }
    if (event.type === "function_call") {
      if (event.function_call && typeof event.function_call === "object") {
        toolCallAggregator.ingestMessage(
          { function_call: event.function_call },
          { choiceIndex, emitIfMissing: true }
        );
      }
      return;
    }
    if (event.type === "usage") {
      if (event.usage && typeof event.usage === "object") {
        usage = event.usage;
      }
      return;
    }
    if (event.type === "finish") {
      finishReason = event.reason || finishReason;
      finishTrigger = event.trigger || finishTrigger;
    }
  };

  const requestTimeout = setTimeout(respondIdleTimeout, REQ_TIMEOUT_MS);
  resetIdle();

  if (KILL_ON_DISCONNECT) {
    req.on("close", () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const prompt = buildPromptFromItems(normalized.inputItems);
    const submission = {
      id: reqId,
      op: { type: "user_input", items: [{ type: "text", text: prompt }] },
    };
    child.stdin.write(JSON.stringify(submission) + "\n");
  } catch {}

  try {
    await Promise.race([
      runNativeResponses({
        adapter: child,
        onEvent: handleEvent,
        sanitizeMetadata: SANITIZE_METADATA,
        extractMetadataFromPayload,
        dynamicToolCallMode: "atomic",
      }),
      new Promise((_resolve, reject) => child.once("error", reject)),
    ]);
  } catch (error) {
    clearTimeout(requestTimeout);
    cancelIdle();
    const mapped = mapTransportError(error);
    if (!res.headersSent && !responded) {
      responded = true;
      applyCors(req, res);
      if (mapped) {
        res.status(mapped.statusCode).json(mapped.body);
      } else {
        res.status(500).json({
          error: {
            message: error?.message || "Internal server error",
            type: error?.type || "server_error",
            code: error?.code || "internal_error",
          },
        });
      }
    }
    restoreOutputMode();
    return;
  }

  clearTimeout(requestTimeout);
  cancelIdle();
  if (responded || res.headersSent) {
    restoreOutputMode();
    return;
  }

  const choiceTextParts = textParts.get(0) || [];
  const choiceDeltaParts = textDeltas.get(0) || [];
  let outputText = choiceTextParts.length ? choiceTextParts.join("") : choiceDeltaParts.join("");
  const aggregatedCalls = toolCallAggregator.snapshot({ choiceIndex: 0 });
  const toolParseOptions = buildToolParseOptions(normalized.tools, normalized.toolChoice);
  let parsedCalls = [];
  let parserErrors = [];

  if (toolParseOptions.enabled && outputText) {
    const parsed = parseToolCallText(outputText, {
      allowedTools: toolParseOptions.allowedTools,
      strictTools: toolParseOptions.strictTools,
      toolSchemas: toolParseOptions.toolSchemas,
    });
    outputText = parsed.visibleTextDeltas.join("");
    parserErrors = parsed.errors || [];
    parsedCalls = parsed.parsedToolCalls.map((call, index) => ({
      id: `fc_${String(index + 1).padStart(3, "0")}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }

  const strictError = parserErrors.find((err) => err?.strict);
  let status = mapFinishStatus(finishReason);
  if (strictError) {
    status = "failed";
    outputText = `Tool call parsing failed: ${strictError.message || strictError.type}`;
    parsedCalls = [];
  }

  const functionCalls = [...aggregatedCalls, ...parsedCalls];

  const envelope = buildResponsesEnvelope({
    responseId: originalBody?.id,
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    outputText,
    functionCalls,
    usage,
    status,
  });
  const usagePayload = envelope?.usage || null;
  const sanitizerSummary = getSanitizerSummaryData();
  if (SANITIZE_METADATA) {
    logSanitizerSummary({
      enabled: true,
      route: locals.routeOverride || "/v1/responses",
      mode: locals.modeOverride || "responses_nonstream",
      reqId,
      count: sanitizerSummary.count,
      keys: sanitizerSummary.keys,
      sources: sanitizerSummary.sources,
    });
  }

  captureResponsesNonStream({
    req,
    res,
    requestBody: originalBody,
    responseBody: envelope,
    outputModeEffective,
  });

  try {
    const prev = originalBody?.previous_response_id;
    logStructured(
      {
        component: "responses",
        event: "responses_nonstream_summary",
        level: "debug",
        req_id: locals.req_id,
        trace_id: locals.trace_id,
        route: locals.routeOverride || "/v1/responses",
        mode: locals.modeOverride || locals.mode,
        model: envelope?.model ?? null,
      },
      {
        endpoint_mode: locals.endpoint_mode || "responses",
        copilot_trace_id: locals.copilot_trace_id || null,
        status_emitted: envelope?.status ?? null,
        usage_input_tokens: usagePayload?.input_tokens ?? null,
        usage_output_tokens: usagePayload?.output_tokens ?? null,
        usage_total_tokens: usagePayload?.total_tokens ?? null,
        previous_response_id_hash: prev ? sha256(prev) : null,
        output_mode_effective: locals.output_mode_effective ?? null,
        response_shape_version: "responses_v0_nonstream_openai_json",
      }
    );
  } catch {}

  try {
    const textSummary = summarizeTextParts(
      choiceTextParts.length ? choiceTextParts : choiceDeltaParts
    );
    const toolSummary = summarizeToolCalls(functionCalls);
    const toolUseSummary = summarizeToolUseItems(envelope.output);
    logStructured(
      {
        component: "responses",
        event: "responses_transform_summary",
        level: "info",
        req_id: locals.req_id,
        trace_id: locals.trace_id,
        route: locals.routeOverride || "/v1/responses",
        mode: locals.modeOverride || locals.mode,
        model: envelope?.model ?? null,
      },
      {
        endpoint_mode: locals.endpoint_mode || "responses",
        copilot_trace_id: locals.copilot_trace_id || null,
        output_mode_requested: locals.output_mode_requested ?? null,
        output_mode_effective: locals.output_mode_effective ?? null,
        response_shape_version: "responses_v0_nonstream_openai_json",
        status: envelope?.status ?? null,
        finish_reason: finishReason || null,
        finish_trigger: finishTrigger || null,
        tool_calls_detected: toolSummary.tool_call_count,
        tool_calls_emitted: toolSummary.tool_call_count,
        tool_names: toolSummary.tool_names,
        tool_names_truncated: toolSummary.tool_names_truncated,
        tool_use_items: toolUseSummary.tool_use_count,
        tool_use_names: toolUseSummary.tool_use_names,
        output_text_bytes: textSummary.output_text_bytes,
        output_text_hash: textSummary.output_text_hash,
        xml_in_text: textSummary.xml_in_text,
      }
    );
  } catch {}

  appendUsage({
    req_id: reqId,
    route: locals.routeOverride || "/v1/responses",
    mode: locals.modeOverride || "responses_nonstream",
    method: req.method || "POST",
    status_code: res.statusCode || 200,
    requested_model: requestedModel,
    effective_model: effectiveModel,
    stream: false,
    prompt_tokens: usagePayload?.input_tokens ?? null,
    completion_tokens: usagePayload?.output_tokens ?? null,
    total_tokens: usagePayload?.total_tokens ?? null,
    duration_ms: Date.now() - started,
    status: res.statusCode || 200,
    user_agent: req.headers["user-agent"] || "",
    metadata_sanitizer_enabled: SANITIZE_METADATA,
    sanitized_metadata_count: SANITIZE_METADATA ? sanitizerSummary.count : 0,
    sanitized_metadata_keys: SANITIZE_METADATA ? sanitizerSummary.keys : [],
    sanitized_metadata_sources: SANITIZE_METADATA ? sanitizerSummary.sources : [],
    output_mode: outputModeEffective,
  });

  applyCors(req, res);
  responded = true;
  res.status(200).json(envelope);
  restoreOutputMode();
}
