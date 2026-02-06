import { nanoid } from "nanoid";

const asTrimmedString = (value) => (typeof value === "string" ? value.trim() : "");

const resolveToolChoice = (toolChoice) => {
  if (typeof toolChoice === "string") {
    const normalized = toolChoice.trim().toLowerCase();
    if (normalized === "none" || normalized === "auto" || normalized === "required") {
      return { mode: normalized, forcedName: "" };
    }
    return { mode: "auto", forcedName: "" };
  }
  if (toolChoice && typeof toolChoice === "object") {
    const name =
      asTrimmedString(toolChoice.name) ||
      asTrimmedString(toolChoice.function?.name) ||
      asTrimmedString(toolChoice.fn?.name);
    if (name) return { mode: "forced", forcedName: name };
  }
  return { mode: "auto", forcedName: "" };
};

const normalizeFunctionTool = (tool) => {
  if (!tool || typeof tool !== "object") return null;
  const rawType = asTrimmedString(tool.type).toLowerCase();
  const fn = tool.function || tool.fn;
  const name = asTrimmedString(fn?.name) || asTrimmedString(tool?.name);
  if (!name) return null;
  if (rawType && rawType !== "function" && !fn) return null;
  return {
    name,
    description: fn?.description ?? tool.description ?? "",
    inputSchema: fn?.parameters ?? tool.parameters ?? {},
  };
};

export const buildDynamicTools = (definitions, toolChoice) => {
  if (!Array.isArray(definitions) || definitions.length === 0) return undefined;
  const choice = resolveToolChoice(toolChoice);
  if (choice.mode === "none") return [];

  const normalized = definitions.map(normalizeFunctionTool).filter(Boolean);
  if (!normalized.length) return undefined;

  if (choice.mode === "forced" && choice.forcedName) {
    const match = normalized.find((tool) => tool.name === choice.forcedName);
    return match ? [match] : [];
  }

  return normalized;
};

const stringifyArguments = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
};

export const buildToolCallDeltaFromDynamicRequest = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  const name = asTrimmedString(payload.tool) || asTrimmedString(payload.name);
  if (!name) return null;
  const callId =
    asTrimmedString(payload.callId) ||
    asTrimmedString(payload.call_id) ||
    asTrimmedString(payload.id) ||
    `dynamic_call_${nanoid(8)}`;

  return {
    tool_calls: [
      {
        id: callId,
        type: "function",
        function: {
          name,
          arguments: stringifyArguments(payload.arguments ?? payload.args ?? payload.input),
        },
      },
    ],
  };
};
