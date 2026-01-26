import { beforeEach, describe, expect, it, vi } from "vitest";

const mkdirMock = vi.fn();
const writeFileMock = vi.fn();
const sanitizeCaptureIdMock = vi.fn();
const createCaptureSanitizersMock = vi.fn();
const summarizeResponsesIngressMock = vi.fn();
const configMock = {
  PROXY_CAPTURE_RESPONSES_TRANSCRIPTS: false,
  PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS: false,
  PROXY_CAPTURE_RESPONSES_DIR: "/tmp/responses",
  PROXY_CAPTURE_RESPONSES_RAW_DIR: "/tmp/responses-raw",
};

let sanitizeValueMock;
let sanitizeHeadersMock;
let sanitizeHeadersRawMock;

vi.mock("node:fs/promises", () => ({
  mkdir: (...args) => mkdirMock(...args),
  writeFile: (...args) => writeFileMock(...args),
}));

vi.mock("../../../../src/config/index.js", () => ({
  config: configMock,
}));

vi.mock("../../../../src/handlers/responses/ingress-logging.js", () => ({
  summarizeResponsesIngress: (...args) => summarizeResponsesIngressMock(...args),
  summarizeTools: vi.fn(() => ({
    tool_count: 0,
    tool_types: [],
    tool_types_truncated: false,
    tool_names: [],
    tool_names_truncated: false,
    tool_function_name_present_count: 0,
    tool_function_name_missing_count: 0,
  })),
}));

vi.mock("../../../../src/lib/capture/sanitize.js", async () => {
  const actual = await vi.importActual("../../../../src/lib/capture/sanitize.js");
  return {
    ...actual,
    createCaptureSanitizers: (...args) => createCaptureSanitizersMock(...args),
    sanitizeCaptureId: (...args) => sanitizeCaptureIdMock(...args),
  };
});

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

const loadCapture = async () => {
  vi.resetModules();
  return await import("../../../../src/handlers/responses/capture.js");
};

beforeEach(() => {
  configMock.PROXY_CAPTURE_RESPONSES_TRANSCRIPTS = false;
  configMock.PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS = false;
  configMock.PROXY_CAPTURE_RESPONSES_DIR = "/tmp/responses";
  configMock.PROXY_CAPTURE_RESPONSES_RAW_DIR = "/tmp/responses-raw";

  mkdirMock.mockReset().mockResolvedValue(undefined);
  writeFileMock.mockReset().mockResolvedValue(undefined);
  sanitizeCaptureIdMock
    .mockReset()
    .mockImplementation((value) =>
      typeof value === "string" ? value.replace(/[^a-z0-9-]+/gi, "") : ""
    );

  sanitizeValueMock = vi.fn((value) => ({ sanitized: value }));
  sanitizeHeadersMock = vi.fn((value) => ({ sanitized: value }));
  sanitizeHeadersRawMock = vi.fn((value) => ({ raw: value }));
  createCaptureSanitizersMock.mockReset().mockReturnValue({
    sanitizeValue: sanitizeValueMock,
    sanitizeHeaders: sanitizeHeadersMock,
    sanitizeHeadersRaw: sanitizeHeadersRawMock,
  });
  summarizeResponsesIngressMock.mockReset().mockReturnValue({ summary: "ok" });
});

describe("responses capture", () => {
  it("returns early when capture is disabled", async () => {
    const { captureResponsesNonStream } = await loadCapture();

    captureResponsesNonStream({
      req: { headers: {} },
      res: { locals: {} },
      requestBody: { input: "hi" },
      responseBody: { id: "resp" },
    });

    await flushPromises();

    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("writes sanitized nonstream capture when enabled", async () => {
    configMock.PROXY_CAPTURE_RESPONSES_TRANSCRIPTS = true;
    const { captureResponsesNonStream } = await loadCapture();

    captureResponsesNonStream({
      req: { headers: { "x-proxy-capture-id": "demo" } },
      res: { locals: { req_id: "req-1" } },
      requestBody: { input: "hi" },
      responseBody: { id: "resp" },
      outputModeEffective: "text",
    });

    await flushPromises();

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [target, data] = writeFileMock.mock.calls[0];
    const payload = JSON.parse(String(data));

    expect(target).toContain("/tmp/responses");
    expect(target.endsWith("demo-nonstream.json")).toBe(true);
    expect(payload.metadata.scenario).toBe("demo-nonstream");
    expect(payload.metadata.stream).toBe(false);
    expect(payload.metadata.outcome).toBe("completed");
    expect(payload.metadata.ingress_summary).toEqual({ summary: "ok" });
    expect(payload.request.headers).toEqual({
      sanitized: { "x-proxy-capture-id": "demo" },
    });
    expect(payload.request.body).toEqual({ sanitized: { input: "hi" } });
    expect(payload.response).toEqual({ sanitized: { id: "resp" } });
    expect(sanitizeHeadersMock).toHaveBeenCalledWith({ "x-proxy-capture-id": "demo" });
    expect(sanitizeValueMock).toHaveBeenCalledWith({ input: "hi" });
    expect(sanitizeValueMock).toHaveBeenCalledWith({ id: "resp" });
  });

  it("writes raw nonstream capture when enabled", async () => {
    configMock.PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS = true;
    const { captureResponsesNonStream } = await loadCapture();

    captureResponsesNonStream({
      req: { headers: { "x-proxy-capture-id": "demo" } },
      res: { locals: {} },
      requestBody: { input: "hi" },
      responseBody: { id: "resp" },
    });

    await flushPromises();

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [target, data] = writeFileMock.mock.calls[0];
    const payload = JSON.parse(String(data));

    expect(target).toContain("/tmp/responses-raw");
    expect(target.endsWith("demo-nonstream.json")).toBe(true);
    expect(payload.request.headers).toEqual({ raw: { "x-proxy-capture-id": "demo" } });
    expect(payload.request.body).toEqual({ input: "hi" });
    expect(payload.response).toEqual({ id: "resp" });
    expect(sanitizeHeadersRawMock).toHaveBeenCalledWith({ "x-proxy-capture-id": "demo" });
    expect(sanitizeHeadersMock).not.toHaveBeenCalled();
  });

  it("records and finalizes stream captures", async () => {
    configMock.PROXY_CAPTURE_RESPONSES_TRANSCRIPTS = true;
    const { createResponsesStreamCapture } = await loadCapture();

    const capture = createResponsesStreamCapture({
      req: { headers: { "x-proxy-capture-id": "demo" } },
      res: { locals: {} },
      requestBody: { input: "hi" },
      outputModeEffective: "text",
    });

    capture.record("message", { id: "chunk" });
    capture.record("done", "[DONE]");
    capture.finalize();

    await flushPromises();

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, data] = writeFileMock.mock.calls[0];
    const payload = JSON.parse(String(data));

    expect(payload.metadata.scenario).toBe("demo-stream");
    expect(payload.metadata.outcome).toBe("completed");
    expect(payload.stream).toHaveLength(2);
    expect(payload.stream[0].type).toBe("data");
    expect(payload.stream[0].event).toBe("message");
    expect(payload.stream[0].data).toEqual({ sanitized: { id: "chunk" } });
    expect(payload.stream[1].type).toBe("done");
    expect(payload.stream[1].event).toBe("done");
  });
});
