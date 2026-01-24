import { nanoid } from "nanoid";

const RESPONSE_ID_PREFIX = "resp_";
const MESSAGE_ID_PREFIX = "msg_";

const sanitizeIdentifier = (value, prefix) => {
  if (typeof value === "string" && value.trim()) {
    const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    if (cleaned) {
      return cleaned.startsWith(prefix) ? cleaned : `${prefix}${cleaned}`;
    }
  }
  return `${prefix}${nanoid()}`;
};

export const normalizeResponseId = (value) => {
  let base = typeof value === "string" ? value.trim() : "";
  if (base.startsWith(RESPONSE_ID_PREFIX)) {
    base = base.slice(RESPONSE_ID_PREFIX.length);
  }
  base = base.replace(/^chatcmpl-/, "");
  return sanitizeIdentifier(base, RESPONSE_ID_PREFIX);
};

export const normalizeMessageId = (value) => {
  let base = typeof value === "string" ? value.trim() : "";
  if (base.startsWith(MESSAGE_ID_PREFIX)) {
    base = base.slice(MESSAGE_ID_PREFIX.length);
  }
  return sanitizeIdentifier(base, MESSAGE_ID_PREFIX);
};

const tryParseJson = (input) => {
  if (typeof input !== "string" || !input.trim()) return null;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
};

const extractTextFromInputItems = (items) => {
  const parts = [];
  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (typeof item === "object") {
      if (typeof item.text === "string") {
        parts.push(item.text);
        continue;
      }
      if (typeof item.content === "string") {
        parts.push(item.content);
        continue;
      }
      if (Array.isArray(item.content)) {
        parts.push(extractTextFromInputItems(item.content));
        continue;
      }
      if (item.content && typeof item.content === "object") {
        parts.push(extractTextFromInputItems([item.content]));
      }
    }
  }
  // TODO(responses): preserve non-text multimodal content once Codex supports passing through
  // rich input blocks instead of flattening to text.
  return parts.flat().join(" ").trim();
};

export const coerceInputToChatMessages = (body = {}) => {
  if (Array.isArray(body.messages) && body.messages.length) {
    return body.messages;
  }

  const messages = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions.trim() });
  }

  if (body.input !== undefined) {
    if (typeof body.input === "string") {
      messages.push({ role: "user", content: body.input });
    } else if (Array.isArray(body.input)) {
      const text = extractTextFromInputItems(body.input);
      if (text) messages.push({ role: "user", content: text });
    } else if (body.input && typeof body.input === "object" && Array.isArray(body.input.content)) {
      const text = extractTextFromInputItems(body.input.content);
      if (text) messages.push({ role: "user", content: text });
    }
  }

  return messages;
};

export const detectCopilotRequest = (req) => {
  const headers = req?.headers || {};
  const ua = String(headers["user-agent"] || "").toLowerCase();
  const hasCopilotTrace = Boolean(headers["x-copilot-trace-id"] || headers["x-trace-id"]);
  const isObsidianClient = ua.includes("obsidian/") || ua.startsWith("un/js");
  return isObsidianClient || hasCopilotTrace;
};

export const resolveResponsesOutputMode = ({ req, defaultValue }) => {
  const explicit = req?.headers?.["x-proxy-output-mode"];
  if (explicit && String(explicit).trim()) {
    return { effective: String(explicit).trim(), source: "header" };
  }
  return { effective: defaultValue, source: "default" };
};

export const applyDefaultProxyOutputModeHeader = (req, desiredOutputMode) => {
  const desired =
    desiredOutputMode === undefined || desiredOutputMode === null
      ? ""
      : String(desiredOutputMode).trim();
  if (!desired) return () => {};

  const headers = req && typeof req === "object" ? req.headers : null;
  if (!headers || typeof headers !== "object") return () => {};

  const original = headers["x-proxy-output-mode"];
  if (original !== undefined && String(original).trim()) {
    return () => {};
  }

  headers["x-proxy-output-mode"] = desired;

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (original === undefined) {
      delete headers["x-proxy-output-mode"];
    } else {
      headers["x-proxy-output-mode"] = original;
    }
  };
};

const appendTextContent = (collector, text) => {
  if (typeof text !== "string") return;
  const normalized = text;
  if (!normalized) return;
  collector.push({
    type: "output_text",
    text: normalized,
  });
};

const appendContentNode = (collector, node) => {
  if (!node) return;
  if (typeof node === "string") {
    appendTextContent(collector, node);
    return;
  }
  if (typeof node !== "object") return;

  if (node.type === "output_text" && typeof node.text === "string") {
    collector.push({ type: "output_text", text: node.text });
    return;
  }

  if (node.type === "tool_use") {
    collector.push(structuredClone(node));
    return;
  }

  if (node.type === "text" && typeof node.text === "string") {
    collector.push({ type: "output_text", text: node.text });
    return;
  }

  if (typeof node.text === "string") {
    collector.push({ type: "output_text", text: node.text });
  }
};

