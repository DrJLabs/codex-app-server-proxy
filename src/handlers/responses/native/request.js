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

const formatToolSchema = (schema) => {
  if (schema === undefined) return "{}";
  if (schema === null) return "null";
  try {
    return JSON.stringify(schema);
  } catch {
    return String(schema);
  }
};

const collectFunctionTools = (tools) => {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => String(tool?.type || "").toLowerCase() === "function")
    .map((tool) => {
      const fn = tool?.function || tool?.fn;
      const name = asNonEmptyString(fn?.name) || asNonEmptyString(tool?.name);
      if (!name) return null;
      return {
        name,
        description: fn?.description ?? tool?.description,
        parameters: fn?.parameters ?? tool?.parameters,
        strict: fn?.strict ?? tool?.strict,
      };
    })
    .filter(Boolean);
};

const resolveForcedToolChoiceName = (toolChoice) => {
  if (!toolChoice || typeof toolChoice !== "object") return "";
  return asNonEmptyString(toolChoice.function?.name) || asNonEmptyString(toolChoice.name);
};

const buildToolInjectionText = (tools, toolChoice) => {
  const functionTools = collectFunctionTools(tools);
  if (!functionTools.length) return "";

  const lines = [];
  lines.push("Tool calling instructions:");
  lines.push("Only emit tool calls using <tool_call>...</tool_call>.");
  lines.push('Format: <tool_call>{"name":"TOOL_NAME","arguments":"{...}"}</tool_call>');
  lines.push(
    'Inside <tool_call>...</tool_call>, output ONLY a JSON object with keys "name" and "arguments".'
  );
  lines.push("Always emit <tool_call> blocks exactly as shown; the client executes them.");
  lines.push(
    "Do NOT call internal tools directly (shell, apply_patch, web_search, view_image); only emit <tool_call>."
  );
  lines.push(
    "Read-only sandbox or approval restrictions do NOT prevent emitting <tool_call> output."
  );
  lines.push("Use EXACT parameter names from the schema; do NOT invent or rename keys.");
  lines.push(
    'Do not add any extra characters before or after the JSON (no trailing ">", no code fences).'
  );
  lines.push("Use exactly one opening <tool_call> and one closing </tool_call> tag.");
  lines.push("Output must be valid JSON. Do not add extra braces or trailing characters.");
  lines.push('Do NOT wrap the JSON object in an array (no leading "[" or trailing "]").');
  lines.push('Bad: <tool_call>[{"name":"tool","arguments":"{...}"}]</tool_call>');
  lines.push("Never repeat the closing tag.");
  lines.push(
    'Example (exact): <tool_call>{"name":"webSearch","arguments":"{\\"query\\":\\"example\\",\\"chatHistory\\":[]}"}</tool_call>'
  );
  lines.push('The "arguments" field must be a JSON string.');
  lines.push('If a tool has no parameters, use arguments "{}".');
  lines.push("If no tool is needed, respond with plain text.");

  if (toolChoice === "none") {
    lines.push("Tool choice is none: never emit <tool_call>.");
  } else if (toolChoice === "required") {
    lines.push("Tool choice is required: you MUST emit at least one <tool_call>.");
  } else {
    const forcedName = resolveForcedToolChoiceName(toolChoice);
    if (forcedName) {
      lines.push(`Tool choice is forced: you MUST call "${forcedName}".`);
    }
  }

  const strictTools = functionTools.filter((tool) => tool.strict === true).map((tool) => tool.name);
  if (strictTools.length) {
    lines.push(
      `Strict tools: ${strictTools.join(", ")}. Arguments MUST conform exactly to schema.`
    );
  }

  lines.push("Available tools (schema):");
  functionTools.forEach((tool) => {
    lines.push(`- ${tool.name}: ${formatToolSchema(tool.parameters)}`);
  });

  const sanitizeSchema = (schema) => {
    if (schema && typeof schema === "object") {
      if (Array.isArray(schema.oneOf) && schema.oneOf.length) return schema.oneOf[0];
      if (Array.isArray(schema.anyOf) && schema.anyOf.length) return schema.anyOf[0];
      if (Array.isArray(schema.allOf) && schema.allOf.length) return schema.allOf[0];
    }
    return schema;
  };

  const resolveSchemaType = (schema) => {
    if (!schema || typeof schema !== "object") return "unknown";
    const normalized = sanitizeSchema(schema) || {};
    const type = normalized.type;
    if (Array.isArray(type) && type.length) return type.join("|");
    if (typeof type === "string" && type) return type;
    if (normalized.properties) return "object";
    if (normalized.items) return "array";
    return "unknown";
  };

  const summarizeSchemaParameters = (schema) => {
    const normalized = sanitizeSchema(schema);
    if (!normalized || typeof normalized !== "object") {
      return ["- (no parameters)"];
    }
    if (normalized.type !== "object" && !normalized.properties) {
      return [`- (schema) ${formatToolSchema(normalized)}`];
    }
    const props = normalized.properties || {};
    const propKeys = Object.keys(props);
    if (!propKeys.length) {
      return ["- (no parameters)"];
    }
    const required = new Set(Array.isArray(normalized.required) ? normalized.required : []);
    return propKeys.map((key) => {
      // Keys come from Object.keys(props); safe for controlled schema objects.
      // eslint-disable-next-line security/detect-object-injection
      const propSchema = sanitizeSchema(props[key]) || {};
      const requirement = required.has(key) ? "required" : "optional";
      const type = resolveSchemaType(propSchema);
      const description = asNonEmptyString(propSchema.description);
      const suffix = description ? `: ${description}` : "";
      return `- ${key} (${requirement}, ${type})${suffix}`;
    });
  };

  const exampleForSchema = (schema, depth = 0) => {
    if (depth > 2) return "example";
    if (!schema || typeof schema !== "object") return "example";
    if (schema.default !== undefined) return schema.default;
    if (schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    const normalized = sanitizeSchema(schema) || {};
    const type = normalized.type;
    if (Array.isArray(type) && type.length) {
      const first = type.find((entry) => entry !== "null") ?? type[0];
      return exampleForSchema({ ...normalized, type: first }, depth);
    }
    if (type === "array") {
      const itemExample = exampleForSchema(normalized.items || {}, depth + 1);
      return itemExample === undefined ? [] : [itemExample];
    }
    if (type === "object" || normalized.properties) {
      const props = normalized.properties || {};
      const example = {};
      Object.keys(props).forEach((key) => {
        // Keys come from Object.keys(props); safe for controlled schema objects.
        // eslint-disable-next-line security/detect-object-injection
        example[key] = exampleForSchema(props[key], depth + 1);
      });
      return example;
    }
    if (type === "integer" || type === "number") return 0;
    if (type === "boolean") return false;
    if (type === "null") return null;
    return "example";
  };

  const escapeExample = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  lines.push("Per-tool guidance and examples (schema-conformant):");
  functionTools.forEach((tool) => {
    const exampleArgs = JSON.stringify(exampleForSchema(tool.parameters) ?? {});
    lines.push(`Tool: ${tool.name}`);
    if (asNonEmptyString(tool.description)) {
      lines.push(`Description: ${tool.description}`);
    }
    lines.push("Parameters:");
    summarizeSchemaParameters(tool.parameters).forEach((line) => lines.push(line));
    lines.push("Example tool_call:");
    lines.push(
      `<tool_call>{"name":"${tool.name}","arguments":"${escapeExample(exampleArgs)}"}</tool_call>`
    );
  });

  return lines.join("\n");
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
    if (itemType === "function_call_output") {
      const callId = asNonEmptyString(item.call_id);
      if (!callId) {
        throw new ResponsesJsonRpcNormalizationError(
          invalidRequestBody(`input[${index}].call_id`, "call_id is required")
        );
      }
      const output = stringifyToolValue(item.output ?? "");
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

  const { responseFormat, finalOutputJsonSchema } = ensureValidator(() =>
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

  const toolInjection = buildToolInjectionText(tools, toolChoice);
  if (toolInjection) {
    pushDeveloperInstruction(toolInjection);
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
    finalOutputJsonSchema,
    tools,
    toolChoice,
    parallelToolCalls,
    maxOutputTokens: body.max_output_tokens,
  };
};

export { ResponsesJsonRpcNormalizationError };
