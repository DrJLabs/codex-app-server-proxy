import { logStructured } from "../../services/logging/schema.js";
import { ensureReqId } from "../../lib/request-context.js";
import { ensureCopilotTraceContext } from "../../lib/trace-ids.js";
import { detectCopilotRequest } from "../../lib/copilot-detect.js";

const RESPONSES_ROUTE = "/v1/responses";

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

const isPlainObject = (value) =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);

const normalizeKey = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
};

const summarizeKeys = (candidate, { maxKeys = 25 } = {}) => {
  if (!isPlainObject(candidate)) {
    return { has: false, key_count: 0, keys: [], keys_truncated: false };
  }
  const keys = Array.from(
    new Set(
      Object.keys(candidate)
        .map((key) => normalizeKey(key))
        .filter(Boolean)
    )
  ).sort();
  return {
    has: keys.length > 0,
    key_count: keys.length,
    keys: keys.slice(0, Math.max(0, maxKeys)),
    keys_truncated: keys.length > maxKeys,
  };
};

const summarizeCandidateHeaders = (headers, { maxKeys = 20 } = {}) => {
  if (!headers || typeof headers !== "object") {
    return {
      has_candidate_headers: false,
      candidate_header_keys: [],
      candidate_header_keys_truncated: false,
    };
  }
  const INTERESTING = /(session|conversation|thread|chat|copilot|obsidian|idempotency)/i;
  const FORBIDDEN = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
  ]);
  const keys = Array.from(
    new Set(
      Object.keys(headers)
        .map((key) =>
          String(key || "")
            .trim()
            .toLowerCase()
        )
        .filter((key) => key && !FORBIDDEN.has(key) && INTERESTING.test(key))
    )
  ).sort();
  return {
    has_candidate_headers: keys.length > 0,
    candidate_header_keys: keys.slice(0, Math.max(0, maxKeys)),
    candidate_header_keys_truncated: keys.length > maxKeys,
  };
};

const summarizeCandidateIdFields = (body, { maxFields = 10 } = {}) => {
  if (!isPlainObject(body)) {
    return { candidate_id_fields_present: [], candidate_id_fields_truncated: false };
  }
  const CANDIDATES = [
    { canon: "conversation_id", variants: ["conversation_id", "conversationId"] },
    { canon: "session_id", variants: ["session_id", "sessionId"] },
    { canon: "thread_id", variants: ["thread_id", "threadId"] },
    { canon: "chat_id", variants: ["chat_id", "chatId"] },
    {
      canon: "client_conversation_id",
      variants: ["client_conversation_id", "clientConversationId"],
    },
    { canon: "client_session_id", variants: ["client_session_id", "clientSessionId"] },
    { canon: "idempotency_key", variants: ["idempotency_key", "idempotencyKey"] },
  ];
  const present = [];
  for (const candidate of CANDIDATES) {
    for (const variant of candidate.variants) {
      // eslint-disable-next-line security/detect-object-injection -- variant list is static
      const value = body[variant];
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      present.push(candidate.canon);
      break;
    }
  }
  const unique = Array.from(new Set(present)).sort();
  return {
    candidate_id_fields_present: unique.slice(0, Math.max(0, maxFields)),
    candidate_id_fields_truncated: unique.length > maxFields,
  };
};

export const summarizeTools = (tools, { maxTypes = 10, maxNames = 20 } = {}) => {
  if (!Array.isArray(tools)) {
    return {
      tool_count: 0,
      tool_types: [],
      tool_types_truncated: false,
      tool_names: [],
      tool_names_truncated: false,
      tool_function_name_present_count: 0,
      tool_function_name_missing_count: 0,
    };
  }
  const types = [];
  const names = [];
  let namePresent = 0;
  let nameMissing = 0;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const rawType = typeof tool.type === "string" ? tool.type.trim() : "";
    const hasName =
      typeof tool?.function?.name === "string"
        ? Boolean(tool.function.name.trim())
        : typeof tool?.name === "string"
          ? Boolean(tool.name.trim())
          : false;
    if (hasName) namePresent += 1;
    else nameMissing += 1;
    const name = typeof tool?.function?.name === "string" ? tool.function.name.trim() : "";
    const fallback = !name && typeof tool?.name === "string" ? tool.name.trim() : "";
    const resolvedName = name || fallback;
    if (resolvedName) names.push(resolvedName);
    if (rawType) types.push(rawType.toLowerCase());
    else if (tool?.function || tool?.fn || typeof tool?.name === "string") {
      types.push("function");
    }
  }
  const uniq = Array.from(new Set(types)).sort();
  const uniqNames = Array.from(new Set(names)).sort();
  return {
    tool_count: tools.length,
    tool_types: uniq.slice(0, Math.max(0, maxTypes)),
    tool_types_truncated: uniq.length > maxTypes,
    tool_names: uniqNames.slice(0, Math.max(0, maxNames)),
    tool_names_truncated: uniqNames.length > maxNames,
    tool_function_name_present_count: namePresent,
    tool_function_name_missing_count: nameMissing,
  };
};

