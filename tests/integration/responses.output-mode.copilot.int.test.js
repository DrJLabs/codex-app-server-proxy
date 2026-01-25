import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fetch from "node-fetch";
import { startServer, stopServer } from "./helpers.js";
import { parseSSE } from "../shared/transcript-utils.js";

const COPILOT_UA = "obsidian/1.9.7 Electron/37.2.4";

describe("/v1/responses output mode", () => {
  let serverCtx;

  beforeAll(async () => {
    serverCtx = await startServer({
      CODEX_BIN: "scripts/fake-codex-jsonrpc.js",
      PROXY_RESPONSES_OUTPUT_MODE: "openai-json",
      PROXY_SSE_KEEPALIVE_MS: "0",
    });
  }, 10_000);

  afterAll(async () => {
    if (serverCtx) await stopServer(serverCtx.child);
  });

  test("does not force obsidian-xml when Copilot headers are present", async () => {
    const res = await fetch(`http://127.0.0.1:${serverCtx.PORT}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-sk-ci",
        "Content-Type": "application/json",
        "User-Agent": COPILOT_UA,
      },
      body: JSON.stringify({ model: "codex-5", input: "ping", stream: false }),
    });

    expect(res.ok).toBe(true);
    expect(res.headers.get("x-proxy-output-mode")).toBeNull();
  });

  test("streams tool events with default openai-json mode", async () => {
    const toolServer = await startServer({
      CODEX_BIN: "scripts/fake-codex-jsonrpc.js",
      FAKE_CODEX_MODE: "tool_call",
      PROXY_RESPONSES_OUTPUT_MODE: "openai-json",
      PROXY_SSE_KEEPALIVE_MS: "0",
    });

    try {
      const res = await fetch(`http://127.0.0.1:${toolServer.PORT}/v1/responses?stream=true`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-sk-ci",
          "Content-Type": "application/json",
          "User-Agent": COPILOT_UA,
        },
        body: JSON.stringify({
          model: "codex-5",
          input: "hi",
          stream: true,
        }),
      });

      expect(res.ok).toBe(true);
      expect(res.headers.get("x-proxy-output-mode")).toBeNull();
      const raw = await res.text();
      const entries = parseSSE(raw);
      const toolEvents = entries.filter((entry) =>
        String(entry?.event || "").startsWith("response.output_item")
      );
      expect(toolEvents.length).toBeGreaterThan(0);
    } finally {
      await stopServer(toolServer.child);
    }
  });
});
