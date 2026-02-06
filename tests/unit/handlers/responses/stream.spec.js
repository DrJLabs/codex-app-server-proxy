import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESPONSES_INTERNAL_TOOLS_INSTRUCTION } from "../../../../src/lib/prompts/internal-tools-instructions.js";
import { TOOL_CHOICE_REQUIRED_INSTRUCTION } from "../../../../src/lib/prompts/tool-choice-required-instructions.js";

const ORIGINAL_DISABLE_INTERNAL_TOOLS = process.env.PROXY_DISABLE_INTERNAL_TOOLS;
const ORIGINAL_DISABLE_INTERNAL_TOOLS_CONFIG = process.env.PROXY_DISABLE_INTERNAL_TOOLS_CONFIG;
const ORIGINAL_DISABLE_INTERNAL_TOOLS_PROMPT = process.env.PROXY_DISABLE_INTERNAL_TOOLS_PROMPT;

const applyProxyTraceHeadersMock = vi.fn();
const ensureReqIdMock = vi.fn(() => "req_test");
const setHttpContextMock = vi.fn();
const detectCopilotRequestMock = vi.fn(() => ({
  copilot_detected: false,
  copilot_detect_tier: null,
  copilot_detect_reasons: [],
}));
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
const logResponsesIngressRawMock = vi.fn();
const normalizeResponsesRequestMock = vi.fn(() => ({
  instructions: "",
  inputItems: [{ type: "text", data: { text: "[user] hi" } }],
  responseFormat: undefined,
  outputSchema: undefined,
  tools: null,
  toolChoice: undefined,
  parallelToolCalls: undefined,
  maxOutputTokens: undefined,
  toolOutputs: [],
}));
const ensureResponsesCapabilitiesMock = vi.fn(async () => ({ ok: true }));
const runNativeResponsesMock = vi.fn(async () => {});
const createJsonRpcChildAdapterMock = vi.fn(() => ({
  stdin: { write: vi.fn() },
  once: vi.fn(),
  kill: vi.fn(),
}));
const createResponsesStreamAdapterMock = vi.fn(() => ({
  handleEvent: vi.fn(),
  finalize: vi.fn(async () => {}),
  fail: vi.fn(),
}));
const createStreamMetadataSanitizerMock = vi.fn(() => ({
  enqueueSanitizedSegment: vi.fn(),
  flushSanitizedSegments: vi.fn(),
  getSummaryData: vi.fn(() => ({ count: 0, keys: [], sources: [] })),
}));
const setupStreamGuardMock = vi.fn(() => ({
  acquired: true,
  token: "guard",
  release: vi.fn(),
}));
const applyGuardHeadersMock = vi.fn();
const logStructuredMock = vi.fn();
const logSanitizerSummaryMock = vi.fn();
const logSanitizerToggleMock = vi.fn();
const appendProtoEventMock = vi.fn();
const appendUsageMock = vi.fn();
const appendThinkingRawCaptureMock = vi.fn();
const applyCorsMock = vi.fn();
const normalizeModelMock = vi.fn((model) => ({ requested: model, effective: model }));
const acceptedModelIdsMock = vi.fn(() => new Set(["gpt-5.2"]));
const setSSEHeadersMock = vi.fn();
const computeKeepaliveMsMock = vi.fn(() => 0);
const startKeepalivesMock = vi.fn(() => ({ stop: vi.fn() }));
const transportMock = {
  resolveThreadForToolOutputs: vi.fn(),
};

vi.mock("../../../../src/lib/request-context.js", () => ({
  applyProxyTraceHeaders: (...args) => applyProxyTraceHeadersMock(...args),
  ensureReqId: (...args) => ensureReqIdMock(...args),
  setHttpContext: (...args) => setHttpContextMock(...args),
}));

vi.mock("../../../../src/lib/copilot-detect.js", () => ({
  detectCopilotRequest: (...args) => detectCopilotRequestMock(...args),
}));

