import { invalidRequestBody } from "../../lib/errors.js";
import { createUserMessageItem } from "../../lib/json-rpc/schema.ts";
import { config as CFG } from "../../config/index.js";
import { buildDynamicTools } from "../../lib/tools/dynamic-tools.js";

class ChatJsonRpcNormalizationError extends Error {
  constructor(body, statusCode = 400) {
    super("Chat request normalization failed");
    this.name = "ChatJsonRpcNormalizationError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

const ALLOWED_MESSAGE_ROLES = new Set([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
  "function",
]);
const ALLOWED_TOOL_CHOICES = new Set(["auto", "none", "required"]);
const ALLOWED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

const IGNORE_CLIENT_SYSTEM_PROMPT = CFG.PROXY_IGNORE_CLIENT_SYSTEM_PROMPT;

const toFiniteNumber = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return num;
};

const toPositiveInteger = (value) => {
  const num = toFiniteNumber(value);
  if (num === undefined) return undefined;
  if (!Number.isInteger(num) || num <= 0) return undefined;
  return num;
};

const flattenMessageContent = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if (part.type === "image_url") {
          const url =
            typeof part.image_url === "string" ? part.image_url : (part.image_url?.url ?? "");
          return url ? `[image:${url}]` : "";
        }
        if (part.type === "input_text" && typeof part.input_text === "string") {
          return part.input_text;
        }
        try {
          return JSON.stringify(part);
        } catch {
          return String(part ?? "");
        }
      })
      .join("");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content.content)) return flattenMessageContent(content.content);
  }
  if (content === null || content === undefined) return "";
  return String(content);
};

const normalizeToolChoice = (rawChoice, definitions) => {
  if (rawChoice === undefined || rawChoice === null) return undefined;
  if (typeof rawChoice === "string") {
    const trimmed = rawChoice.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (!ALLOWED_TOOL_CHOICES.has(trimmed)) {
      throw new ChatJsonRpcNormalizationError(
        invalidRequestBody(
          "tool_choice",
          'tool_choice must be "auto", "none", "required", or a function selector'
        )
      );
    }
    return trimmed;
  }
  if (typeof rawChoice !== "object") {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody(
        "tool_choice",
        'tool_choice must be a string ("auto" | "none" | "required") or { type: "function", function: { name } }'
      )
    );
  }
  const type = String(rawChoice.type || "function").toLowerCase();
  if (type && type !== "function") {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("tool_choice.type", 'tool_choice.type must be "function"')
    );
  }
  const fn = rawChoice.function || rawChoice.fn;
  if (!fn || typeof fn !== "object" || !fn.name || !String(fn.name).trim()) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("tool_choice.function.name", "tool_choice.function.name is required")
    );
  }
  const fnName = String(fn.name).trim();
  if (!definitions || !definitions.length) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("tool_choice", "tool_choice requires tools definitions")
    );
  }
  const matchesDefinition = definitions.some((definition) => {
    if (!definition || typeof definition !== "object") return false;
    const candidate = definition.function || definition.fn;
    return typeof candidate?.name === "string" && candidate.name.trim() === fnName;
  });
  if (!matchesDefinition) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody(
        "tool_choice.function.name",
        "tool_choice.function.name must reference a declared tool"
      )
    );
  }
  return { ...rawChoice, type: "function", function: { ...fn, name: fnName } };
};

const normalizeParallelToolCalls = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (["true", "1", "yes"].includes(trimmed)) return true;
    if (["false", "0", "no"].includes(trimmed)) return false;
  }
  return undefined;
};

