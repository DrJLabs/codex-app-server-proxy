import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSSE } from "../../../shared/transcript-utils.js";
import { createToolCallAggregator } from "../../../../src/lib/tool-call-aggregator.js";
import { createResponsesStreamCapture } from "../../../../src/handlers/responses/capture.js";

vi.mock("../../../../src/services/metrics/index.js", () => ({
  recordResponsesSseEvent: vi.fn(),
}));

vi.mock("../../../../src/lib/tool-call-aggregator.js", () => ({
  createToolCallAggregator: vi.fn(),
}));

vi.mock("../../../../src/handlers/responses/capture.js", () => ({
  createResponsesStreamCapture: vi.fn(),
}));

const logProtoState = { enabled: false };
const shouldLogVerboseMock = vi.fn(() => false);
const previewMock = vi.fn(() => ({ preview: "", truncated: false }));
const appendProtoEventMock = vi.fn();

vi.mock("../../../../src/services/logging/schema.js", () => ({
  logStructured: vi.fn(),
  sha256: vi.fn(() => "hash"),
  shouldLogVerbose: (...args) => shouldLogVerboseMock(...args),
  preview: (...args) => previewMock(...args),
}));

vi.mock("../../../../src/dev-logging.js", () => ({
  appendProtoEvent: (...args) => appendProtoEventMock(...args),
  get LOG_PROTO() {
    return logProtoState.enabled;
  },
}));

const buildRes = () => ({
  locals: {},
  chunks: [],
  writableEnded: false,
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  },
  flush: vi.fn(),
  end() {
    this.writableEnded = true;
  },
});

const buildAggregator = (overrides = {}) => ({
  ingestDelta: vi.fn(() => ({ updated: false, deltas: [] })),
  ingestMessage: vi.fn(() => ({ updated: false, deltas: [] })),
  snapshot: vi.fn(() => []),
  ...overrides,
});

const waitForWrites = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  createToolCallAggregator.mockReturnValue(buildAggregator());
  createResponsesStreamCapture.mockReturnValue({
    record: vi.fn(),
    finalize: vi.fn(),
  });
  logProtoState.enabled = false;
  shouldLogVerboseMock.mockReset().mockReturnValue(false);
  previewMock.mockReset().mockReturnValue({ preview: "", truncated: false });
  appendProtoEventMock.mockReset();
});

