import { beforeEach, describe, expect, it, vi } from "vitest";

const appendProtoEventMock = vi.fn();
const sanitizeRpcPayloadMock = vi.fn((payload) => ({ sanitized: payload }));
const ensureReqIdMock = vi.fn(() => "req-123");
const appendAppServerRawCaptureMock = vi.fn();

vi.mock("../../src/dev-logging.js", () => ({
  appendProtoEvent: (...args) => appendProtoEventMock(...args),
}));

vi.mock("../../src/dev-trace/raw-capture.js", () => ({
  appendAppServerRawCapture: (...args) => appendAppServerRawCaptureMock(...args),
}));

vi.mock("../../src/dev-trace/sanitize.js", () => ({
  sanitizeRpcPayload: (...args) => sanitizeRpcPayloadMock(...args),
}));

vi.mock("../../src/lib/request-context.js", () => ({
  ensureReqId: (...args) => ensureReqIdMock(...args),
}));

const importTargets = async () => {
  return await import("../../src/dev-trace/backend.js");
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dev-trace backend logging", () => {
  it("skips backend submissions without trace", async () => {
    const { logBackendSubmission } = await importTargets();

    logBackendSubmission({}, { rpcId: 1, method: "initialize", params: { a: 1 } });

    expect(appendProtoEventMock).not.toHaveBeenCalled();
  });

  it("logs backend submission payloads with trace", async () => {
    const { logBackendSubmission } = await importTargets();

    logBackendSubmission(
      { reqId: "req-1", route: "/v1/chat", mode: "chat", trace_id: "trace-1" },
      {
        rpcId: 2,
        method: "turn/start",
        params: { message: "hi" },
      }
    );

    expect(appendProtoEventMock).toHaveBeenCalledTimes(1);
    const payload = appendProtoEventMock.mock.calls[0][0];
    expect(payload.kind).toBe("rpc_request");
    expect(payload.rpc_id).toBe(2);
    expect(payload.payload).toEqual({ sanitized: { message: "hi" } });
    expect(payload.req_id).toBe("req-1");
    expect(payload.trace_id).toBe("trace-1");
  });

  it("logs responses as rpc_response or rpc_error", async () => {
    const { logBackendResponse } = await importTargets();

    logBackendResponse({ reqId: "req-2" }, { rpcId: 3, method: "x", result: { ok: true } });
    logBackendResponse({ reqId: "req-3" }, { rpcId: 4, method: "y", error: { code: "E" } });

    expect(appendProtoEventMock).toHaveBeenCalledTimes(2);
    expect(appendProtoEventMock.mock.calls[0][0].kind).toBe("rpc_response");
    expect(appendProtoEventMock.mock.calls[1][0].kind).toBe("rpc_error");
  });

  it("logs tool blocks when nested tool payloads exist", async () => {
    const { logBackendNotification } = await importTargets();

    logBackendNotification(
      { reqId: "req-4", trace_id: "trace-4", copilot_trace_id: "copilot-4" },
      {
        method: "codex/event/tool",
        params: { msg: { tool_calls: [{ id: "tool-1" }] } },
      }
    );

    expect(appendProtoEventMock).toHaveBeenCalledTimes(2);
    expect(appendProtoEventMock.mock.calls[0][0].kind).toBe("rpc_notification");
    expect(appendProtoEventMock.mock.calls[1][0].kind).toBe("tool_block");
    expect(appendProtoEventMock.mock.calls[0][0].trace_id).toBe("trace-4");
    expect(appendProtoEventMock.mock.calls[0][0].copilot_trace_id).toBe("copilot-4");
  });

  it("logs notification without tool payloads once", async () => {
    const { logBackendNotification } = await importTargets();

    logBackendNotification({ reqId: "req-5" }, { method: "codex/event", params: { value: 1 } });

    expect(appendProtoEventMock).toHaveBeenCalledTimes(1);
    expect(appendProtoEventMock.mock.calls[0][0].kind).toBe("rpc_notification");
  });

  it("logs backend lifecycle events with request ids", async () => {
    const { logBackendLifecycle } = await importTargets();

    logBackendLifecycle("worker_ready", { req_id: "req-6", route: "/v1", mode: "chat" });

    expect(appendProtoEventMock).toHaveBeenCalledTimes(1);
    const payload = appendProtoEventMock.mock.calls[0][0];
    expect(payload.kind).toBe("worker_ready");
    expect(payload.req_id).toBe("req-6");
  });

  it("derives trace data from responses", async () => {
    const { traceFromResponse } = await importTargets();

    expect(traceFromResponse(null)).toEqual({});
    const res = {
      locals: { httpRoute: "/v1/chat", mode: "chat", trace_id: "trace-123", copilot_trace_id: "c" },
    };
    const trace = traceFromResponse(res);

    expect(trace).toEqual({
      reqId: "req-123",
      route: "/v1/chat",
      mode: "chat",
      trace_id: "trace-123",
      copilot_trace_id: "c",
    });
  });

  it("captures app-server raw payloads for responses route", async () => {
    const { logBackendSubmission } = await importTargets();

    logBackendSubmission(
      { reqId: "req-7", route: "/v1/responses", mode: "responses_stream" },
      {
        rpcId: 9,
        method: "turn/start",
        params: { input: "hi" },
      }
    );

    expect(appendAppServerRawCaptureMock).toHaveBeenCalledTimes(1);
    expect(appendAppServerRawCaptureMock.mock.calls[0][0].req_id).toBe("req-7");
    expect(appendAppServerRawCaptureMock.mock.calls[0][0].payload).toEqual({ input: "hi" });
  });
});
