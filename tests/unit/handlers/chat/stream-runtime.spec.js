import { describe, expect, it, vi } from "vitest";
import { createStreamRuntime } from "../../../../src/handlers/chat/stream-runtime.js";

const createOutputStub = () => ({
  emitDelta: vi.fn(),
  emitMessage: vi.fn(),
  emitUsage: vi.fn(),
  emitFinish: vi.fn(),
  emitError: vi.fn(),
});

const createToolNormalizerStub = () => ({
  ingestDelta: vi.fn((payload) => payload),
  ingestMessage: vi.fn((payload) => payload),
  finalize: vi.fn(() => null),
});

describe("stream runtime", () => {
  it("routes delta payloads into output emission", () => {
    const output = createOutputStub();
    const toolNormalizer = createToolNormalizerStub();
    const finishTracker = { onDelta: vi.fn(), onMessage: vi.fn(), finalize: vi.fn() };
    const runtime = createStreamRuntime({
      output,
      toolNormalizer,
      finishTracker,
    });

    runtime.handleDelta({
      choiceIndex: 0,
      delta: { content: "hi" },
      eventType: "agent_message_delta",
    });

    expect(toolNormalizer.ingestDelta).toHaveBeenCalled();
    expect(finishTracker.onDelta).toHaveBeenCalledWith({ content: "hi" });
    expect(output.emitDelta).toHaveBeenCalledWith(
      0,
      { content: "hi" },
      expect.objectContaining({ eventType: "agent_message_delta" })
    );
  });

  it("routes message payloads into output emission", () => {
    const output = createOutputStub();
    const toolNormalizer = createToolNormalizerStub();
    const finishTracker = { onDelta: vi.fn(), onMessage: vi.fn(), finalize: vi.fn() };
    const runtime = createStreamRuntime({ output, toolNormalizer, finishTracker });

    runtime.handleMessage({
      choiceIndex: 1,
      message: { content: "done" },
      eventType: "agent_message",
    });

    expect(toolNormalizer.ingestMessage).toHaveBeenCalled();
    expect(finishTracker.onMessage).toHaveBeenCalledWith({ content: "done" });
    expect(output.emitMessage).toHaveBeenCalledWith(
      1,
      { content: "done" },
      expect.objectContaining({ eventType: "agent_message" })
    );
  });

  it("routes usage and finish to output", () => {
    const output = createOutputStub();
    const toolNormalizer = createToolNormalizerStub();
    const runtime = createStreamRuntime({
      output,
      toolNormalizer,
      finishTracker: { onDelta: vi.fn(), onMessage: vi.fn(), finalize: vi.fn() },
    });

    runtime.handleUsage({ choiceIndex: 0, usage: { total_tokens: 12 } });
    runtime.handleResult({ choiceIndex: 0, finishReason: "stop" });

    expect(output.emitUsage).toHaveBeenCalledWith(0, { total_tokens: 12 }, expect.any(Object));
    expect(output.emitFinish).toHaveBeenCalledWith(0, "stop", expect.any(Object));
  });

  it("routes errors to output when first terminal event", () => {
    const output = createOutputStub();
    const toolNormalizer = createToolNormalizerStub();
    const runtime = createStreamRuntime({
      output,
      toolNormalizer,
      finishTracker: { onDelta: vi.fn(), onMessage: vi.fn(), finalize: vi.fn() },
    });

    runtime.handleError({ choiceIndex: 0, error: new Error("boom") });

    expect(output.emitError).toHaveBeenCalledWith(0, expect.any(Error), expect.any(Object));
  });

  it("terminates once and ignores subsequent terminal events", () => {
    const output = createOutputStub();
    const toolNormalizer = createToolNormalizerStub();
    const runtime = createStreamRuntime({
      output,
      toolNormalizer,
      finishTracker: { onDelta: vi.fn(), onMessage: vi.fn(), finalize: vi.fn() },
    });

    runtime.handleError({ choiceIndex: 0, error: new Error("boom") });
    runtime.handleResult({ choiceIndex: 0, finishReason: "stop" });
    runtime.handleDelta({ choiceIndex: 0, delta: { content: "ignored" } });

    expect(output.emitError).toHaveBeenCalledTimes(1);
    expect(output.emitFinish).not.toHaveBeenCalled();
    expect(output.emitDelta).not.toHaveBeenCalled();
  });
});
