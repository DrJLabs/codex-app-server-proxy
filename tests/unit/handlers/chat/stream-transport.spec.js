import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { wireStreamTransport } from "../../../../src/handlers/chat/stream-transport.js";

describe("stream transport", () => {
  it("forwards delta events to runtime", () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const runtime = { handleDelta: vi.fn() };

    wireStreamTransport({ child, runtime });

    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "agent_message_delta", msg: { delta: "hi" } })}\n`
    );

    expect(runtime.handleDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        choiceIndex: 0,
        delta: "hi",
        eventType: "agent_message_delta",
      })
    );
  });

  it("forwards message events to runtime", () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const runtime = { handleMessage: vi.fn() };

    wireStreamTransport({ child, runtime });

    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "agent_message",
        msg: { message: { content: "hi" } },
      })}\n`
    );

    expect(runtime.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        choiceIndex: 0,
        message: { content: "hi" },
        eventType: "agent_message",
      })
    );
  });

  it("returns handleLine for direct parsing", () => {
    const runtime = { handleDelta: vi.fn() };

    const { handleLine } = wireStreamTransport({ runtime });

    handleLine(JSON.stringify({ type: "agent_message_delta", msg: { delta: "hi" } }));

    expect(runtime.handleDelta).toHaveBeenCalledWith(
      expect.objectContaining({ choiceIndex: 0, delta: "hi" })
    );
  });

  it("handles parsed events directly", () => {
    const runtime = { handleDelta: vi.fn() };

    const { handleParsedEvent } = wireStreamTransport({ runtime });

    const handled = handleParsedEvent({
      type: "agent_message_delta",
      params: {},
      messagePayload: { delta: "hi" },
      baseChoiceIndex: 0,
    });

    expect(handled).toBe(true);
    expect(runtime.handleDelta).toHaveBeenCalled();
  });

  it("forwards turn/completed to runtime result handler", () => {
    const runtime = { handleResult: vi.fn() };
    const { handleParsedEvent } = wireStreamTransport({ runtime });

    const handled = handleParsedEvent({
      type: "turn/completed",
      params: {},
      messagePayload: { turn: { status: "completed", finish_reason: "stop" } },
      baseChoiceIndex: 0,
    });

    expect(handled).toBe(true);
    expect(runtime.handleResult).toHaveBeenCalledWith(
      expect.objectContaining({ finishReason: "stop" })
    );
  });

  it("forwards turn/completed failures and error events to runtime error handler", () => {
    const runtime = { handleError: vi.fn() };
    const { handleParsedEvent } = wireStreamTransport({ runtime });

    const failed = handleParsedEvent({
      type: "turn/completed",
      params: {},
      messagePayload: { turn: { status: "failed", error: { message: "boom" } } },
      baseChoiceIndex: 0,
    });
    const error = handleParsedEvent({
      type: "error",
      params: {},
      messagePayload: { error: { message: "bad" } },
      baseChoiceIndex: 0,
    });

    expect(failed).toBe(true);
    expect(error).toBe(true);
    expect(runtime.handleError).toHaveBeenCalledTimes(2);
  });

  it("flushes buffered data on end", () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const runtime = { handleDelta: vi.fn() };

    wireStreamTransport({ child, runtime });

    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "agent_message_delta", msg: { delta: "hi" } })}`
    );
    child.stdout.emit("end");

    expect(runtime.handleDelta).toHaveBeenCalledWith(
      expect.objectContaining({ choiceIndex: 0, delta: "hi" })
    );
  });
});
