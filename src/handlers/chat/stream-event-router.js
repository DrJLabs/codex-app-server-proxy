import { buildToolCallDeltaFromDynamicRequest } from "../../lib/tools/dynamic-tools.js";

export const createStreamEventRouter = ({
  parseStreamEventLine,
  extractMetadataFromPayload,
  sanitizeMetadata = false,
  appendProtoEvent,
  reqId,
  route = "/v1/chat/completions",
  mode = "chat_stream",
  dynamicToolCallMode = "delta",
  handleParsedEvent,
  trackToolSignals,
  extractFinishReasonFromMessage,
  trackFinishReason,
  updateUsageCounts,
  mergeMetadataInfo,
  recordSanitizedMetadata,
  shouldDropFunctionCallOutput,
  getUsageTrigger,
  markUsageTriggerIfMissing,
  hasAnyChoiceSent,
  hasLengthEvidence,
  emitFinishChunk,
  finalizeStream,
} = {}) => {
  const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);
  const resolveTokenCounts = (promptCandidates, completionCandidates) => ({
    promptTokens: Number(firstDefined(...promptCandidates)),
    completionTokens: Number(firstDefined(...completionCandidates)),
  });

  const handleLine = (line) => {
    const parsed = parseStreamEventLine?.(line, {
      extractMetadataFromPayload,
      sanitizeMetadata,
    });
    if (!parsed) return { handled: false };
    const { type: t, payload, params, messagePayload, metadataInfo } = parsed;
    const canTrackFinish = typeof trackFinishReason === "function";
    if (typeof appendProtoEvent === "function") {
      appendProtoEvent({
        ts: Date.now(),
        req_id: reqId,
        route,
        mode,
        kind: "event",
        event: payload,
      });
    }
    if (messagePayload) {
      if (typeof trackToolSignals === "function") trackToolSignals(messagePayload);
      const finishCandidate =
        typeof extractFinishReasonFromMessage === "function"
          ? extractFinishReasonFromMessage(messagePayload)
          : null;
      if (finishCandidate && canTrackFinish) {
        trackFinishReason(finishCandidate, t || "event");
      }
    }
    if (t === "dynamic_tool_call_request") {
      const toolCallDelta = buildToolCallDeltaFromDynamicRequest(messagePayload);
      if (toolCallDelta && typeof trackToolSignals === "function") {
        trackToolSignals(toolCallDelta);
      }
      if (toolCallDelta && typeof handleParsedEvent === "function") {
        if (dynamicToolCallMode === "atomic") {
          handleParsedEvent({
            type: "dynamic_tool_call",
            payload,
            params,
            messagePayload,
            metadataInfo,
            toolCallDelta,
            baseChoiceIndex: parsed.baseChoiceIndex,
          });
        } else {
          handleParsedEvent({
            type: "agent_message_delta",
            payload,
            params,
            messagePayload: { delta: toolCallDelta },
            metadataInfo,
            baseChoiceIndex: parsed.baseChoiceIndex,
          });
        }
      }
      return { handled: true };
    }
    if (
      t === "agent_message_content_delta" ||
      t === "agent_message_delta" ||
      t === "agent_message"
    ) {
      if (typeof handleParsedEvent === "function") handleParsedEvent(parsed);
      return { handled: true };
    }
    if (t === "function_call_output") {
      if (typeof shouldDropFunctionCallOutput === "function") {
        if (shouldDropFunctionCallOutput(messagePayload)) return { handled: true };
      }
    } else if (t === "metadata") {
      if (sanitizeMetadata && metadataInfo) {
        if (typeof mergeMetadataInfo === "function") mergeMetadataInfo(metadataInfo);
        if (typeof recordSanitizedMetadata === "function") {
          recordSanitizedMetadata({
            stage: "metadata_event",
            eventType: t,
            metadata: metadataInfo.metadata,
            removed: [],
            sources: metadataInfo.sources,
          });
        }
      }
    } else if (t === "token_count") {
      const { promptTokens, completionTokens } = resolveTokenCounts(
        [
          messagePayload?.prompt_tokens,
          messagePayload?.promptTokens,
          messagePayload?.token_count?.prompt_tokens,
          params?.prompt_tokens,
          params?.promptTokens,
          params?.token_count?.prompt_tokens,
        ],
        [
          messagePayload?.completion_tokens,
          messagePayload?.completionTokens,
          messagePayload?.token_count?.completion_tokens,
          params?.completion_tokens,
          params?.completionTokens,
          params?.token_count?.completion_tokens,
        ]
      );
      if (typeof updateUsageCounts === "function") {
        updateUsageCounts("token_count", { prompt: promptTokens, completion: completionTokens });
      }
      const tokenFinishReason =
        typeof extractFinishReasonFromMessage === "function"
          ? extractFinishReasonFromMessage(messagePayload)
          : null;
      if (tokenFinishReason && canTrackFinish) {
        trackFinishReason(tokenFinishReason, "token_count");
      }
    } else if (t === "usage") {
      const { promptTokens, completionTokens } = resolveTokenCounts(
        [
          messagePayload?.prompt_tokens,
          messagePayload?.usage?.prompt_tokens,
          params?.usage?.prompt_tokens,
          params?.prompt_tokens,
          params?.promptTokens,
          params?.token_count?.prompt_tokens,
        ],
        [
          messagePayload?.completion_tokens,
          messagePayload?.usage?.completion_tokens,
          params?.usage?.completion_tokens,
          params?.completion_tokens,
          params?.completionTokens,
          params?.token_count?.completion_tokens,
        ]
      );
      if (typeof updateUsageCounts === "function") {
        updateUsageCounts(
          "provider",
          { prompt: promptTokens, completion: completionTokens },
          { provider: true }
        );
      }
    } else if (t === "task_complete") {
      const finishReason =
        typeof extractFinishReasonFromMessage === "function"
          ? extractFinishReasonFromMessage(messagePayload)
          : null;
      if (canTrackFinish) {
        if (finishReason) {
          trackFinishReason(finishReason, "task_complete");
        } else if (typeof hasAnyChoiceSent === "function" && !hasAnyChoiceSent()) {
          trackFinishReason("length", "task_complete");
        } else if (typeof hasLengthEvidence === "function" && hasLengthEvidence()) {
          trackFinishReason("length", "task_complete");
        }
      }
      const { promptTokens, completionTokens } = resolveTokenCounts(
        [
          messagePayload?.prompt_tokens,
          messagePayload?.token_count?.prompt_tokens,
          params?.token_count?.prompt_tokens,
          params?.prompt_tokens,
          params?.promptTokens,
        ],
        [
          messagePayload?.completion_tokens,
          messagePayload?.token_count?.completion_tokens,
          params?.token_count?.completion_tokens,
          params?.completion_tokens,
          params?.completionTokens,
        ]
      );
      const usageTrigger = typeof getUsageTrigger === "function" ? getUsageTrigger() : null;
      if (Number.isFinite(promptTokens) || Number.isFinite(completionTokens)) {
        if (typeof updateUsageCounts === "function") {
          updateUsageCounts(usageTrigger || "task_complete", {
            prompt: promptTokens,
            completion: completionTokens,
          });
        }
      } else if (typeof markUsageTriggerIfMissing === "function") {
        markUsageTriggerIfMissing("task_complete");
      }
      if (typeof emitFinishChunk === "function") emitFinishChunk(finishReason || undefined);
      if (typeof finalizeStream === "function") {
        finalizeStream({ reason: finishReason, trigger: usageTrigger || "task_complete" });
      }
      return { handled: true, stop: true };
    }
    return { handled: true };
  };

  return { handleLine };
};