vi.mock("../../../../src/handlers/responses/ingress-logging.js", () => ({
  logResponsesIngressRaw: (...args) => logResponsesIngressRawMock(...args),
  summarizeResponsesIngress: (...args) => summarizeResponsesIngressMock(...args),
  summarizeTools: (...args) => summarizeToolsMock(...args),
}));

vi.mock("../../../../src/handlers/responses/native/request.js", async () => {
  const actual = await vi.importActual("../../../../src/handlers/responses/native/request.js");
  return {
    ...actual,
    normalizeResponsesRequest: (...args) => normalizeResponsesRequestMock(...args),
  };
});

vi.mock("../../../../src/handlers/responses/native/capabilities.js", () => ({
  ensureResponsesCapabilities: (...args) => ensureResponsesCapabilitiesMock(...args),
}));

vi.mock("../../../../src/handlers/responses/native/execute.js", () => ({
  runNativeResponses: (...args) => runNativeResponsesMock(...args),
}));

vi.mock("../../../../src/services/transport/child-adapter.js", () => ({
  createJsonRpcChildAdapter: (...args) => createJsonRpcChildAdapterMock(...args),
}));

vi.mock("../../../../src/services/transport/index.js", () => ({
  getJsonRpcTransport: () => transportMock,
  mapTransportError: () => null,
}));

vi.mock("../../../../src/handlers/responses/stream-adapter.js", () => ({
  createResponsesStreamAdapter: (...args) => createResponsesStreamAdapterMock(...args),
}));

vi.mock("../../../../src/handlers/chat/stream-metadata-sanitizer.js", () => ({
  createStreamMetadataSanitizer: (...args) => createStreamMetadataSanitizerMock(...args),
}));

vi.mock("../../../../src/services/concurrency-guard.js", () => ({
  setupStreamGuard: (...args) => setupStreamGuardMock(...args),
  applyGuardHeaders: (...args) => applyGuardHeadersMock(...args),
}));

vi.mock("../../../../src/services/logging/schema.js", () => ({
  logStructured: (...args) => logStructuredMock(...args),
  sha256: (value) => `hash-${value}`,
}));

vi.mock("../../../../src/dev-logging.js", () => ({
  appendProtoEvent: (...args) => appendProtoEventMock(...args),
  appendUsage: (...args) => appendUsageMock(...args),
  logSanitizerSummary: (...args) => logSanitizerSummaryMock(...args),
  logSanitizerToggle: (...args) => logSanitizerToggleMock(...args),
}));

vi.mock("../../../../src/dev-trace/raw-capture.js", () => ({
  appendThinkingRawCapture: (...args) => appendThinkingRawCaptureMock(...args),
}));

vi.mock("../../../../src/utils.js", async () => {
  const actual = await vi.importActual("../../../../src/utils.js");
  return {
    ...actual,
    applyCors: (...args) => applyCorsMock(...args),
    normalizeModel: (...args) => normalizeModelMock(...args),
  };
});

vi.mock("../../../../src/config/models.js", () => ({
  acceptedModelIds: (...args) => acceptedModelIdsMock(...args),
}));

vi.mock("../../../../src/services/sse.js", () => ({
  setSSEHeaders: (...args) => setSSEHeadersMock(...args),
  computeKeepaliveMs: (...args) => computeKeepaliveMsMock(...args),
  startKeepalives: (...args) => startKeepalivesMock(...args),
}));

const makeReq = (body) => ({
  method: "POST",
  headers: {},
  body,
});

const makeRes = () => {
  const res = new EventEmitter();
  res.locals = {};
  res.headersSent = false;
  res.writableEnded = false;
  res.setHeader = vi.fn();
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.write = vi.fn();
  res.end = vi.fn(() => {
    res.writableEnded = true;
  });
  return res;
};

