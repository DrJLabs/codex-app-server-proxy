import { appendProtoEvent } from "../dev-logging.js";
import { sanitizeRpcPayload } from "./sanitize.js";
import { ensureReqId } from "../lib/request-context.js";

const base = (trace = {}) => ({
  req_id: trace.reqId || trace.req_id || null,
  route: trace.route || null,
  mode: trace.mode || null,
});

const hasTrace = (trace) =>
  Boolean(trace && (trace.reqId || trace.req_id || trace.route || trace.mode));

const nestedToolPayload = (params) => {
  if (!params || typeof params !== "object") return null;
  if (params.tool_calls) return params.tool_calls;
  if (params.tool_call) return params.tool_call;
  const nestedSources = [params.msg, params.message, params.data?.msg, params.data?.message];
  for (const candidate of nestedSources) {
    if (candidate && typeof candidate === "object") {
      if (candidate.tool_calls) return candidate.tool_calls;
      if (candidate.tool_call) return candidate.tool_call;
      if (candidate.kind === "tool_call" && candidate.payload) return candidate.payload;
    }
  }
  if (params.kind === "tool_call" && params.payload) return params.payload;
  return null;
};

const summarizeToolsForLog = (tools, { maxTypes = 10, maxNames = 20 } = {}) => {
  const resolveDefinitions = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value !== "object") return [];
    const defs =
      value.definitions ||
      value.tools ||
      value.tool_definitions ||
      value.toolDefinitions ||
      value.functions;
    return Array.isArray(defs) ? defs : [];
  };
  const definitions = resolveDefinitions(tools);
  if (!definitions.length) {
    return {
      tool_count: 0,
      tool_types: [],
      tool_types_truncated: false,
      tool_names: [],
      tool_names_truncated: false,
    };
  }
  const types = [];
  const names = [];
  for (const tool of definitions) {
    if (!tool || typeof tool !== "object") continue;
    const rawType = typeof tool.type === "string" ? tool.type.trim() : "";
    if (rawType) types.push(rawType.toLowerCase());
    else if (tool?.function || tool?.fn || typeof tool?.name === "string") {
      types.push("function");
    }
    const name = typeof tool?.function?.name === "string" ? tool.function.name.trim() : "";
    const fallback = !name && typeof tool?.name === "string" ? tool.name.trim() : "";
    const resolvedName = name || fallback;
    if (resolvedName) names.push(resolvedName);
  }
  const uniqTypes = Array.from(new Set(types)).sort();
  const uniqNames = Array.from(new Set(names)).sort();
  return {
    tool_count: definitions.length,
    tool_types: uniqTypes.slice(0, Math.max(0, maxTypes)),
    tool_types_truncated: uniqTypes.length > maxTypes,
    tool_names: uniqNames.slice(0, Math.max(0, maxNames)),
    tool_names_truncated: uniqNames.length > maxNames,
  };
};

export function logBackendSubmission(trace, { rpcId, method, params }) {
  if (!hasTrace(trace)) return;
  const toolsSummary = summarizeToolsForLog(params?.tools);
  appendProtoEvent({
    ts: Date.now(),
    phase: "backend_submission",
    direction: "outbound",
    kind: "rpc_request",
    rpc_id: rpcId,
    method,
    payload: sanitizeRpcPayload(params),
    tools_summary: toolsSummary,
    ...base(trace),
  });
}

export function logBackendResponse(trace, { rpcId, method, result, error }) {
  if (!hasTrace(trace)) return;
  appendProtoEvent({
    ts: Date.now(),
    phase: "backend_io",
    direction: "inbound",
    kind: error ? "rpc_error" : "rpc_response",
    rpc_id: rpcId,
    method,
    payload: sanitizeRpcPayload(error || result),
    ...base(trace),
  });
}

export function logBackendNotification(trace, { method, params }) {
  if (!hasTrace(trace)) return;
  const payload = sanitizeRpcPayload(params);
  appendProtoEvent({
    ts: Date.now(),
    phase: "backend_io",
    direction: "inbound",
    kind: "rpc_notification",
    notification_method: method,
    payload,
    ...base(trace),
  });
  const toolPayload = nestedToolPayload(params);
  if (toolPayload) {
    appendProtoEvent({
      ts: Date.now(),
      phase: "backend_io",
      direction: "inbound",
      kind: "tool_block",
      notification_method: method,
      payload: sanitizeRpcPayload(toolPayload),
      ...base(trace),
    });
  }
}

export function logBackendLifecycle(event, detail = {}) {
  const {
    req_id: reqIdFromDetail = null,
    reqId = null,
    route = null,
    mode = null,
    ...rest
  } = detail || {};
  appendProtoEvent({
    ts: Date.now(),
    phase: "backend_lifecycle",
    direction: "none",
    kind: event,
    payload: rest,
    req_id: reqIdFromDetail ?? reqId ?? null,
    route,
    mode,
  });
}

export function traceFromResponse(res) {
  if (!res) return {};
  const reqId = ensureReqId(res);
  return {
    reqId,
    route: res.locals?.httpRoute || null,
    mode: res.locals?.mode || null,
  };
}
