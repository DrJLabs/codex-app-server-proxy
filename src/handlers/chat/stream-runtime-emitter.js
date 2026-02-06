export const createStreamRuntimeEmitter = ({
  sanitizeMetadata = false,
  coerceAssistantContent,
  toolCallAggregator,
  ensureChoiceState,
  isObsidianOutput,
  hasTextualToolPrefix,
  emitAggregatorToolContent,
  sendChoiceDelta,
  cloneToolCallDelta,
  logProto = false,
  appendProtoEvent,
  reqId,
  enqueueSanitizedSegment,
  mergeMetadataInfo,
  applyMetadataSanitizer,
  appendContentSegment,
  emitTextualToolMetadata,
  scheduleStopAfterTools,
  markHasToolCalls,
} = {}) => {
  const emitDeltaFromRuntime = ({ choiceIndex, deltaPayload, metadataInfo, eventType }) => {
    if (typeof deltaPayload === "string") {
      if (sanitizeMetadata) {
        enqueueSanitizedSegment(
          deltaPayload,
          metadataInfo,
          {
            stage: "agent_message_delta",
            eventType,
          },
          { choiceIndex }
        );
      } else if (deltaPayload) {
        appendContentSegment(deltaPayload, { choiceIndex });
      }
    } else if (deltaPayload && typeof deltaPayload === "object") {
      const textDelta = coerceAssistantContent(deltaPayload.content ?? deltaPayload.text ?? "");
      const { deltas, updated } = toolCallAggregator.ingestDelta(deltaPayload, {
        choiceIndex,
      });
      if (updated) {
        markHasToolCalls();
        const state = ensureChoiceState(choiceIndex);
        state.hasToolEvidence = true;
        if (!isObsidianOutput) state.dropAssistantContentAfterTools = true;
        const snapshot = toolCallAggregator.snapshot({ choiceIndex });
        state.structuredCount = snapshot.length;
        for (const toolDelta of deltas) {
          if (logProto) {
            appendProtoEvent({
              ts: Date.now(),
              req_id: reqId,
              route: "/v1/chat/completions",
              mode: "chat_stream",
              kind: "tool_call_delta",
              event: toolDelta,
            });
          }
          state.hasToolEvidence = true;
          sendChoiceDelta(choiceIndex, {
            tool_calls: [cloneToolCallDelta(toolDelta)],
          });
        }
        if (!isObsidianOutput || state.textualToolContentSeen) {
          state.forwardedToolCount = snapshot.length;
          // FIX: Explicitly schedule stop for native JSON mode since aggregator is bypassed
          scheduleStopAfterTools(choiceIndex);
        } else if (!hasTextualToolPrefix(state, textDelta)) {
          emitAggregatorToolContent(choiceIndex, snapshot);
        }
      }
      if (sanitizeMetadata) {
        enqueueSanitizedSegment(
          textDelta,
          metadataInfo,
          {
            stage: "agent_message_delta",
            eventType,
          },
          { choiceIndex }
        );
      } else if (textDelta) {
        appendContentSegment(textDelta, { choiceIndex });
      }
    }
  };

  const emitMessageFromRuntime = ({ choiceIndex, finalMessage, metadataInfo, eventType }) => {
    if (typeof finalMessage === "string") {
      const rawMessage = finalMessage;
      if (rawMessage) {
        if (emitTextualToolMetadata(choiceIndex, rawMessage)) {
          const state = ensureChoiceState(choiceIndex);
          state.hasToolEvidence = true;
        }
        let aggregatedInfo = null;
        if (sanitizeMetadata) {
          enqueueSanitizedSegment(
            "",
            metadataInfo,
            {
              stage: "agent_message",
              eventType,
            },
            { flush: true, choiceIndex }
          );
          aggregatedInfo = mergeMetadataInfo(null);
        }
        const sanitizedMessage = sanitizeMetadata
          ? applyMetadataSanitizer(rawMessage, aggregatedInfo, {
              stage: "agent_message",
              eventType,
            })
          : rawMessage;
        if (sanitizedMessage) {
          let suffix = "";
          const state = ensureChoiceState(choiceIndex);
          if (sanitizedMessage.startsWith(state.emitted)) {
            suffix = sanitizedMessage.slice(state.emitted.length);
          } else if (!state.sentAny) {
            suffix = sanitizedMessage;
          }
          if (suffix) appendContentSegment(suffix, { choiceIndex });
          else if (sanitizeMetadata) scheduleStopAfterTools(choiceIndex);
        } else if (sanitizeMetadata) {
          scheduleStopAfterTools(choiceIndex);
        }
      }
    } else if (finalMessage && typeof finalMessage === "object") {
      const { deltas, updated } = toolCallAggregator.ingestMessage(finalMessage, {
        emitIfMissing: true,
        choiceIndex,
      });
      const state = ensureChoiceState(choiceIndex);
      if (updated) {
        markHasToolCalls();
        state.hasToolEvidence = true;
        if (!isObsidianOutput) state.dropAssistantContentAfterTools = true;
        for (const toolDelta of deltas) {
          if (logProto) {
            appendProtoEvent({
              ts: Date.now(),
              req_id: reqId,
              route: "/v1/chat/completions",
              mode: "chat_stream",
              kind: "tool_call_delta",
              event: toolDelta,
              source: "agent_message",
            });
          }
          sendChoiceDelta(choiceIndex, {
            tool_calls: [cloneToolCallDelta(toolDelta)],
          });
        }
      }
      if (toolCallAggregator.hasCalls()) markHasToolCalls();
      const snapshot = toolCallAggregator.snapshot({ choiceIndex });
      state.structuredCount = snapshot.length;
      const text = coerceAssistantContent(finalMessage.content ?? finalMessage.text ?? "");
      if (!isObsidianOutput || state.textualToolContentSeen) {
        state.forwardedToolCount = snapshot.length;
        // FIX: Explicitly schedule stop for native JSON mode since aggregator is bypassed
        scheduleStopAfterTools(choiceIndex);
      } else if (!hasTextualToolPrefix(state, text)) {
        emitAggregatorToolContent(choiceIndex, snapshot);
      }
      let aggregatedInfo = null;
      if (sanitizeMetadata) {
        enqueueSanitizedSegment(
          "",
          metadataInfo,
          {
            stage: "agent_message",
            eventType,
          },
          { flush: true, choiceIndex }
        );
        aggregatedInfo = mergeMetadataInfo(null);
      }
      const sanitizedText = sanitizeMetadata
        ? applyMetadataSanitizer(text, aggregatedInfo, {
            stage: "agent_message",
            eventType,
          })
        : text;
      if (sanitizedText) {
        let suffix = "";
        const state = ensureChoiceState(choiceIndex);
        if (sanitizedText.startsWith(state.emitted)) {
          suffix = sanitizedText.slice(state.emitted.length);
        } else if (!state.sentAny) {
          suffix = sanitizedText;
        }
        if (suffix) appendContentSegment(suffix, { choiceIndex });
        else if (sanitizeMetadata) scheduleStopAfterTools(choiceIndex);
      } else {
        scheduleStopAfterTools(choiceIndex);
      }
    }
  };

  return { emitDeltaFromRuntime, emitMessageFromRuntime };
};