const resolveInputItems = (body) => {
  const input = body?.input;
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object" && Array.isArray(input.content)) return input.content;
  return null;
};

const safeByteLength = (value) => {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
};

const scanTextForMarkers = (text, state) => {
  if (!isNonEmptyString(text)) return;
  const lower = text.toLowerCase();
  if (!state.hasRecentConversationsTag && lower.includes("<recent_conversations")) {
    state.hasRecentConversationsTag = true;
  }
  if (!state.hasSavedMemoriesTag && lower.includes("<saved_memories")) {
    state.hasSavedMemoriesTag = true;
  }
  if (!state.hasUseToolTag && lower.includes("<use_tool")) {
    state.hasUseToolTag = true;
  }
  if (!state.hasToolResultMarker && lower.includes("tool '") && lower.includes(" result:")) {
    state.hasToolResultMarker = true;
  }
};

const scanValueForMarkers = (value, state, depth = 0) => {
  if (!value) return;
  if (
    state.hasRecentConversationsTag &&
    state.hasSavedMemoriesTag &&
    state.hasUseToolTag &&
    state.hasToolResultMarker
  ) {
    return;
  }
  if (depth > 6) return;

  if (typeof value === "string") {
    scanTextForMarkers(value, state);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      scanValueForMarkers(entry, state, depth + 1);
      if (
        state.hasRecentConversationsTag &&
        state.hasSavedMemoriesTag &&
        state.hasUseToolTag &&
        state.hasToolResultMarker
      ) {
        return;
      }
    }
    return;
  }

  if (!isPlainObject(value)) return;

  if (typeof value.text === "string") scanTextForMarkers(value.text, state);
  if (typeof value.content === "string") {
    scanTextForMarkers(value.content, state);
  } else if (value.content) {
    scanValueForMarkers(value.content, state, depth + 1);
  }
};