const restoreEnv = () => {
  if (ORIGINAL_DISABLE_INTERNAL_TOOLS === undefined) {
    delete process.env.PROXY_DISABLE_INTERNAL_TOOLS;
  } else {
    process.env.PROXY_DISABLE_INTERNAL_TOOLS = ORIGINAL_DISABLE_INTERNAL_TOOLS;
  }
  if (ORIGINAL_DISABLE_INTERNAL_TOOLS_CONFIG === undefined) {
    delete process.env.PROXY_DISABLE_INTERNAL_TOOLS_CONFIG;
  } else {
    process.env.PROXY_DISABLE_INTERNAL_TOOLS_CONFIG = ORIGINAL_DISABLE_INTERNAL_TOOLS_CONFIG;
  }
  if (ORIGINAL_DISABLE_INTERNAL_TOOLS_PROMPT === undefined) {
    delete process.env.PROXY_DISABLE_INTERNAL_TOOLS_PROMPT;
  } else {
    process.env.PROXY_DISABLE_INTERNAL_TOOLS_PROMPT = ORIGINAL_DISABLE_INTERNAL_TOOLS_PROMPT;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  restoreEnv();
  transportMock.resolveThreadForToolOutputs.mockReset();
});

afterEach(() => {
  vi.resetModules();
  restoreEnv();
});

