import { invalidRequestBody } from "../../../lib/errors.js";
import {
  normalizeParallelToolCalls,
  normalizeResponseFormat,
  normalizeToolChoice,
  validateTools,
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
  const normalized = String(role || "").trim().toLowerCase();
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
  let textLines = [];

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
  };

  const emitRoleMarkerForImage = (role) => {
    if (textLines.length) {
      flushText();
    }
    items.push({ type: "text", data: { text: `[${role}]` } });
  };

  const emitImage = (role, imageUrl, param) => {
    const url = resolveImageUrl(imageUrl);
    if (!url) {
      throw new ResponsesJsonRpcNormalizationError(
        invalidRequestBody(param, "input_image.image_url must be a string")
      );
    }
    emitRoleMarkerForImage(role);
    items.push({ type: "image", data: { image_url: url } });
  };

  const appendMessageContent = (role, content, baseParam) => {
    if (content === undefined || content === null) {
      pushRoleText(role, "");
      return;
    }
    if (typeof content === "string") {
      pushRoleText(role, content);
      return;
    }
    if (Array.isArray(content)) {
      content.forEach((part, idx) => {
        const param = `${baseParam}.content[${idx}]`;
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
          invalidRequestBody(param, "unsupported content item type")
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
    if (itemType === "function_call_output") {
      const callId = asNonEmptyString(item.call_id);
      if (!callId) {
        throw new ResponsesJsonRpcNormalizationError(
          invalidRequestBody(`input[${index}].call_id`, "call_id is required")
        );
      }
      const output = item.output ?? "";
      const rendered =
        typeof output === "string"
          ? output
          : (() => {
              try {
                return JSON.stringify(output);
              } catch {
                return String(output);
              }
            })();
      pushTextLine(`[tool:${callId}] ${rendered}`.trimEnd());
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

  const instructions = asNonEmptyString(body.instructions);
  if (instructions) {
    pushTextLine(`[system] ${instructions}`);
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

  const { responseFormat, finalOutputJsonSchema } = ensureValidator(() =>
    normalizeResponseFormat(body?.text?.format)
  );
  const tools = ensureValidator(() => validateTools(body.tools));
  const toolChoice = ensureValidator(() => normalizeToolChoice(body.tool_choice, tools));
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

  return {
    instructions,
    inputItems: items,
    responseFormat,
    finalOutputJsonSchema,
    tools,
    toolChoice,
    parallelToolCalls,
    maxOutputTokens: body.max_output_tokens,
  };
};

export { ResponsesJsonRpcNormalizationError };
