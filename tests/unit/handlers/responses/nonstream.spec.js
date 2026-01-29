import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logResponsesIngressRawMock = vi.fn();
const summarizeResponsesIngressMock = vi.fn(() => ({}));
const summarizeToolsMock = vi.fn(() => ({
  tool_count: 0,
  tool_types: [],
  tool_types_truncated: false,
  tool_names: [],
  tool_names_truncated: false,
  tool_function_name_present_count: 0,
  tool_function_name_missing_count: 0,
}));
const captureResponsesNonStreamMock = vi.fn();
const logStructuredMock = vi.fn();
const summarizeTextPartsMock = vi.fn(() => ({
  output_text_bytes: 0,
  output_text_hash: "",
  xml_in_text: false,
}));
const summarizeToolCallsMock = vi.fn(() => ({
  tool_call_count: 0,
  tool_names: [],
  tool_names_truncated: false,
}));
const summarizeToolUseItemsMock = vi.fn(() => ({
  tool_use_count: 0,
  tool_use_names: [],
  tool_use_names_truncated: false,
}));
const buildResponsesEnvelopeMock = vi.fn(() => ({
  id: "resp_test",
  object: "response",
  created: 123,
  status: "completed",
  model: "gpt-5.2",
  output: [],
}));
const normalizeResponsesRequestMock = vi.fn(() => ({
  instructions: "",
  inputItems: [{ type: "text", data: { text: "[user] hi" } }],
  responseFormat: undefined,
  finalOutputJsonSchema: undefined,
  tools: null,
  toolChoice: undefined,
  parallelToolCalls: undefined,
  maxOutputTokens: undefined,
  toolOutputs: [],
}));
const runNativeResponsesMock = vi.fn(async ({ onEvent }) => {
  onEvent({ type: "text_delta", delta: "Hello", choiceIndex: 0 });
  onEvent({ type: "finish", reason: "stop", trigger: "task_complete" });
});
const createJsonRpcChildAdapterMock = vi.fn(() => ({
  stdin: { write: vi.fn() },
  once: vi.fn(),
  kill: vi.fn(),
}));
const ensureHandshakeMock = vi.fn(async () => ({ raw: { capabilities: { tools: {} } } }));
const createToolCallAggregatorMock = vi.fn(() => ({
  ingestDelta: vi.fn(),
  ingestMessage: vi.fn(),
  snapshot: vi.fn(() => [{ id: "call_1", function: { name: "lookup", arguments: "{}" } }]),
}));
const appendUsageMock = vi.fn();
const logSanitizerToggleMock = vi.fn();
const logSanitizerSummaryMock = vi.fn();

const ORIGINAL_RESPONSES_DEFAULT_MAX_TOKENS = process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS;
const ORIGINAL_MAX_CHAT_CHOICES = process.env.PROXY_MAX_CHAT_CHOICES;

vi.mock("../../../../src/handlers/responses/ingress-logging.js", () => ({
  logResponsesIngressRaw: (...args) => logResponsesIngressRawMock(...args),
  summarizeResponsesIngress: (...args) => summarizeResponsesIngressMock(...args),
  summarizeTools: (...args) => summarizeToolsMock(...args),
}));

vi.mock("../../../../src/handlers/responses/capture.js", () => ({
  captureResponsesNonStream: (...args) => captureResponsesNonStreamMock(...args),
}));

vi.mock("../../../../src/handlers/responses/native/envelope.js", () => ({
  buildResponsesEnvelope: (...args) => buildResponsesEnvelopeMock(...args),
}));

vi.mock("../../../../src/handlers/responses/native/request.js", async () => {
  const actual = await vi.importActual("../../../../src/handlers/responses/native/request.js");
  return {
    ...actual,
    normalizeResponsesRequest: (...args) => normalizeResponsesRequestMock(...args),
  };
});

vi.mock("../../../../src/handlers/responses/native/execute.js", () => ({
  runNativeResponses: (...args) => runNativeResponsesMock(...args),
}));

vi.mock("../../../../src/services/transport/child-adapter.js", () => ({
  createJsonRpcChildAdapter: (...args) => createJsonRpcChildAdapterMock(...args),
}));

vi.mock("../../../../src/services/transport/index.js", async () => {
  const actual = await vi.importActual("../../../../src/services/transport/index.js");
  return {
    ...actual,
    getJsonRpcTransport: () => ({
      ensureHandshake: (...args) => ensureHandshakeMock(...args),
    }),
  };
});

