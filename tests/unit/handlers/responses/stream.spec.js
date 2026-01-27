import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  finalOutputJsonSchema: undefined,
  tools: null,
  toolChoice: undefined,
  parallelToolCalls: undefined,
  maxOutputTokens: undefined,
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
const applyCorsMock = vi.fn();
const normalizeModelMock = vi.fn((model) => ({ requested: model, effective: model }));
const acceptedModelIdsMock = vi.fn(() => new Set(["gpt-5.2", "gpt-5.2-codev-l"]));
const setSSEHeadersMock = vi.fn();
const computeKeepaliveMsMock = vi.fn(() => 0);
const startKeepalivesMock = vi.fn(() => ({ stop: vi.fn() }));

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
}));

vi.mock("../../../../src/dev-logging.js", () => ({
  appendProtoEvent: (...args) => appendProtoEventMock(...args),
  appendUsage: (...args) => appendUsageMock(...args),
  logSanitizerSummary: (...args) => logSanitizerSummaryMock(...args),
  logSanitizerToggle: (...args) => logSanitizerToggleMock(...args),
}));

vi.mock("../../../../src/utils.js", async () => {
  const actual = await vi.importActual("../../../../src/utils.js");
  return {
    ...actual,
    applyCors: (...args) => applyCorsMock(...args),
    normalizeModel: (...args) => normalizeModelMock(...args),
  };
});

vi.mock("../../../../src/config/models.js", async () => {
  const actual = await vi.importActual("../../../../src/config/models.js");
  return {
    ...actual,
    acceptedModelIds: (...args) => acceptedModelIdsMock(...args),
  };
});

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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
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

  it("does not enable apply_patch tool by default", async () => {
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2" });
    const res = makeRes();

    await postResponsesStream(req, res);

    expect(createJsonRpcChildAdapterMock).toHaveBeenCalledTimes(1);
    const adapterOptions = createJsonRpcChildAdapterMock.mock.calls[0][0];
    expect(adapterOptions.normalizedRequest.turn.includeApplyPatchTool).toBe(false);
  });

  it("forwards function tools to backend tool payload", async () => {
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

    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");

    const req = makeReq({ input: "hello", model: "gpt-5.2", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    expect(createJsonRpcChildAdapterMock).toHaveBeenCalled();
    const [{ normalizedRequest }] = createJsonRpcChildAdapterMock.mock.calls[0];
    expect(normalizedRequest.turn.tools).toEqual(
      expect.objectContaining({
        definitions,
        choice: "auto",
        parallelToolCalls: true,
      })
    );
  });

  it("infers low reasoning effort from model alias when not provided", async () => {
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({ input: "hello", model: "gpt-5.2-codev-l", stream: true });
    const res = makeRes();

    await postResponsesStream(req, res);

    const call = createJsonRpcChildAdapterMock.mock.calls[0]?.[0];
    expect(call?.normalizedRequest?.turn?.effort).toBe("low");
  });

  it("respects explicit reasoning effort over model alias", async () => {
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");
    const req = makeReq({
      input: "hello",
      model: "gpt-5.2-codev-l",
      reasoning: { effort: "high" },
      stream: true,
    });
    const res = makeRes();

    await postResponsesStream(req, res);

    const call = createJsonRpcChildAdapterMock.mock.calls[0]?.[0];
    expect(call?.normalizedRequest?.turn?.effort).toBe("high");
  });
});