const mapToolCallToContent = (call, fallbackIndex = 0) => {
  if (!call) return null;
  const parsedArgs = tryParseJson(call.function?.arguments);
  return {
    type: "tool_use",
    id: call.id || `call_${fallbackIndex}_${nanoid()}`,
    name: call.function?.name || call.id || "function_call",
    input:
      parsedArgs === null ? {} : typeof parsedArgs === "string" ? { raw: parsedArgs } : parsedArgs,
  };
};

export const mapChoiceToOutput = (choice, index = 0) => {
  const message = choice?.message || {};
  const role = message.role || "assistant";
  const content = [];

  const rawContent = message.content;
  if (typeof rawContent === "string") {
    appendTextContent(content, rawContent);
  } else if (Array.isArray(rawContent)) {
    for (const node of rawContent) appendContentNode(content, node);
  }

  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((call, idx) => {
      const mapped = mapToolCallToContent(call, idx);
      if (mapped) content.push(mapped);
    });
  }

  if (message.function_call) {
    const mapped = mapToolCallToContent(
      {
        id: message.function_call?.id,
        type: "function",
        function: {
          name: message.function_call?.name,
          arguments: message.function_call?.arguments,
        },
      },
      index
    );
    if (mapped) content.push(mapped);
  }

  if (!content.length) {
    content.push({ type: "output_text", text: "" });
  }

  return {
    id: normalizeMessageId(message.id || choice?.id || `output_${index}`),
    type: "message",
    role,
    content,
  };
};

const mapUsage = (usage) => {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? undefined;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? undefined;
  const totalTokens =
    usage.total_tokens ??
    (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : undefined);
  const result = {};
  if (inputTokens != null) result.input_tokens = inputTokens;
  if (outputTokens != null) result.output_tokens = outputTokens;
  if (totalTokens != null) result.total_tokens = totalTokens;
  return Object.keys(result).length ? result : undefined;
};

const deriveStatusFromFinishReasons = (choices = []) => {
  const reasons = new Set();
  for (const choice of choices) {
    if (choice?.finish_reason) {
      reasons.add(String(choice.finish_reason).toLowerCase());
    }
  }
  if (reasons.has("length") || reasons.has("content_filter")) return "incomplete";
  if (reasons.has("failed") || reasons.has("error")) return "failed";
  if (reasons.has("cancelled") || reasons.has("canceled")) return "failed";
  return "completed";
};

export const convertChatResponseToResponses = (payload, requestBody = {}) => {
  if (!payload || typeof payload !== "object") return payload;
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) return payload;

  const outputs = payload.choices.map((choice, idx) => mapChoiceToOutput(choice, idx));
  const response = {
    id: normalizeResponseId(payload.id),
    status: deriveStatusFromFinishReasons(payload.choices),
    model: payload.model,
    output: outputs,
  };

  const usage = mapUsage(payload.usage);
  if (usage) response.usage = usage;

  if (requestBody?.previous_response_id) {
    response.previous_response_id = requestBody.previous_response_id;
  }

  return response;
};

export const buildStreamingEnvelope = ({
  state,
  requestBody,
  usage,
  status,
  textSegments,
  toolCalls,
}) => {
  const content = [];
  const text = textSegments.join("");
  if (text) {
    content.push({ type: "output_text", text });
  }

  if (toolCalls.size) {
    Array.from(toolCalls.values()).forEach((call, idx) => {
      const mapped = mapToolCallToContent(call, idx);
      if (mapped) content.push(mapped);
    });
  }

  if (!content.length) {
    content.push({ type: "output_text", text: "" });
  }

  const output = [
    {
      id: state.messageId,
      type: "message",
      role: state.role || "assistant",
      content,
    },
  ];

  const envelope = {
    id: state.responseId,
    status,
    model: state.model,
    output,
  };

  const mappedUsage = mapUsage(usage);
  if (mappedUsage) envelope.usage = mappedUsage;
  if (requestBody?.previous_response_id) {
    envelope.previous_response_id = requestBody.previous_response_id;
  }

  return envelope;
};

export const initializeStreamingState = () => ({
  initialized: false,
  responseId: normalizeResponseId(),
  messageId: normalizeMessageId(),
  role: "assistant",
  model: null,
  textSegments: [],
  toolCalls: new Map(),
  usage: null,
  status: "completed",
  buffer: "",
  finished: false,
  createdEmitted: false,
});

export const updateStreamingToolCalls = (callDelta, toolCalls) => {
  if (!Array.isArray(callDelta)) return;
  for (const delta of callDelta) {
    const idx = Number(delta.index ?? toolCalls.size);
    const existing = toolCalls.get(idx) || {
      id: null,
      type: delta.type || "function",
      function: {},
    };
    if (delta.id) existing.id = delta.id;
    if (delta.type) existing.type = delta.type;
    if (delta.function) {
      existing.function = existing.function || {};
      if (delta.function.name) existing.function.name = delta.function.name;
      if (delta.function.arguments) {
        const currentArgs = existing.function.arguments || "";
        existing.function.arguments = currentArgs + delta.function.arguments;
      }
    }
    toolCalls.set(idx, existing);
  }
};

export const RESPONSE_CONSTANTS = {
  RESPONSE_ID_PREFIX,
  MESSAGE_ID_PREFIX,
};