vi.mock("../../../../src/lib/tool-call-aggregator.js", () => ({
  createToolCallAggregator: (...args) => createToolCallAggregatorMock(...args),
}));

vi.mock("../../../../src/services/logging/schema.js", () => ({
  logStructured: (...args) => logStructuredMock(...args),
  sha256: (value) => `hash-${value}`,
}));

vi.mock("../../../../src/lib/observability/transform-summary.js", () => ({
  summarizeTextParts: (...args) => summarizeTextPartsMock(...args),
  summarizeToolCalls: (...args) => summarizeToolCallsMock(...args),
  summarizeToolUseItems: (...args) => summarizeToolUseItemsMock(...args),
}));

vi.mock("../../../../src/lib/copilot-detect.js", () => ({
  detectCopilotRequest: () => ({
    copilot_detected: false,
    copilot_detect_tier: null,
    copilot_detect_reasons: [],
  }),
}));

vi.mock("../../../../src/dev-logging.js", () => ({
  appendUsage: (...args) => appendUsageMock(...args),
  logSanitizerToggle: (...args) => logSanitizerToggleMock(...args),
  logSanitizerSummary: (...args) => logSanitizerSummaryMock(...args),
}));

const makeReq = (body) => ({
  body,
  headers: {},
  method: "POST",
  on: vi.fn(),
});

const makeRes = () => {
  const res = new EventEmitter();
  res.locals = {};
  res.headersSent = false;
  res.setHeader = vi.fn();
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.once = vi.fn((event, handler) => res.on(event, handler));
  res.off = vi.fn((event, handler) => res.removeListener(event, handler));
  return res;
};

beforeEach(() => {
  normalizeResponsesRequestMock.mockClear();
  runNativeResponsesMock.mockClear();
  createJsonRpcChildAdapterMock.mockClear();
  createToolCallAggregatorMock.mockClear();
  buildResponsesEnvelopeMock.mockClear();
  ensureHandshakeMock.mockClear();
  appendUsageMock.mockClear();
  logSanitizerToggleMock.mockClear();
  logSanitizerSummaryMock.mockClear();
});

afterEach(() => {
  if (ORIGINAL_RESPONSES_DEFAULT_MAX_TOKENS === undefined) {
    delete process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS;
  } else {
    process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS = ORIGINAL_RESPONSES_DEFAULT_MAX_TOKENS;
  }
  if (ORIGINAL_MAX_CHAT_CHOICES === undefined) {
    delete process.env.PROXY_MAX_CHAT_CHOICES;
  } else {
    process.env.PROXY_MAX_CHAT_CHOICES = ORIGINAL_MAX_CHAT_CHOICES;
  }
  vi.resetModules();
});