describe("responses stream handler", () => {
  it("returns 400 when n is greater than 1", async () => {
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", n: 2 });
    const res = makeRes();

    await postResponsesStream(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ param: "n", code: "n_unsupported" }),
      })
    );
    expect(createJsonRpcChildAdapterMock).not.toHaveBeenCalled();
  });

  it("injects internal tool guidance into baseInstructions when disabled", async () => {
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    expect(createJsonRpcChildAdapterMock).toHaveBeenCalled();
    const [{ normalizedRequest }] = createJsonRpcChildAdapterMock.mock.calls[0];
    expect(normalizedRequest.turn.baseInstructions).toBe(RESPONSES_INTERNAL_TOOLS_INSTRUCTION);
    expect(normalizedRequest.turn.config).toMatchObject({
      features: {
        web_search_request: false,
        shell_tool: false,
        shell_snapshot: false,
        exec_policy: false,
        streamable_shell: false,
        unified_exec: false,
        view_image_tool: false,
        apply_patch_freeform: false,
      },
      tools: {
        web_search: false,
        view_image: false,
      },
    });
  });

  it("injects tool_choice required guidance into baseInstructions", async () => {
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      outputSchema: undefined,
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      toolChoice: "required",
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
      toolOutputs: [],
    });

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    const [{ normalizedRequest }] = createJsonRpcChildAdapterMock.mock.calls[0];
    expect(normalizedRequest.turn.baseInstructions).toContain(TOOL_CHOICE_REQUIRED_INSTRUCTION);
  });

  it("preserves unmatched tool output lines in turn items", async () => {
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [
        {
          type: "text",
          data: {
            text: [
              "[user] hi",
              '[function_call_output call_id=call_ok output="ok"]',
              '[function_call_output call_id=call_stale output="stale"]',
            ].join("\n"),
          },
        },
      ],
      responseFormat: undefined,
      outputSchema: undefined,
      tools: null,
      toolChoice: undefined,
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
      toolOutputs: [
        { callId: "call_ok", output: "ok", success: true, toolName: null },
        { callId: "call_stale", output: "stale", success: true, toolName: null },
      ],
    });
    transportMock.resolveThreadForToolOutputs.mockReturnValueOnce({
      threadId: "thread_1",
      toolset: {},
      hasUnmatched: true,
      unmatchedCount: 1,
    });
    createJsonRpcChildAdapterMock.mockImplementationOnce(() => ({
      stdin: { write: vi.fn() },
      once: vi.fn(),
      kill: vi.fn(),
      transport: {
        respondToToolCall: vi.fn((callId) => callId === "call_ok"),
        hasShimToolCall: vi.fn(() => false),
        consumeShimToolCall: vi.fn(() => null),
      },
    }));

    await postResponsesStream(req, res);

    const [{ normalizedRequest }] = createJsonRpcChildAdapterMock.mock.calls[0];
    const text = normalizedRequest.turn.items[0].data.text;
    expect(text).not.toContain("call_ok");
    expect(text).toContain("call_stale");
  });

  it("rejects native tools explicitly", async () => {
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({
      input: "hello",
      model: "gpt-5.2",
      stream: true,
      tools: [{ type: "web_search" }],
    });
    const res = makeRes();

    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      outputSchema: undefined,
      tools: [{ type: "web_search" }],
      toolChoice: undefined,
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
      toolOutputs: [],
    });

    await postResponsesStream(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ param: "tools", code: "native_tools_disabled" }),
      })
    );
    expect(createJsonRpcChildAdapterMock).not.toHaveBeenCalled();
  });

  it("skips baseInstructions when prompt flag is disabled", async () => {
    process.env.PROXY_DISABLE_INTERNAL_TOOLS = "true";
    process.env.PROXY_DISABLE_INTERNAL_TOOLS_PROMPT = "false";
    process.env.PROXY_DISABLE_INTERNAL_TOOLS_CONFIG = "true";

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    const [{ normalizedRequest }] = createJsonRpcChildAdapterMock.mock.calls[0];
    expect(normalizedRequest.turn.baseInstructions).toBeUndefined();
    expect(normalizedRequest.turn.config).toMatchObject({
      features: {
        web_search_request: false,
        shell_tool: false,
        shell_snapshot: false,
        exec_policy: false,
        streamable_shell: false,
        unified_exec: false,
        view_image_tool: false,
        apply_patch_freeform: false,
      },
      tools: {
        web_search: false,
        view_image: false,
      },
    });
  });

  it("skips turn.config when config flag is disabled", async () => {
    process.env.PROXY_DISABLE_INTERNAL_TOOLS = "true";
    process.env.PROXY_DISABLE_INTERNAL_TOOLS_PROMPT = "true";
    process.env.PROXY_DISABLE_INTERNAL_TOOLS_CONFIG = "false";

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    const [{ normalizedRequest }] = createJsonRpcChildAdapterMock.mock.calls[0];
    expect(normalizedRequest.turn.baseInstructions).toBe(RESPONSES_INTERNAL_TOOLS_INSTRUCTION);
    expect(normalizedRequest.turn.config).toBeUndefined();
  });

  it("reuses threadId and tool manifest when tool outputs are present", async () => {
    const toolset = {
      dynamicTools: [{ name: "webSearch", description: "lookup", inputSchema: {} }],
      requestTools: [{ type: "function", function: { name: "webSearch", parameters: {} } }],
    };
    transportMock.resolveThreadForToolOutputs.mockReturnValueOnce({
      threadId: "thread-123",
      toolset,
    });
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      outputSchema: undefined,
      tools: [{ type: "function", function: { name: "getFileTree", parameters: {} } }],
      toolChoice: "auto",
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
      toolOutputs: [{ callId: "call_1", output: "ok", success: true }],
    });

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    const [{ normalizedRequest }] = createJsonRpcChildAdapterMock.mock.calls[0];
    expect(normalizedRequest.turn.threadId).toBe("thread-123");
    expect(normalizedRequest.turn.dynamicTools).toEqual(toolset.dynamicTools);
    const adapterBody = createResponsesStreamAdapterMock.mock.calls[0][1];
    expect(adapterBody.tools).toEqual(toolset.requestTools);
  });

  it("does not fail when tool outputs include extra (unmatched) callIds", async () => {
    const toolset = {
      dynamicTools: [{ name: "webSearch", description: "lookup", inputSchema: {} }],
      requestTools: [{ type: "function", function: { name: "webSearch", parameters: {} } }],
    };
    transportMock.resolveThreadForToolOutputs.mockReturnValueOnce({
      threadId: "thread-123",
      toolset,
      hasUnmatched: true,
      unmatchedCount: 1,
    });
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      outputSchema: undefined,
      tools: null,
      toolChoice: undefined,
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
      toolOutputs: [{ callId: "call_1", output: "ok", success: true }],
    });

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(createJsonRpcChildAdapterMock).toHaveBeenCalled();

    const warning = logStructuredMock.mock.calls.find(
      ([entry]) => entry?.event === "tool_outputs_unmatched"
    );
    expect(warning).toBeTruthy();
    expect(warning[1]).toMatchObject({ thread_id: "thread-123", unmatched_count: 1 });
  });

  it("returns 400 when tool outputs arrive without a known thread", async () => {
    transportMock.resolveThreadForToolOutputs.mockReturnValueOnce(null);
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      outputSchema: undefined,
      tools: null,
      toolChoice: undefined,
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
      toolOutputs: [{ callId: "call_1", output: "ok", success: true }],
    });

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createJsonRpcChildAdapterMock).not.toHaveBeenCalled();
  });

  it("logs tool output summaries when provided", async () => {
    transportMock.resolveThreadForToolOutputs.mockReturnValueOnce({
      threadId: "thread-1",
      toolset: null,
    });
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
      outputSchema: undefined,
      tools: null,
      toolChoice: undefined,
      parallelToolCalls: undefined,
      maxOutputTokens: undefined,
      toolOutputs: [{ callId: "call_1", output: "ok", success: true, toolName: "lookup" }],
    });

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    const toolLog = logStructuredMock.mock.calls.find(
      ([entry]) => entry?.event === "tool_call_output"
    );
    expect(toolLog).toBeTruthy();
    expect(toolLog[1].tool_call_id).toBe("call_1");
    expect(toolLog[1].tool_name).toBe("lookup");
  });

  it("captures raw thinking deltas before sanitization", async () => {
    runNativeResponsesMock.mockImplementationOnce(async ({ onEvent }) => {
      onEvent({ type: "text_delta", delta: "hello", choiceIndex: 0 });
    });

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    expect(appendThinkingRawCaptureMock).toHaveBeenCalled();
    const call = appendThinkingRawCaptureMock.mock.calls[0][0];
    expect(call.event_type).toBe("text_delta");
    expect(call.delta).toBe("hello");
  });

  it("forwards function tools as dynamicTools on the turn payload", async () => {
    const definitions = [{ type: "function", function: { name: "lookup", parameters: {} } }];
    normalizeResponsesRequestMock.mockReturnValueOnce({
      instructions: "",
      inputItems: [{ type: "text", data: { text: "[user] hi" } }],
      responseFormat: undefined,
      outputSchema: undefined,
      tools: definitions,
      toolChoice: "auto",
      parallelToolCalls: true,
      maxOutputTokens: undefined,
    });

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");

    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    expect(createJsonRpcChildAdapterMock).toHaveBeenCalled();
    const [{ normalizedRequest }] = createJsonRpcChildAdapterMock.mock.calls[0];
    expect(normalizedRequest.turn.dynamicTools).toEqual([
      { name: "lookup", description: "", inputSchema: {} },
    ]);
    expect(normalizedRequest.turn.tools).toEqual(definitions);
    expect(normalizedRequest.message.tools).toBeUndefined();
  });

  it("submits prompt payload without op envelope", async () => {
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    const child = createJsonRpcChildAdapterMock.mock.results[0]?.value;
    expect(child?.stdin?.write).toHaveBeenCalled();
    const rawPayload = child.stdin.write.mock.calls[0][0];
    const parsed = JSON.parse(String(rawPayload).trim());
    expect(parsed.prompt).toEqual(expect.any(String));
    expect(parsed.op).toBeUndefined();
  });

  it("requests atomic dynamic tool calls for streaming responses", async () => {
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    const callArgs = runNativeResponsesMock.mock.calls[0]?.[0];
    expect(callArgs?.dynamicToolCallMode).toBe("atomic");
  });
});
