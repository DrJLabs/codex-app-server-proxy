import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
  vi.resetModules();
};

afterEach(() => {
  resetEnv();
});

const readLines = async (filePath) => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp path in test
  const content = await fs.readFile(filePath, "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
};

describe("dev-trace raw capture", () => {
  it("writes app-server raw capture in dev", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "app-server-raw-"));
    process.env.PROXY_ENV = "dev";
    process.env.PROXY_CAPTURE_APP_SERVER_RAW = "true";
    process.env.PROXY_CAPTURE_APP_SERVER_RAW_DIR = dir;
    process.env.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES = "4096";
    vi.resetModules();

    const { appendAppServerRawCapture, __whenRawCaptureIdle, resolveAppServerRawPath } =
      await import("../../src/dev-trace/raw-capture.js");

    appendAppServerRawCapture({
      req_id: "req-1",
      trace_id: "trace-1",
      copilot_trace_id: "copilot-1",
      rpc_id: 7,
      direction: "inbound",
      method: "responses/stream",
      payload: { ok: true },
    });

    const filePath = resolveAppServerRawPath();
    await __whenRawCaptureIdle(filePath);
    const lines = await readLines(filePath);
    expect(lines.length).toBe(1);
    expect(lines[0].req_id).toBe("req-1");
    expect(lines[0].payload).toEqual({ ok: true });
  });

  it("writes thinking raw capture in dev", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thinking-raw-"));
    process.env.PROXY_ENV = "dev";
    process.env.PROXY_CAPTURE_THINKING_RAW = "true";
    process.env.PROXY_CAPTURE_THINKING_RAW_DIR = dir;
    process.env.PROXY_CAPTURE_THINKING_RAW_MAX_BYTES = "4096";
    vi.resetModules();

    const { appendThinkingRawCapture, __whenRawCaptureIdle, resolveThinkingRawPath } = await import(
      "../../src/dev-trace/raw-capture.js"
    );

    appendThinkingRawCapture({
      req_id: "req-2",
      trace_id: "trace-2",
      copilot_trace_id: "copilot-2",
      event_type: "text_delta",
      delta: "hello",
    });

    const filePath = resolveThinkingRawPath();
    await __whenRawCaptureIdle(filePath);
    const lines = await readLines(filePath);
    expect(lines.length).toBe(1);
    expect(lines[0].req_id).toBe("req-2");
    expect(lines[0].delta).toBe("hello");
  });
});
