import { nanoid } from "nanoid";
import { logStructured } from "../../../services/logging/schema.js";
import { normalizeMessageId, normalizeResponseId } from "../shared.js";

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

const normalizeFunctionArguments = (args) => {
  if (typeof args === "string") return args;
  if (args === undefined) return "";
  try {
    return JSON.stringify(args ?? "");
  } catch (error) {
    logStructured(
      { component: "responses.native", event: "function_call_arguments_coerce", level: "warn" },
      {
        type: typeof args,
        message: error?.message,
      }
    );
    return String(args ?? "");
  }
};

const buildMessageOutputItem = ({ messageId, role, text }) => {
  const resolvedMessageId = normalizeMessageId(messageId);
  return {
    id: resolvedMessageId,
    type: "message",
    role: role || "assistant",
    content: [{ type: "output_text", text: text ?? "" }],
  };
};

const buildFunctionCallOutputItems = (functionCalls = []) => {
  if (!Array.isArray(functionCalls) || !functionCalls.length) return [];
  return functionCalls.map((call, index) => {
    const id = call?.id || call?.call_id || `call_${index}_${nanoid()}`;
    const callId = call?.call_id || id;
    const name = call?.function?.name || call?.name || id;
    const args = call?.function?.arguments ?? call?.arguments;
    return {
      id,
      call_id: callId,
      type: "function_call",
      name,
      arguments: normalizeFunctionArguments(args),
    };
  });
};

export const buildResponsesEnvelope = ({
  responseId,
  messageId,
  created,
  model,
  outputText,
  functionCalls,
  usage,
  status,
}) => {
  const resolvedResponseId = normalizeResponseId(responseId);
  const resolvedCreated = created ?? Math.floor(Date.now() / 1000);
  const output = [
    buildMessageOutputItem({ messageId, role: "assistant", text: outputText }),
    ...buildFunctionCallOutputItems(functionCalls),
  ];

  const payload = {
    id: resolvedResponseId,
    object: "response",
    created: resolvedCreated,
    status: status || "completed",
    model,
    output,
  };

  const mappedUsage = mapUsage(usage);
  if (mappedUsage) payload.usage = mappedUsage;

  return payload;
};
