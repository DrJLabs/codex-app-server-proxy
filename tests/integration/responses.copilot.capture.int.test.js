import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { startServer, stopServer } from "./helpers.js";
import { parseSSE } from "../shared/transcript-utils.js";
import {
  COPILOT_RESPONSES_FIXTURE_ROOT,
  loadCopilotResponsesFixture,
} from "../shared/copilot-fixtures.js";

describe("copilot responses fixtures", () => {
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

  const nonstreamPath = path.join(COPILOT_RESPONSES_FIXTURE_ROOT, "responses-nonstream.json");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path under repo root
  const nonstreamTest = existsSync(nonstreamPath) ? test : test.skip;

  nonstreamTest("accepts nonstream fixture request shape", async () => {
    const fixture = await loadCopilotResponsesFixture("responses-nonstream.json");
    const res = await fetch(`http://127.0.0.1:${serverCtx.PORT}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-sk-ci",
        "Content-Type": "application/json",
        ...fixture.request.headers,
      },
      body: JSON.stringify(fixture.request.body),
    });

    expect(res.ok).toBe(true);
    expect(res.headers.get("x-proxy-trace-id")).toBeTruthy();
    const payload = await res.json();
    expect(Array.isArray(payload?.output)).toBe(true);
    expect(payload.output.length).toBeGreaterThan(0);
  });

  test("streams tool fixture and emits tool events", async () => {
    const fixture = await loadCopilotResponsesFixture("responses-stream-tool.json");
    const toolServer = await startServer({
      CODEX_BIN: "scripts/fake-codex-jsonrpc.js",
      FAKE_CODEX_MODE: "tool_call",
      PROXY_RESPONSES_OUTPUT_MODE: "openai-json",
      PROXY_SSE_KEEPALIVE_MS: "0",
    });

    try {
      const res = await fetch(`http://127.0.0.1:${toolServer.PORT}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-sk-ci",
          "Content-Type": "application/json",
          ...fixture.request.headers,
        },
        body: JSON.stringify(fixture.request.body),
      });

      expect(res.ok).toBe(true);
      expect(res.headers.get("x-proxy-trace-id")).toBeTruthy();
      const raw = await res.text();
      const entries = parseSSE(raw);
      expect(entries.some((entry) => entry?.event === "response.created")).toBe(true);
      expect(entries.some((entry) => entry?.event === "response.completed")).toBe(true);
      const toolEvents = entries.filter((entry) =>
        String(entry?.event || "").includes("response.output_item")
      );
      expect(toolEvents.length).toBeGreaterThan(0);
    } finally {
      await stopServer(toolServer.child);
    }
  });
});