describe("responses nonstream handler", () => {
  it("restores output mode header after request", async () => {
    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    expect(req.headers["x-proxy-output-mode"]).toBeUndefined();
  });

  it("returns 400 when n is invalid", async () => {
    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2", n: "nope" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createJsonRpcChildAdapterMock).not.toHaveBeenCalled();
  });

  it("returns 400 when n is greater than 1", async () => {
    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2", n: 2 });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ param: "n", code: "n_unsupported" }),
      })
    );
    expect(createJsonRpcChildAdapterMock).not.toHaveBeenCalled();
  });

  it("logs tool output summaries when provided", async () => {
    const transport = { respondToToolCall: vi.fn(() => true) };
    createJsonRpcChildAdapterMock.mockReturnValueOnce({
      stdin: { write: vi.fn() },
      once: vi.fn(),
      kill: vi.fn(),
      transport,
    });
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      finalOutputJsonSchema: undefined,
      tools: null,
      toolChoice: undefined,
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
      toolOutputs: [{ callId: "call_1", output: "ok", success: true, toolName: "lookup" }],
    });

    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    const toolLog = logStructuredMock.mock.calls.find(
      ([entry]) => entry?.event === "tool_call_output"
    );
    expect(toolLog).toBeTruthy();
    expect(toolLog[1].tool_call_id).toBe("call_1");
    expect(toolLog[1].tool_name).toBe("lookup");
  });

  it("returns 400 when model is missing", async () => {
    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createJsonRpcChildAdapterMock).not.toHaveBeenCalled();
  });

  it("returns normalization errors as 400", async () => {
    const { ResponsesJsonRpcNormalizationError } = await import(
      "../../../../src/handlers/responses/native/request.js"
    );
    normalizeResponsesRequestMock.mockImplementationOnce(() => {
      throw new ResponsesJsonRpcNormalizationError(
        { error: { param: "input", message: "bad input" } },
        400
      );
    });

    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ param: "input" }) })
    );
  });

  it("rejects tool requests when backend explicitly disables tools", async () => {
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      finalOutputJsonSchema: undefined,
      tools: [{ type: "function", function: { name: "lookup" } }],
      toolChoice: undefined,
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
    });
    ensureHandshakeMock.mockResolvedValueOnce({ raw: { capabilities: { tools: false } } });

    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ param: "tools" }) })
    );
    expect(createJsonRpcChildAdapterMock).not.toHaveBeenCalled();
  });

  it("builds and returns a responses envelope", async () => {
    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    expect(runNativeResponsesMock).toHaveBeenCalled();
    expect(buildResponsesEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.2",
        outputText: "Hello",
        functionCalls: expect.any(Array),
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ object: "response" }));
  });

  it("forwards function tools as dynamicTools on the turn payload", async () => {
    const definitions = [{ type: "function", function: { name: "lookup", parameters: {} } }];
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      finalOutputJsonSchema: undefined,
      tools: definitions,
      toolChoice: "auto",
      parallelToolCalls: true,
      maxOutputTokens: undefined,
    });

    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    expect(createJsonRpcChildAdapterMock).toHaveBeenCalled();
    const [{ normalizedRequest }] = createJsonRpcChildAdapterMock.mock.calls[0];
    expect(normalizedRequest.turn.dynamicTools).toEqual([
      { name: "lookup", description: "", inputSchema: {} },
    ]);
    expect(normalizedRequest.turn.tools).toBeUndefined();
    expect(normalizedRequest.message.tools).toBeUndefined();
  });

  it("strips <tool_call> blocks from output text and emits function calls", async () => {
    createToolCallAggregatorMock.mockReturnValueOnce({
      ingestDelta: vi.fn(),
      ingestMessage: vi.fn(),
      snapshot: vi.fn(() => []),
    });
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      finalOutputJsonSchema: undefined,
      tools: [{ type: "function", function: { name: "search", parameters: {} } }],
      toolChoice: "auto",
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
    });
    runNativeResponsesMock.mockImplementationOnce(async ({ onEvent }) => {
      onEvent({
        type: "text",
        text: 'Hi <tool_call>{"name":"search","arguments":"{\\"query\\":\\"x\\"}"}</tool_call> ok',
        choiceIndex: 0,
      });
      onEvent({ type: "finish", reason: "stop", trigger: "task_complete" });
    });

    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    const [args] = buildResponsesEnvelopeMock.mock.calls[0];
    expect(args.outputText).toBe("Hi  ok");
    expect(args.functionCalls).toEqual([
      {
        id: "fc_001",
        type: "function",
        function: { name: "search", arguments: '{"query":"x"}' },
      },
    ]);
  });

  it("strips <tool_call> blocks without tool definitions", async () => {
    createToolCallAggregatorMock.mockReturnValueOnce({
      ingestDelta: vi.fn(),
      ingestMessage: vi.fn(),
      snapshot: vi.fn(() => []),
    });
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      finalOutputJsonSchema: undefined,
      tools: undefined,
      toolChoice: undefined,
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
    });
    runNativeResponsesMock.mockImplementationOnce(async ({ onEvent }) => {
      onEvent({
        type: "text",
        text: 'Hi <tool_call>{"name":"search","arguments":"{\\"query\\":\\"x\\"}"}</tool_call> ok',
        choiceIndex: 0,
      });
      onEvent({ type: "finish", reason: "stop", trigger: "task_complete" });
    });

    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );
    const req = makeReq({ input: "hello", model: "gpt-5.2" });
    const res = makeRes();

    await postResponsesNonStream(req, res);

    const [args] = buildResponsesEnvelopeMock.mock.calls[0];
    expect(args.outputText).toBe("Hi  ok");
    expect(args.functionCalls).toEqual([
      {
        id: "fc_001",
        type: "function",
        function: { name: "search", arguments: '{"query":"x"}' },
      },
    ]);
  });
});
