import { test, expect } from "@playwright/test";
import { startServer, stopServer } from "../integration/helpers.js";
import {
  ensureResponsesTranscripts,
  loadResponsesTranscript,
  sanitizeResponsesNonStream,
  sanitizeResponsesStreamTranscript,
  parseSSE,
} from "../shared/transcript-utils.js";

test.describe("Responses contract baselines", () => {
  test.beforeAll(() => {
    ensureResponsesTranscripts();
  });

  test("non-stream response matches transcript", async ({ request }) => {
    const transcript = await loadResponsesTranscript("nonstream-minimal.json");
    const response = await request.post("/v1/responses", {
      data: transcript.request,
    });
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    const sanitized = sanitizeResponsesNonStream(payload);
    expect(sanitized).toEqual(transcript.response);
  });

  test("non-stream tool-call response matches transcript", async ({ request: _request }) => {
    const transcript = await loadResponsesTranscript("nonstream-tool-call.json");
    const toolServer = await startServer({
      CODEX_BIN: "scripts/fake-codex-jsonrpc.js",
      FAKE_CODEX_MODE: "tool_call",
    });
    try {
      const response = await fetch(`http://127.0.0.1:${toolServer.PORT}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-sk-ci",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(transcript.request),
      });
      expect(response.ok).toBeTruthy();
      const payload = await response.json();
      const sanitized = sanitizeResponsesNonStream(payload);
      expect(sanitized).toEqual(transcript.response);
    } finally {
      await stopServer(toolServer.child);
    }
  });

  test("streaming SSE matches transcript", async ({ request }) => {
    const transcript = await loadResponsesTranscript("streaming-text.json");
    const response = await request.fetch("/v1/responses", {
      method: "POST",
      data: transcript.request,
    });
    expect(response.ok()).toBeTruthy();
    const raw = await response.text();
    const actual = parseSSE(raw);
    const sanitized = sanitizeResponsesStreamTranscript(actual);
    expect(sanitized).toEqual(transcript.stream);
  });

  test("streaming tool-call SSE matches transcript", async ({ request: _request }) => {
    const transcript = await loadResponsesTranscript("streaming-tool-call.json");
    const toolServer = await startServer({
      CODEX_BIN: "scripts/fake-codex-jsonrpc.js",
      FAKE_CODEX_MODE: "tool_call",
    });
    try {
      const response = await fetch(`http://127.0.0.1:${toolServer.PORT}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-sk-ci",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(transcript.request),
      });
      expect(response.ok).toBeTruthy();
      const raw = await response.text();
      const actual = parseSSE(raw);
      const sanitized = sanitizeResponsesStreamTranscript(actual);
      expect(sanitized).toEqual(transcript.stream);
    } finally {
      await stopServer(toolServer.child);
    }
  });
});