const validateTools = (tools) => {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("tools", "tools must be an array of definitions")
    );
  }
  const definitions = [];
  for (const [idx, tool] of tools.entries()) {
    if (!tool || typeof tool !== "object") {
      throw new ChatJsonRpcNormalizationError(
        invalidRequestBody(
          `tools[${idx}]`,
          'tool definition must be an object with type "function"'
        )
      );
    }
    const type = String(tool.type || "").toLowerCase();
    if (type !== "function") {
      throw new ChatJsonRpcNormalizationError(
        invalidRequestBody(`tools[${idx}].type`, 'tool type must be "function"')
      );
    }
    const fn = tool.function || tool.fn;
    if (!fn || typeof fn !== "object" || !fn.name || !String(fn.name).trim()) {
      throw new ChatJsonRpcNormalizationError(
        invalidRequestBody(
          `tools[${idx}].function.name`,
          'function definitions must include a non-empty "name"'
        )
      );
    }
    definitions.push(tool);
  }
  return definitions.length ? definitions : undefined;
};

const normalizeLegacyFunctions = (functions) => {
  if (functions === undefined || functions === null) return undefined;
  if (!Array.isArray(functions)) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("functions", "functions must be an array of function definitions")
    );
  }
  return functions.map((fn, idx) => {
    if (!fn || typeof fn !== "object") {
      throw new ChatJsonRpcNormalizationError(
        invalidRequestBody(
          `functions[${idx}]`,
          "function definitions must be objects with name/parameters"
        )
      );
    }
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) {
      throw new ChatJsonRpcNormalizationError(
        invalidRequestBody(
          `functions[${idx}].name`,
          'function definitions must include a non-empty "name"'
        )
      );
    }
    const wrappedFn = { ...fn, name };
    return { type: "function", function: wrappedFn };
  });
};

const normalizeLegacyFunctionCall = (rawChoice) => {
  if (!rawChoice || typeof rawChoice !== "object") return rawChoice;
  if (rawChoice.function || rawChoice.fn) return rawChoice;
  const type = rawChoice.type ? String(rawChoice.type).toLowerCase() : "";
  const name = typeof rawChoice.name === "string" ? rawChoice.name.trim() : "";
  if (!name) return rawChoice;
  if (!type || type === "function") {
    return { type: "function", function: { name } };
  }
  return rawChoice;
};

const assertAllowedMessageRoles = (messages) => {
  if (!Array.isArray(messages)) return;
  for (const [idx, msg] of messages.entries()) {
    const role = (msg?.role || "").toString().toLowerCase();
    if (!ALLOWED_MESSAGE_ROLES.has(role)) {
      throw new ChatJsonRpcNormalizationError(
        invalidRequestBody(
          `messages[${idx}].role`,
          `unsupported role "${role}"; supported roles are: ${Array.from(
            ALLOWED_MESSAGE_ROLES
          ).join(", ")}`
        )
      );
    }
  }
};

const stripErrorChunks = (text) => {
  if (!text) return "";
  return text.replace(/<errorChunk>[\s\S]*?<\/errorChunk>/gi, "").trim();
};

const buildTranscriptFromMessages = (messages = []) => {
  const relevant = (messages || []).filter((msg) => {
    if (!msg) return false;
    const role = (msg?.role || "user").toString().toLowerCase();
    return role !== "system" && role !== "developer";
  });
  const roles = relevant.map((msg) => (msg?.role || "user").toString().toLowerCase());
  const needsRoleLabels = relevant.length > 1 || roles.some((role) => role !== "user");

  const lines = [];
  for (const msg of relevant) {
    const role = (msg?.role || "user").toString().toLowerCase();
    const raw = flattenMessageContent(msg?.content).trim();
    const cleaned = stripErrorChunks(raw);
    if (!cleaned) continue;
    if (!needsRoleLabels && role === "user") {
      lines.push(cleaned);
      continue;
    }
    let label = role;
    if ((role === "tool" || role === "function") && msg.name) {
      label = `${role}:${String(msg.name).trim()}`;
    }
    lines.push(`[${label}] ${cleaned}`);
  }
  return lines.join("\n");
};