export function summarizeResponsesIngress(body = {}, req = null) {
  const input = body?.input;
  const inputItems = resolveInputItems(body);
  const itemTypes = new Set();
  const messageRoles = new Set();
  const inputMetadataKeys = new Set();
  const markerState = {
    hasRecentConversationsTag: false,
    hasSavedMemoriesTag: false,
    hasUseToolTag: false,
    hasToolResultMarker: false,
  };
  let hasToolOutputItems = false;
  let hasInputItemMetadata = false;
  let toolOutputBytesTotal = 0;
  let toolOutputBytesKnown = true;
  let inputItemCount = null;
  let inputMessageCount = 0;

  if (isNonEmptyString(input)) {
    scanValueForMarkers(input, markerState);
  }

  if (Array.isArray(inputItems)) {
    inputItemCount = inputItems.length;
    for (const item of inputItems) {
      if (!item) continue;
      if (typeof item === "object") {
        if (typeof item.type === "string") itemTypes.add(item.type);
        if (item.type === "message") {
          inputMessageCount += 1;
          if (typeof item.role === "string" && item.role.trim()) {
            messageRoles.add(item.role.trim().toLowerCase());
          }
        }
        if (item.content !== undefined) scanValueForMarkers(item.content, markerState);
        if (item.text !== undefined) scanValueForMarkers(item.text, markerState);
        if (item.message !== undefined) scanValueForMarkers(item.message, markerState);
        if (isPlainObject(item.metadata)) {
          hasInputItemMetadata = true;
          for (const key of Object.keys(item.metadata)) {
            const normalized = normalizeKey(key);
            if (normalized) inputMetadataKeys.add(normalized);
          }
        }
        if (item.type === "tool_output") {
          hasToolOutputItems = true;
          const bytes = item.output === undefined ? null : safeByteLength(item.output);
          if (bytes === null) toolOutputBytesKnown = false;
          else toolOutputBytesTotal += bytes;
        }
      }
    }
  }

  const metadataSummary = summarizeKeys(body?.metadata, { maxKeys: 25 });
  const inputMetadataKeyList = Array.from(inputMetadataKeys).sort();
  const sessionKeyRe = /(session|conversation|thread|chat|idempotency)/i;
  const toolSummary = summarizeTools(body?.tools, { maxTypes: 10 });

  return {
    has_messages: Array.isArray(body?.messages) && body.messages.length > 0,
    has_instructions: isNonEmptyString(body?.instructions),
    has_input: input !== undefined,
    input_is_array: Array.isArray(input),
    input_item_count: inputItemCount,
    input_item_types: Array.from(itemTypes),
    input_message_count: inputMessageCount,
    input_message_roles: Array.from(messageRoles).slice(0, 10),
    has_recent_conversations_tag: markerState.hasRecentConversationsTag,
    has_saved_memories_tag: markerState.hasSavedMemoriesTag,
    has_use_tool_tag: markerState.hasUseToolTag,
    has_tool_result_marker: markerState.hasToolResultMarker,
    has_input_item_metadata: hasInputItemMetadata,
    input_item_metadata_keys: inputMetadataKeyList.slice(0, 25),
    input_item_metadata_keys_truncated: inputMetadataKeyList.length > 25,
    has_metadata: metadataSummary.has,
    metadata_keys: metadataSummary.keys,
    metadata_keys_truncated: metadataSummary.keys_truncated,
    has_session_like_metadata_key: metadataSummary.keys.some((key) => sessionKeyRe.test(key)),
    has_tools: Array.isArray(body?.tools) && body.tools.length > 0,
    has_tool_choice: body?.tool_choice !== undefined,
    has_previous_response_id: isNonEmptyString(body?.previous_response_id),
    tool_count: toolSummary.tool_count,
    tool_types: toolSummary.tool_types,
    tool_types_truncated: toolSummary.tool_types_truncated,
    tool_names: toolSummary.tool_names,
    tool_names_truncated: toolSummary.tool_names_truncated,
    tool_function_name_present_count: toolSummary.tool_function_name_present_count,
    tool_function_name_missing_count: toolSummary.tool_function_name_missing_count,
    has_tool_output_items: hasToolOutputItems,
    tool_output_bytes_total: hasToolOutputItems
      ? toolOutputBytesKnown
        ? toolOutputBytesTotal
        : null
      : null,
    model: typeof body?.model === "string" ? body.model : null,
    ...summarizeCandidateIdFields(body, { maxFields: 10 }),
    ...summarizeCandidateHeaders(req?.headers, { maxKeys: 20 }),
  };
}

export function logResponsesIngressRaw({
  req,
  res,
  body,
  outputModeRequested = null,
  outputModeEffective = null,
  ingressSummary = null,
  copilotDetection = null,
} = {}) {
  if (!req || !res) return;
  try {
    const reqId = ensureReqId(res);
    const { id: copilotTraceId, source, header } = ensureCopilotTraceContext(req, res);
    const route = res.locals?.routeOverride || RESPONSES_ROUTE;
    const mode = res.locals?.modeOverride || res.locals?.mode || null;
    const summary = ingressSummary || summarizeResponsesIngress(body, req);
    const detection =
      copilotDetection ||
      detectCopilotRequest({ headers: req?.headers, responsesSummary: summary });

    if (detection) {
      res.locals.copilot_detected = detection.copilot_detected;
      res.locals.copilot_detect_tier = detection.copilot_detect_tier;
      res.locals.copilot_detect_reasons = detection.copilot_detect_reasons;
    }
    logStructured(
      {
        component: "responses",
        event: "responses_ingress_raw",
        level: "info",
        req_id: reqId,
        trace_id: res.locals?.trace_id,
        route,
        mode,
        method: req.method,
      },
      {
        endpoint_mode: "responses",
        copilot_trace_id: copilotTraceId,
        copilot_trace_source: source,
        copilot_trace_header: header,
        copilot_detected: detection?.copilot_detected ?? false,
        copilot_detect_tier: detection?.copilot_detect_tier ?? null,
        copilot_detect_reasons: detection?.copilot_detect_reasons ?? [],
        stream: Boolean(body?.stream),
        output_mode_requested: outputModeRequested,
        output_mode_effective: outputModeEffective,
        ...summary,
      }
    );
  } catch {
    // Logging is best-effort; swallow any errors.
  }
}
