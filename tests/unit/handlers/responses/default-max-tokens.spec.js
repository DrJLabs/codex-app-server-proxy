import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const logResponsesIngressRawMock = vi.fn();
const summarizeToolsMock = vi.fn(() => ({
  tool_count: 0,
  tool_types: [],
  tool_types_truncated: false,
  tool_names: [],
  tool_names_truncated: false,
  tool_function_name_present_count: 0,
  tool_function_name_missing_count: 0,
}));
const runNativeResponsesMock = vi.fn(async () => {});
const createResponsesStreamAdapterMock = vi.fn(() => ({
  handleEvent: vi.fn(),
  finalize: vi.fn(async () => {}),
  fail: vi.fn(),
}));
const createJsonRpcChildAdapterMock = vi.fn();
const ensureResponsesCapabilitiesMock = vi.fn(async () => ({ ok: true }));
const appendUsageMock = vi.fn();

vi.mock("../../../../src/handlers/responses/ingress-logging.js", () => ({
  logResponsesIngressRaw: (...args) => logResponsesIngressRawMock(...args),
  summarizeResponsesIngress: () => ({}),
  summarizeTools: (...args) => summarizeToolsMock(...args),
}));

vi.mock("../../../../src/handlers/responses/native/execute.js", () => ({
  runNativeResponses: (...args) => runNativeResponsesMock(...args),
}));

vi.mock("../../../../src/handlers/responses/stream-adapter.js", () => ({
  createResponsesStreamAdapter: (...args) => createResponsesStreamAdapterMock(...args),
}));

vi.mock("../../../../src/services/transport/child-adapter.js", () => ({
  createJsonRpcChildAdapter: (...args) => createJsonRpcChildAdapterMock(...args),
}));

vi.mock("../../../../src/handlers/responses/native/capabilities.js", () => ({
  ensureResponsesCapabilities: (...args) => ensureResponsesCapabilitiesMock(...args),
}));

vi.mock("../../../../src/lib/copilot-detect.js", () => ({
  detectCopilotRequest: () => ({
    copilot_detected: false,
    copilot_detect_tier: null,
    copilot_detect_reasons: [],
  }),
}));

vi.mock("../../../../src/dev-logging.js", () => ({
  appendProtoEvent: vi.fn(),
  appendUsage: (...args) => appendUsageMock(...args),
  logSanitizerToggle: vi.fn(),
  logSanitizerSummary: vi.fn(),
}));

const originalDefaultMax = process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS;

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
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.write = vi.fn(() => true);
  res.flush = vi.fn();
  res.flushHeaders = vi.fn();
  res.end = vi.fn(() => {
    res.writableEnded = true;
  });
  res.writableEnded = false;
  res.once = vi.fn((event, handler) => res.on(event, handler));
  return res;
};

const buildChild = () => ({
  stdin: { write: vi.fn() },
  once: vi.fn(),
  kill: vi.fn(),
});

afterEach(() => {
  if (originalDefaultMax === undefined) {
    delete process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS;
  } else {
    process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS = originalDefaultMax;
  }
  logResponsesIngressRawMock.mockReset();
  runNativeResponsesMock.mockReset();
  createResponsesStreamAdapterMock.mockReset();
  createJsonRpcChildAdapterMock.mockReset();
  ensureResponsesCapabilitiesMock.mockReset();
  appendUsageMock.mockReset();
  vi.resetModules();
});

describe("responses default max tokens", () => {
  it("injects maxOutputTokens for stream requests when missing", async () => {
    process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS = "128";
    vi.resetModules();
    let captured;
    createJsonRpcChildAdapterMock.mockImplementation(({ normalizedRequest }) => {
      captured = normalizedRequest;
      return buildChild();
    });
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");

    await postResponsesStream(makeReq({ input: "hello", model: "gpt-5.2" }), makeRes());
    expect(captured?.message?.maxOutputTokens).toBe(128);
    expect(captured?.message?.max_output_tokens).toBeUndefined();
  });

  it("does not override maxOutputTokens for stream requests", async () => {
    process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS = "128";
    vi.resetModules();
    let captured;
    createJsonRpcChildAdapterMock.mockImplementation(({ normalizedRequest }) => {
      captured = normalizedRequest;
      return buildChild();
    });
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");

    await postResponsesStream(
      makeReq({ input: "hello", model: "gpt-5.2", max_output_tokens: 7 }),
      makeRes()
    );
    expect(captured?.message?.maxOutputTokens).toBe(7);
    expect(captured?.message?.max_output_tokens).toBeUndefined();
  });

  it("checks backend tool capabilities for function tools", async () => {
    vi.resetModules();
    const { postResponsesStream } = await import("../../../../src/handlers/responses/stream.js");

    await postResponsesStream(
      makeReq({
        input: "hello",
        model: "gpt-5.2",
        tools: [{ type: "function", name: "lookup", parameters: {} }],
      }),
      makeRes()
    );

    expect(ensureResponsesCapabilitiesMock).toHaveBeenCalledWith({ toolsRequested: true });
  });

  it("injects maxOutputTokens for non-stream requests when missing", async () => {
    process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS = "128";
    vi.resetModules();
    let captured;
    createJsonRpcChildAdapterMock.mockImplementation(({ normalizedRequest }) => {
      captured = normalizedRequest;
      return buildChild();
    });
    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );

    await postResponsesNonStream(makeReq({ input: "hello", model: "gpt-5.2" }), makeRes());
    expect(captured?.message?.maxOutputTokens).toBe(128);
    expect(captured?.message?.max_output_tokens).toBeUndefined();
  });

  it("does not override maxOutputTokens for non-stream requests", async () => {
    process.env.PROXY_RESPONSES_DEFAULT_MAX_TOKENS = "128";
    vi.resetModules();
    let captured;
    createJsonRpcChildAdapterMock.mockImplementation(({ normalizedRequest }) => {
      captured = normalizedRequest;
      return buildChild();
    });
    const { postResponsesNonStream } = await import(
      "../../../../src/handlers/responses/nonstream.js"
    );

    await postResponsesNonStream(
      makeReq({ input: "hello", model: "gpt-5.2", max_output_tokens: 9 }),
      makeRes()
    );
    expect(captured?.message?.maxOutputTokens).toBe(9);
    expect(captured?.message?.max_output_tokens).toBeUndefined();
  });
});