describe("responses stream adapter", () => {
  it("emits response.created and output deltas", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({ type: "text_delta", delta: "Hello", choiceIndex: 0 });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    expect(entries[0]?.event).toBe("response.created");
    const deltas = entries.filter((entry) => entry.event === "response.output_text.delta");
    expect(deltas.map((entry) => entry.data.delta).join("")).toBe("Hello");
  });

  it("emits tool call delta and done events", async () => {
    const toolDelta = {
      id: "call_1",
      index: 0,
      type: "function",
      function: {
        name: "search",
        arguments: '{"query":"hi"}',
      },
    };
    const toolSnapshot = [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "search",
          arguments: '{"query":"hi"}',
        },
      },
    ];
    createToolCallAggregator.mockReturnValue(
      buildAggregator({
        ingestDelta: vi.fn(() => ({ updated: true, deltas: [toolDelta] })),
        snapshot: vi.fn(() => toolSnapshot),
      })
    );

    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({
      type: "tool_calls_delta",
      tool_calls: [toolDelta],
      choiceIndex: 0,
    });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const events = entries.map((entry) => entry.event).filter(Boolean);
    const addedIndex = events.indexOf("response.output_item.added");
    const deltaIndex = events.indexOf("response.function_call_arguments.delta");
    const doneIndex = events.indexOf("response.function_call_arguments.done");
    const outputDoneIndex = events.indexOf("response.output_item.done");

    expect(addedIndex).toBeGreaterThan(-1);
    expect(deltaIndex).toBeGreaterThan(addedIndex);
    expect(doneIndex).toBeGreaterThan(deltaIndex);
    expect(outputDoneIndex).toBeGreaterThan(doneIndex);
  });

  it("emits response.failed when onChunk throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createToolCallAggregator.mockReturnValue(
      buildAggregator({
        ingestDelta: vi.fn(() => {
          throw new Error("boom");
        }),
      })
    );
    const toolDelta = {
      id: "call_err",
      index: 0,
      type: "function",
      function: { name: "fail", arguments: "{}" },
    };

    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({ type: "tool_calls_delta", tool_calls: [toolDelta], choiceIndex: 0 });
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const events = entries.map((entry) => entry.event).filter(Boolean);
    expect(events).toContain("response.failed");
    expect(events).toContain("done");
    errorSpy.mockRestore();
  });

  it("marks incomplete when finish_reason is length", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({ type: "text_delta", delta: "Hello", choiceIndex: 0 });
    adapter.handleEvent({ type: "finish", reason: "length", trigger: "task_complete" });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const completed = entries.find((entry) => entry.event === "response.completed");
    expect(completed?.data?.response?.status).toBe("incomplete");
  });

  it("handles array and object content deltas", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({ type: "text_delta", delta: "A", choiceIndex: 0 });
    adapter.handleEvent({ type: "text_delta", delta: "B", choiceIndex: 0 });
    adapter.handleEvent({ type: "text_delta", delta: "C", choiceIndex: 0 });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const deltas = entries
      .filter((entry) => entry.event === "response.output_text.delta")
      .map((entry) => entry.data.delta)
      .join("");
    expect(deltas).toBe("ABC");
  });

  it("ingests tool calls from message payloads when deltas do not update", async () => {
    const toolDelta = {
      id: "call_2",
      index: 0,
      type: "function",
      function: { name: "calc", arguments: '{"x":1}' },
    };
    createToolCallAggregator.mockReturnValue(
      buildAggregator({
        ingestDelta: vi.fn(() => ({ updated: false, deltas: [] })),
        ingestMessage: vi.fn(() => ({ updated: true, deltas: [toolDelta] })),
        snapshot: vi.fn(() => [
          {
            id: "call_2",
            type: "function",
            function: { name: "calc", arguments: '{"x":1}' },
          },
        ]),
      })
    );

    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({
      type: "tool_calls",
      tool_calls: [toolDelta],
      choiceIndex: 0,
    });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const events = entries.map((entry) => entry.event).filter(Boolean);
    expect(events).toContain("response.output_item.added");
  });

  it("emits response.completed when no chunks were received", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const completed = entries.find((entry) => entry.event === "response.completed");
    expect(completed?.data?.response?.output?.[0]?.content?.[0]?.text).toBe("");
  });

  it("marks responses failed when finish reasons include cancellation", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({ type: "text_delta", delta: "Hello", choiceIndex: 0 });
    adapter.handleEvent({ type: "finish", reason: "cancelled", trigger: "task_complete" });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const completed = entries.find((entry) => entry.event === "response.completed");
    expect(completed?.data?.response?.status).toBe("failed");
  });

  it("maps usage input/output tokens into response summaries", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({
      type: "usage",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    adapter.handleEvent({ type: "text_delta", delta: "Hello", choiceIndex: 0 });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const completed = entries.find((entry) => entry.event === "response.completed");
    expect(completed?.data?.response?.usage).toEqual({
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
    });
  });

  it("records delta previews when verbose proto logging is enabled", async () => {
    logProtoState.enabled = true;
    shouldLogVerboseMock.mockReturnValue(true);
    previewMock.mockReturnValue({ preview: "Hello", truncated: false });

    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({ type: "text_delta", delta: "Hello", choiceIndex: 0 });
    await adapter.finalize();
    await waitForWrites();

    const protoEntry = appendProtoEventMock.mock.calls.find(
      ([payload]) => payload?.delta_preview === "Hello"
    );
    expect(protoEntry).toBeTruthy();
  });

  it("logs tool argument previews when JSON is invalid", async () => {
    logProtoState.enabled = true;
    shouldLogVerboseMock.mockReturnValue(true);
    previewMock.mockReturnValue({ preview: "{bad", truncated: true });

    const toolDelta = {
      id: "call_bad",
      index: 0,
      type: "function",
      function: { name: "badTool", arguments: "{bad" },
    };
    createToolCallAggregator.mockReturnValue(
      buildAggregator({
        ingestDelta: vi.fn(() => ({ updated: true, deltas: [toolDelta] })),
        snapshot: vi.fn(() => [
          {
            id: "call_bad",
            type: "function",
            function: { name: "badTool", arguments: "{bad" },
          },
        ]),
      })
    );

    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({
      type: "tool_calls_delta",
      tool_calls: [toolDelta],
      choiceIndex: 0,
    });
    await adapter.finalize();
    await waitForWrites();

    const protoEntry = appendProtoEventMock.mock.calls.find(
      ([payload]) => payload?.args_preview === "{bad"
    );
    expect(protoEntry).toBeTruthy();
  });

  it("parses <tool_call> blocks from text deltas", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, {
      model: "gpt-test",
      tools: [{ type: "function", name: "search", parameters: {} }],
    });

    adapter.handleEvent({
      type: "text_delta",
      delta: 'Hi <tool_call>{"name":"search","arguments":"{\\"query\\":\\"x\\"}"}</tool_call> ok',
      choiceIndex: 0,
    });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const output = entries
      .filter((entry) => entry.event === "response.output_text.delta")
      .map((entry) => entry.data.delta)
      .join("");
    expect(output).toBe("Hi  ok");

    const events = entries.map((entry) => entry.event).filter(Boolean);
    const addedIndex = events.indexOf("response.output_item.added");
    const doneIndex = events.indexOf("response.function_call_arguments.done");
    const outputDoneIndex = events.indexOf("response.output_item.done");

    expect(addedIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBeGreaterThan(addedIndex);
    expect(outputDoneIndex).toBeGreaterThan(doneIndex);

    const added = entries.find((entry) => entry.event === "response.output_item.added");
    expect(added?.data?.item?.type).toBe("function_call");
    expect(added?.data?.item?.name).toBe("search");
  });

  it("parses <tool_call> blocks without tool definitions", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({
      type: "text_delta",
      delta: 'Hi <tool_call>{"name":"search","arguments":"{\\"query\\":\\"x\\"}"}</tool_call> ok',
      choiceIndex: 0,
    });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const output = entries
      .filter((entry) => entry.event === "response.output_text.delta")
      .map((entry) => entry.data.delta)
      .join("");
    expect(output).toBe("Hi  ok");

    const added = entries.find((entry) => entry.event === "response.output_item.added");
    expect(added?.data?.item?.type).toBe("function_call");
    expect(added?.data?.item?.name).toBe("search");
  });

  it("adds monotonically increasing sequence_number values", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../../src/handlers/responses/stream-adapter.js"
    );

    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.handleEvent({ type: "text_delta", delta: "Hello", choiceIndex: 0 });
    await adapter.finalize();
    await waitForWrites();

    const entries = parseSSE(res.chunks.join(""));
    const numbers = entries
      .filter((entry) => entry.type === "data")
      .map((entry) => entry.data?.sequence_number)
      .filter((value) => Number.isInteger(value));

    expect(numbers.length).toBeGreaterThan(0);
    numbers.forEach((value, index) => {
      if (index === 0) return;
      expect(value).toBeGreaterThan(numbers[index - 1]);
    });
  });
});
