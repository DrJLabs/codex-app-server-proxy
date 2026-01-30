import { invalidRequestBody } from "../../../lib/errors.js";
import {
  normalizeParallelToolCalls,
  normalizeResponseFormat,
  normalizeToolChoice,
} from "../../shared/request-validators.js";
import { ChatJsonRpcNormalizationError } from "../../chat/request.js";

class ResponsesJsonRpcNormalizationError extends Error {
  constructor(body, statusCode = 400) {
    super("Responses request normalization failed");
    this.name = "ResponsesJsonRpcNormalizationError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

const SUPPORTED_MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant"]);

const asNonEmptyString = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? trimmed : "";
};

const resolveImageUrl = (value) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.url === "string") {
    return value.url;
  }
  return "";
};

const normalizeRole = (role, param) => {
  const normalized = String(role || "")
    .trim()
    .toLowerCase();
  if (!SUPPORTED_MESSAGE_ROLES.has(normalized)) {
    throw new ResponsesJsonRpcNormalizationError(
      invalidRequestBody(param, "message role must be system, developer, user, or assistant")
    );
  }
  return normalized;
};

const ensureValidator = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ChatJsonRpcNormalizationError) {
      throw new ResponsesJsonRpcNormalizationError(err.body, err.statusCode || 400);
    }
    throw err;
  }
};

const normalizeToolType = (tool) => {
  const rawType = typeof tool?.type === "string" ? tool.type.trim() : "";
  if (rawType) return rawType.toLowerCase();
  if (tool?.function || tool?.fn || typeof tool?.name === "string") return "function";
  return "";
};

const normalizeFunctionTool = (tool, index) => {
  const fn = tool?.function || tool?.fn;
  const fnShape = fn && typeof fn === "object" ? { ...fn } : {};
  const name = asNonEmptyString(fnShape.name) || asNonEmptyString(tool?.name);
  if (!name) {
    throw new ResponsesJsonRpcNormalizationError(
      invalidRequestBody(
        `tools[${index}].function.name`,
        'function definitions must include a non-empty "name"'
      )
    );
  }
  fnShape.name = name;
  if (fnShape.description === undefined && tool?.description !== undefined) {
    fnShape.description = tool.description;
  }
  if (fnShape.parameters === undefined && tool?.parameters !== undefined) {
    fnShape.parameters = tool.parameters;
  }
  if (fnShape.strict === undefined && tool?.strict !== undefined) {
    fnShape.strict = tool.strict;
  }

  const normalized = { ...tool, type: "function", function: fnShape };
  delete normalized.fn;
  if (tool?.function == null && tool?.name !== undefined) delete normalized.name;
  if (tool?.function == null && tool?.description !== undefined) delete normalized.description;
  if (tool?.function == null && tool?.parameters !== undefined) delete normalized.parameters;
  if (tool?.function == null && tool?.strict !== undefined) delete normalized.strict;
  return normalized;
};

const normalizeResponsesTools = (tools) => {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) {
    throw new ResponsesJsonRpcNormalizationError(
      invalidRequestBody("tools", "tools must be an array of definitions")
    );
  }
  const definitions = [];
  for (const [idx, tool] of tools.entries()) {
    if (!tool || typeof tool !== "object") {
      throw new ResponsesJsonRpcNormalizationError(
        invalidRequestBody(`tools[${idx}]`, "tool definition must be an object")
      );
    }
    const type = normalizeToolType(tool);
    if (!type) {
      throw new ResponsesJsonRpcNormalizationError(
        invalidRequestBody(`tools[${idx}].type`, "tool type must be a non-empty string")
      );
    }
    if (type === "function") {
      definitions.push(normalizeFunctionTool(tool, idx));
      continue;
    }
    definitions.push({ ...tool, type });
  }
  return definitions.length ? definitions : undefined;
};

const normalizeResponsesToolChoice = (rawChoice, definitions) => {
  if (!rawChoice || typeof rawChoice !== "object") {
    return ensureValidator(() => normalizeToolChoice(rawChoice, definitions));
  }
  const name = asNonEmptyString(rawChoice.name);
  if (!name) {
    return ensureValidator(() => normalizeToolChoice(rawChoice, definitions));
  }
  const fn = rawChoice.function || rawChoice.fn;
  const fnShape = fn && typeof fn === "object" ? { ...fn } : {};
  if (!asNonEmptyString(fnShape.name)) {
    fnShape.name = name;
  }
  return ensureValidator(() =>
    normalizeToolChoice({ ...rawChoice, function: fnShape }, definitions)
  );
};