const normalizeReasoningControls = (reasoningEffort, rawReasoning) => {
  let normalizedEffort =
    typeof reasoningEffort === "string" ? reasoningEffort.trim().toLowerCase() : "";

  if (rawReasoning !== undefined) {
    if (rawReasoning === null) {
      normalizedEffort = normalizedEffort || "";
    } else if (typeof rawReasoning !== "object") {
      throw new ChatJsonRpcNormalizationError(
        invalidRequestBody("reasoning", "reasoning must be an object when provided")
      );
    } else if (!normalizedEffort) {
      const effortCandidate =
        typeof rawReasoning.effort === "string" ? rawReasoning.effort.trim().toLowerCase() : "";
      normalizedEffort = effortCandidate;
    }
  }

  if (normalizedEffort && !ALLOWED_REASONING_EFFORTS.has(normalizedEffort)) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody(
        "reasoning.effort",
        `reasoning.effort must be one of: ${Array.from(ALLOWED_REASONING_EFFORTS).join(", ")}`
      )
    );
  }

  let reasoningPayload;
  if (normalizedEffort) {
    reasoningPayload = {
      ...(typeof rawReasoning === "object" ? rawReasoning : {}),
      effort: normalizedEffort,
    };
  }

  return { turnEffort: normalizedEffort || null, reasoningPayload };
};

const normalizeResponseFormat = (responseFormat) => {
  if (responseFormat === undefined) return { responseFormat: undefined, outputSchema: undefined };
  if (responseFormat === null) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("response_format", "response_format must be an object when provided")
    );
  }
  if (typeof responseFormat !== "object") {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("response_format", "response_format must be an object when provided")
    );
  }
  const type =
    typeof responseFormat.type === "string" ? responseFormat.type.trim().toLowerCase() : "";
  if (!type) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody(
        "response_format.type",
        "response_format.type must be provided when response_format is set"
      )
    );
  }
  if (type === "text" || type === "json_object") {
    return { responseFormat: { ...responseFormat, type }, outputSchema: undefined };
  }
  if (type !== "json_schema") {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody(
        "response_format.type",
        'response_format.type must be "text", "json_object", or "json_schema"'
      )
    );
  }

  const schemaContainer = responseFormat.json_schema ?? responseFormat.schema;
  if (!schemaContainer || typeof schemaContainer !== "object") {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody(
        "response_format.json_schema",
        "response_format.json_schema.schema must be an object"
      )
    );
  }
  const schema = schemaContainer.schema ?? schemaContainer;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody(
        "response_format.json_schema.schema",
        "response_format.json_schema.schema must be a JSON object"
      )
    );
  }
  const normalizedSchemaContainer =
    schemaContainer && typeof schemaContainer === "object" && schemaContainer.schema
      ? { ...schemaContainer, schema }
      : { schema };

  return {
    responseFormat: {
      ...responseFormat,
      type: "json_schema",
      json_schema: normalizedSchemaContainer,
    },
    outputSchema: schema,
  };
};

