import { parseStreamEventLine } from "../../chat/stream-event.js";
import { createStreamEventRouter } from "../../chat/stream-event-router.js";

const toText = (chunk) => {
  if (typeof chunk === "string") return chunk;
  if (chunk && typeof chunk.toString === "function") return chunk.toString("utf8");
  return "";
};

const iterateStdoutLines = (stdout) => {
  const emitter = stdout;
  if (!emitter || typeof emitter.on !== "function") {
    return (async function* empty() {})();
  }

  let buffer = "";
  let queue = [];
  let done = false;
  let notify = null;

  const flush = () => {
    if (notify) {
      notify();
      notify = null;
    }
  };

  const onData = (chunk) => {
    buffer += toText(chunk);
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      queue.push(line);
    }
    flush();
  };

  const onEnd = () => {
    if (buffer) {
      queue.push(buffer);
      buffer = "";
    }
    done = true;
    flush();
  };

  emitter.on("data", onData);
  emitter.on("end", onEnd);
  emitter.on("close", onEnd);
  emitter.on("error", onEnd);

  return (async function* iterator() {
    try {
      while (!done || queue.length) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        await new Promise((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      emitter.off?.("data", onData);
      emitter.off?.("end", onEnd);
      emitter.off?.("close", onEnd);
      emitter.off?.("error", onEnd);
    }
  })();
};

const extractTextParts = (value) => {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (typeof value.text === "string") return [value.text];
  if (typeof value.content === "string") return [value.content];
  if (Array.isArray(value.content)) {
    return value.content.flatMap((part) => extractTextParts(part));
  }
  return [];
};

const handleDeltaPayload = (delta, choiceIndex, emitEvent, metadataInfo) => {
  if (typeof delta === "string") {
    emitEvent({ type: "text_delta", delta, choiceIndex, metadataInfo });
    return;
  }
  if (!delta || typeof delta !== "object") return;

  const contentParts = [];
  if (typeof delta.content === "string") contentParts.push(delta.content);
  if (Array.isArray(delta.content)) {
    delta.content.forEach((part) => {
      contentParts.push(...extractTextParts(part));
    });
  }
  if (typeof delta.text === "string") contentParts.push(delta.text);
  contentParts.forEach((part) => {
    if (typeof part === "string" && part.length) {
      emitEvent({ type: "text_delta", delta: part, choiceIndex, metadataInfo });
    }
  });

  const toolCalls = delta.tool_calls || delta.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    emitEvent({ type: "tool_calls_delta", tool_calls: toolCalls, choiceIndex });
  }

  const functionCall = delta.function_call || delta.functionCall;
  if (functionCall && typeof functionCall === "object") {
    emitEvent({ type: "function_call_delta", function_call: functionCall, choiceIndex });
  }
};

const handleMessagePayload = (messagePayload, choiceIndex, emitEvent, metadataInfo) => {
  const message = messagePayload?.message || messagePayload;
  if (!message || typeof message !== "object") return;

  const contentParts = extractTextParts(message.content);
  contentParts.forEach((part) => {
    if (typeof part === "string" && part.length) {
      emitEvent({ type: "text", text: part, choiceIndex, metadataInfo });
    }
  });

  const toolCalls = message.tool_calls || message.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    emitEvent({ type: "tool_calls", tool_calls: toolCalls, choiceIndex });
  }

  const functionCall = message.function_call || message.functionCall;
  if (functionCall && typeof functionCall === "object") {
    emitEvent({ type: "function_call", function_call: functionCall, choiceIndex });
  }
};

export const runNativeResponses = async ({
  adapter,
  onEvent,
  sanitizeMetadata = false,
  extractMetadataFromPayload,
} = {}) => {
  const emitEvent = typeof onEvent === "function" ? onEvent : () => {};
  const usageCounts = { prompt: null, completion: null };
  let finishReason = null;
  let finishTrigger = null;

  const parseLine = (line) =>
    parseStreamEventLine(line, { extractMetadataFromPayload, sanitizeMetadata });

  const updateUsageCounts = (_source, counts) => {
    if (Number.isFinite(counts?.prompt)) usageCounts.prompt = counts.prompt;
    if (Number.isFinite(counts?.completion)) usageCounts.completion = counts.completion;
    if (usageCounts.prompt !== null || usageCounts.completion !== null) {
      const usage = {
        prompt_tokens: usageCounts.prompt ?? undefined,
        completion_tokens: usageCounts.completion ?? undefined,
      };
      if (usage.prompt_tokens != null && usage.completion_tokens != null) {
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      }
      emitEvent({ type: "usage", usage, source: _source });
    }
  };

  const eventRouter = createStreamEventRouter({
    parseStreamEventLine: parseLine,
    handleParsedEvent: (parsed) => {
      const choiceIndex = Number.isInteger(parsed?.baseChoiceIndex) ? parsed.baseChoiceIndex : 0;
      const metadataInfo = parsed?.metadataInfo ?? null;
      if (parsed.type === "agent_message_delta" || parsed.type === "agent_message_content_delta") {
        handleDeltaPayload(parsed.messagePayload?.delta, choiceIndex, emitEvent, metadataInfo);
        return;
      }
      if (parsed.type === "agent_message") {
        handleMessagePayload(parsed.messagePayload, choiceIndex, emitEvent, metadataInfo);
      }
    },
    extractFinishReasonFromMessage: (messagePayload) =>
      messagePayload?.finish_reason || messagePayload?.finishReason || null,
    updateUsageCounts,
    shouldDropFunctionCallOutput: () => true,
    finalizeStream: ({ reason, trigger } = {}) => {
      finishReason = reason || null;
      finishTrigger = trigger || null;
      emitEvent({ type: "finish", reason: finishReason, trigger: finishTrigger });
    },
  });

  const iter =
    adapter && typeof adapter.iterStdoutLines === "function"
      ? adapter.iterStdoutLines()
      : iterateStdoutLines(adapter?.stdout);

  for await (const line of iter) {
    const result = eventRouter.handleLine(line);
    if (result?.stop) break;
  }

  return { finishReason, finishTrigger, usage: usageCounts };
};