const stringifyToolValue = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
};

export const normalizeResponsesRequest = (body = {}) => {
  if (Array.isArray(body.messages)) {
    throw new ResponsesJsonRpcNormalizationError(
      invalidRequestBody("messages", "messages is not supported for /v1/responses")
    );
  }

  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    throw new ResponsesJsonRpcNormalizationError(
      invalidRequestBody("instructions", "instructions must be a string")
    );
  }

  const items = [];
  const developerInstructionsParts = [];
  const toolOutputs = [];
  let textLines = [];
  let lastRoleAnchor = null;

  const flushText = () => {
    if (!textLines.length) return;
    items.push({ type: "text", data: { text: textLines.join("\n") } });
    textLines = [];
  };

  const pushTextLine = (line) => {
    if (typeof line !== "string") return;
    if (!line) return;
    textLines.push(line);
  };

  const pushRoleText = (role, text) => {
    const normalized = text === undefined || text === null ? "" : String(text);
    pushTextLine(`[${role}] ${normalized}`.trimEnd());
    lastRoleAnchor = role;
  };

  const pushDeveloperInstruction = (text) => {
    if (text === undefined || text === null) return;
    const value = String(text).trim();
    if (!value) return;
    developerInstructionsParts.push(value);
  };

  const ensureRoleAnchorForImage = (role) => {
    if (textLines.length) {
      flushText();
    }
    if (lastRoleAnchor !== role) {
      items.push({ type: "text", data: { text: `[${role}]` } });
      lastRoleAnchor = role;
    }
  };

  const emitImage = (role, imageUrl, param) => {
    const url = resolveImageUrl(imageUrl);
    if (!url) {
      throw new ResponsesJsonRpcNormalizationError(
        invalidRequestBody(param, "input_image.image_url must be a string")
      );
    }
    ensureRoleAnchorForImage(role);
    items.push({ type: "image", data: { image_url: url } });
  };

  const appendDeveloperContent = (content, baseParam) => {
    if (content === undefined || content === null) {
      return;
    }
    if (typeof content === "string") {
      pushDeveloperInstruction(content);
      return;
    }
    if (Array.isArray(content)) {
      content.forEach((part) => {
        const param = baseParam;
        if (!part || typeof part !== "object") {
          throw new ResponsesJsonRpcNormalizationError(
            invalidRequestBody(param, "content item must be an object")
          );
        }
        const partType = String(part.type || "").toLowerCase();
        if (partType === "input_text" || partType === "text") {
          pushDeveloperInstruction(part.text ?? part.input_text ?? "");
          return;
        }
        if (partType === "input_image") {
          const url = resolveImageUrl(part.image_url);
          if (!url) {
            throw new ResponsesJsonRpcNormalizationError(
              invalidRequestBody(param, "input_image.image_url must be a string")
            );
          }
          pushDeveloperInstruction(`[image_url] ${url}`);
          return;
        }
        throw new ResponsesJsonRpcNormalizationError(
          invalidRequestBody(param, "unsupported input item type")
        );
      });
      return;
    }
    if (content && typeof content === "object") {
      if (typeof content.text === "string") {
        pushDeveloperInstruction(content.text);
        return;
      }
    }
    pushDeveloperInstruction(String(content));
  };

  const appendMessageContent = (role, content, baseParam) => {
    if (role === "system" || role === "developer") {
      appendDeveloperContent(content, baseParam);
      return;
    }
    if (content === undefined || content === null) {
      pushRoleText(role, "");
      return;
    }
    if (typeof content === "string") {
      pushRoleText(role, content);
      return;
    }
    if (Array.isArray(content)) {
      content.forEach((part) => {
        const param = baseParam;
        if (!part || typeof part !== "object") {
          throw new ResponsesJsonRpcNormalizationError(
            invalidRequestBody(param, "content item must be an object")
          );
        }
        const partType = String(part.type || "").toLowerCase();
        if (partType === "input_text" || partType === "text") {
          pushRoleText(role, part.text ?? part.input_text ?? "");
          return;
        }
        if (partType === "input_image") {
          emitImage(role, part.image_url, param);
          return;
        }
        throw new ResponsesJsonRpcNormalizationError(
          invalidRequestBody(param, "unsupported input item type")
        );
      });
      return;
    }
    if (content && typeof content === "object") {
      if (typeof content.text === "string") {
        pushRoleText(role, content.text);
        return;
      }
    }
    pushRoleText(role, String(content));
  };

  const appendInputItem = (item, index) => {
    if (!item || typeof item !== "object") {
      throw new ResponsesJsonRpcNormalizationError(
        invalidRequestBody(`input[${index}]`, "input item must be an object")
      );
    }
    const itemType = String(item.type || "").toLowerCase();
    if (itemType === "message") {
      const role = normalizeRole(item.role, `input[${index}].role`);
      appendMessageContent(role, item.content, `input[${index}]`);
      return;
    }
    if (itemType === "function_call_output" || itemType === "tool_output") {
      const callId =
        asNonEmptyString(item.call_id) ||
        asNonEmptyString(item.callId) ||
        asNonEmptyString(item.id);
      if (!callId) {
        throw new ResponsesJsonRpcNormalizationError(
          invalidRequestBody(`input[${index}].call_id`, "call_id is required")
        );
      }
      const output = stringifyToolValue(
        item.output ?? item.content ?? item.content_items ?? item.value ?? ""
      );
      const success = typeof item.success === "boolean" ? item.success : item.error ? false : true;
      const toolName =
        asNonEmptyString(item.name) ||
        asNonEmptyString(item.tool_name) ||
        asNonEmptyString(item.toolName) ||
        asNonEmptyString(item.function?.name) ||
        null;
      toolOutputs.push({ callId, output, success, toolName });
      pushTextLine(`[function_call_output call_id=${callId} output=${output}]`);
      return;
    }
    if (itemType === "function_call") {
      const itemId = asNonEmptyString(item.id) || asNonEmptyString(item.call_id) || `call_${index}`;
      const callId = asNonEmptyString(item.call_id) || itemId;
      const name = asNonEmptyString(item.name) || asNonEmptyString(item.function?.name) || callId;
      const argumentsText = stringifyToolValue(item.arguments ?? item.function?.arguments ?? "");
      pushTextLine(
        `[function_call id=${itemId} call_id=${callId} name=${name} arguments=${argumentsText}]`
      );
      return;
    }
    if (itemType === "input_text") {
      pushRoleText("user", item.text ?? "");
      return;
    }
    if (itemType === "input_image") {
      emitImage("user", item.image_url, `input[${index}]`);
      return;
    }
    throw new ResponsesJsonRpcNormalizationError(
      invalidRequestBody(`input[${index}]`, "unsupported input item type")
    );
  };

  const { responseFormat, outputSchema } = ensureValidator(() =>
    normalizeResponseFormat(body?.text?.format)
  );
  const tools = normalizeResponsesTools(body.tools);
  const toolChoiceProvided = Object.prototype.hasOwnProperty.call(body, "tool_choice");
  let toolChoice = normalizeResponsesToolChoice(body.tool_choice, tools);
  if (!toolChoiceProvided && toolChoice === undefined && Array.isArray(tools) && tools.length) {
    toolChoice = "auto";
  }
  const rawParallelToolCalls = body.parallel_tool_calls;
  const parallelToolCalls = ensureValidator(() => normalizeParallelToolCalls(rawParallelToolCalls));
  if (
    rawParallelToolCalls !== undefined &&
    rawParallelToolCalls !== null &&
    parallelToolCalls === undefined
  ) {
    throw new ResponsesJsonRpcNormalizationError(
      invalidRequestBody("parallel_tool_calls", "parallel_tool_calls must be a boolean")
    );
  }

  const instructions = asNonEmptyString(body.instructions);
  if (instructions) {
    pushDeveloperInstruction(instructions);
  }

  if (body.input === undefined) {
    // No input, only instructions (if provided).
  } else if (typeof body.input === "string") {
    pushRoleText("user", body.input);
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item, idx) => appendInputItem(item, idx));
  } else {
    throw new ResponsesJsonRpcNormalizationError(
      invalidRequestBody("input", "input must be a string or an array of items")
    );
  }

  flushText();

  const developerInstructions = developerInstructionsParts.length
    ? developerInstructionsParts.join("\n\n")
    : undefined;

  return {
    instructions,
    developerInstructions,
    inputItems: items,
    responseFormat,
    outputSchema,
    tools,
    toolChoice,
    parallelToolCalls,
    maxOutputTokens: body.max_output_tokens,
    toolOutputs,
  };
};

export { ResponsesJsonRpcNormalizationError };
