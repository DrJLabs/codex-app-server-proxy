import { describe, expect, it, vi } from "vitest";
import { createStreamEventRouter } from "../../../../src/handlers/chat/stream-event-router.js";

describe("stream event router", () => {
  it("routes message events to transport", () => {
    const handleParsedEvent = vi.fn(() => true);
    const router = createStreamEventRouter({
      parseStreamEventLine: () => ({
        type: "agent_message_delta",
        payload: {},
        params: {},
        messagePayload: { delta: "hi" },
      }),
      sanitizeMetadata: false,
      handleParsedEvent,
      trackToolSignals: vi.fn(),
      extractFinishReasonFromMessage: vi.fn(),
      trackFinishReason: vi.fn(),
      updateUsageCounts: vi.fn(),
      mergeMetadataInfo: vi.fn(),
      recordSanitizedMetadata: vi.fn(),
      shouldDropFunctionCallOutput: vi.fn(),
      getUsageTrigger: () => null,
      markUsageTriggerIfMissing: vi.fn(),
      hasAnyChoiceSent: () => true,
      hasLengthEvidence: () => false,
      emitFinishChunk: vi.fn(),
      finalizeStream: vi.fn(),
    });

    router.handleLine('{"type":"agent_message_delta"}');

    expect(handleParsedEvent).toHaveBeenCalled();
  });

  it("finalizes on task_complete", () => {
    const finalizeStream = vi.fn();
    const emitFinishChunk = vi.fn();
    const updateUsageCounts = vi.fn();
    const router = createStreamEventRouter({
      parseStreamEventLine: () => ({
        type: "task_complete",
        payload: {},
        params: {},
        messagePayload: { completion_tokens: 3 },
      }),
      sanitizeMetadata: false,
      handleParsedEvent: vi.fn(),
      trackToolSignals: vi.fn(),
      extractFinishReasonFromMessage: () => "stop",
      trackFinishReason: vi.fn(),
      updateUsageCounts,
      mergeMetadataInfo: vi.fn(),
      recordSanitizedMetadata: vi.fn(),
      shouldDropFunctionCallOutput: vi.fn(),
      getUsageTrigger: () => null,
      markUsageTriggerIfMissing: vi.fn(),
      hasAnyChoiceSent: () => true,
      hasLengthEvidence: () => false,
      emitFinishChunk,
      finalizeStream,
    });

    const result = router.handleLine('{"type":"task_complete"}');
    expect(emitFinishChunk).toHaveBeenCalledWith("stop");
    expect(finalizeStream).toHaveBeenCalledWith({
      reason: "stop",
      trigger: "task_complete",
    });
    expect(result.stop).toBe(true);
  });

  it("maps dynamic tool call requests to tool_calls deltas", () => {
    const handleParsedEvent = vi.fn();
    const router = createStreamEventRouter({
      parseStreamEventLine: () => ({
        type: "dynamic_tool_call_request",
        payload: {},
        params: {},
        messagePayload: { tool: "lookup", arguments: { id: 1 }, callId: "call_1" },
      }),
      sanitizeMetadata: false,
      handleParsedEvent,
      trackToolSignals: vi.fn(),
      extractFinishReasonFromMessage: vi.fn(),
      trackFinishReason: vi.fn(),
      updateUsageCounts: vi.fn(),
      mergeMetadataInfo: vi.fn(),
      recordSanitizedMetadata: vi.fn(),
      shouldDropFunctionCallOutput: vi.fn(),
      getUsageTrigger: () => null,
      markUsageTriggerIfMissing: vi.fn(),
      hasAnyChoiceSent: () => true,
      hasLengthEvidence: () => false,
      emitFinishChunk: vi.fn(),
      finalizeStream: vi.fn(),
    });

    router.handleLine('{"type":"dynamic_tool_call_request"}');

    expect(handleParsedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent_message_delta",
        messagePayload: {
          delta: {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"id":1}' },
              },
            ],
          },
        },
      })
    );
  });

  it("emits atomic dynamic tool call events when configured", () => {
    const handleParsedEvent = vi.fn();
    const router = createStreamEventRouter({
      parseStreamEventLine: () => ({
        type: "dynamic_tool_call_request",
        payload: {},
        params: {},
        messagePayload: { tool: "lookup", arguments: { id: 1 }, callId: "call_1" },
      }),
      sanitizeMetadata: false,
      handleParsedEvent,
      trackToolSignals: vi.fn(),
      extractFinishReasonFromMessage: vi.fn(),
      trackFinishReason: vi.fn(),
      updateUsageCounts: vi.fn(),
      mergeMetadataInfo: vi.fn(),
      recordSanitizedMetadata: vi.fn(),
      shouldDropFunctionCallOutput: vi.fn(),
      getUsageTrigger: () => null,
      markUsageTriggerIfMissing: vi.fn(),
      hasAnyChoiceSent: () => true,
      hasLengthEvidence: () => false,
      emitFinishChunk: vi.fn(),
      finalizeStream: vi.fn(),
      dynamicToolCallMode: "atomic",
    });

    router.handleLine('{"type":"dynamic_tool_call_request"}');

    expect(handleParsedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dynamic_tool_call",
        messagePayload: { tool: "lookup", arguments: { id: 1 }, callId: "call_1" },
        toolCallDelta: {
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"id":1}' },
            },
          ],
        },
      })
    );
  });
});