export const normalizeChatJsonRpcRequest = ({
  body = {},
  messages = [],
  prompt = "",
  effectiveModel,
  choiceCount,
  stream = false,
  reasoningEffort = "",
  sandboxMode = "",
  codexWorkdir = "",
  approvalMode = "",
}) => {
  const temperature = toFiniteNumber(body.temperature);
  if (body.temperature !== undefined && temperature === undefined) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("temperature", "temperature must be a finite number between 0 and 2")
    );
  }
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("temperature", "temperature must be between 0 and 2")
    );
  }

  const topP = toFiniteNumber(body.top_p);
  if (body.top_p !== undefined && topP === undefined) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("top_p", "top_p must be a finite number between 0 and 1")
    );
  }
  if (topP !== undefined && (topP <= 0 || topP > 1)) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("top_p", "top_p must be greater than 0 and at most 1")
    );
  }

  const maxOutputTokens = toPositiveInteger(
    body.max_tokens ?? body.max_completion_tokens ?? body.maxOutputTokens
  );
  if (
    (body.max_tokens !== undefined ||
      body.max_completion_tokens !== undefined ||
      body.maxOutputTokens !== undefined) &&
    maxOutputTokens === undefined
  ) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody("max_tokens", "max_tokens must be a positive integer")
    );
  }

  const rawTools = body.tools ?? body.functions;
  const normalizedTools = body.tools === undefined ? normalizeLegacyFunctions(rawTools) : rawTools;
  const definitions = validateTools(normalizedTools);
  const rawToolChoice =
    body.tool_choice ?? body.toolChoice ?? body.function_call ?? body.functionCall;
  const toolChoice = normalizeToolChoice(normalizeLegacyFunctionCall(rawToolChoice), definitions);
  const rawParallelToolCalls = body.parallel_tool_calls ?? body.parallelToolCalls;
  const parallelToolCalls = normalizeParallelToolCalls(rawParallelToolCalls);
  if (
    rawParallelToolCalls !== undefined &&
    parallelToolCalls === undefined &&
    rawParallelToolCalls !== null
  ) {
    throw new ChatJsonRpcNormalizationError(
      invalidRequestBody(
        "parallel_tool_calls",
        "parallel_tool_calls must be a boolean when provided"
      )
    );
  }

  // Always request usage metrics from app-server. Downstream finish-reason
  // reconciliation depends on usage events even when a client opts out.
  const includeUsage = true;

  const promptText = typeof prompt === "string" ? prompt : String(prompt ?? "");

  assertAllowedMessageRoles(messages || []);

  const systemInstructions = IGNORE_CLIENT_SYSTEM_PROMPT
    ? []
    : (messages || [])
        .filter((msg) => {
          const role = (msg?.role || "").toLowerCase();
          return role === "system" || role === "developer";
        })
        .map((msg) => flattenMessageContent(msg?.content).trim())
        .filter(Boolean);

  const baseInstructions =
    !IGNORE_CLIENT_SYSTEM_PROMPT && systemInstructions.length
      ? systemInstructions.join("\n\n")
      : undefined;

  const transcript = buildTranscriptFromMessages(messages || []);
  const fallbackText = flattenMessageContent(promptText).trim() || promptText || "";
  const combinedText = transcript || fallbackText;
  const turnItems = [createUserMessageItem(combinedText)];
  const messageItems = turnItems.map((item) => ({ ...item }));
  const { responseFormat, outputSchema } = normalizeResponseFormat(body.response_format);
  const dynamicTools = buildDynamicTools(definitions, toolChoice);
  const { turnEffort, reasoningPayload } = normalizeReasoningControls(
    reasoningEffort,
    body.reasoning
  );
  const disableInternalTools = CFG.PROXY_DISABLE_INTERNAL_TOOLS_CONFIG;
  const appServerConfig = disableInternalTools
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
    items: turnItems,
    cwd: codexWorkdir,
    approvalPolicy: approvalMode,
    sandboxPolicy: sandboxMode ? { type: sandboxMode } : undefined,
    effort: turnEffort,
    summary: "auto",
    stream: !!stream,
  };

  if (appServerConfig) {
    turn.config = appServerConfig;
  }

  if (Number.isInteger(choiceCount) && choiceCount > 0) {
    turn.choiceCount = choiceCount;
  }

  if (baseInstructions) {
    turn.baseInstructions = baseInstructions;
  }

  if (dynamicTools !== undefined) {
    turn.dynamicTools = dynamicTools;
  }

  if (outputSchema !== undefined) {
    turn.outputSchema = outputSchema;
  }

  const messagePayload = {
    items: messageItems,
    includeUsage,
  };

  if (stream) {
    messagePayload.stream = true;
  }

  if (temperature !== undefined) messagePayload.temperature = temperature;
  if (topP !== undefined) messagePayload.topP = topP;
  if (maxOutputTokens !== undefined) messagePayload.maxOutputTokens = maxOutputTokens;
  if (responseFormat !== undefined) {
    messagePayload.responseFormat = responseFormat;
  }
  if (reasoningPayload !== undefined) {
    messagePayload.reasoning = reasoningPayload;
  }
  if (outputSchema !== undefined) {
    messagePayload.outputSchema = outputSchema;
  }

  return { turn, message: messagePayload };
};

export {
  ChatJsonRpcNormalizationError,
  normalizeParallelToolCalls,
  normalizeResponseFormat,
  normalizeToolChoice,
  validateTools,
};
