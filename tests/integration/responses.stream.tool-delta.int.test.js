import { beforeAll, afterAll, test, expect } from "vitest";
import { startServer, stopServer } from "./helpers.js";
import { parseSSE } from "../shared/transcript-utils.js";

let serverCtx;

beforeAll(async () => {
  serverCtx = await startServer({
    CODEX_BIN: "scripts/fake-codex-jsonrpc.js",
    FAKE_CODEX_MODE: "tool_call",
    FAKE_CODEX_PARALLEL: "true",
    PROXY_SSE_KEEPALIVE_MS: "0",
  });
}, 10_000);

afterAll(async () => {
  if (serverCtx) await stopServer(serverCtx.child);
});

const getCompletedEnvelope = (entries) =>
  entries.find((entry) => entry?.type === "data" && entry.event === "response.completed")?.data
    ?.response || null;

test("aggregates streaming tool-call fragments into final response", async () => {
  const res = await fetch(`http://127.0.0.1:${serverCtx.PORT}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-sk-ci",
    },
    body: JSON.stringify({
      model: "codex-5",
      stream: true,
      stream_options: { include_usage: true },
      input: "call tool",
    }),
  });

  expect(res.ok).toBeTruthy();
  const raw = await res.text();
  const entries = parseSSE(raw);

  // Ensure the adapter emitted the canonical typed events in order
  const eventNames = entries
    .filter((entry) => entry?.type === "data" && entry.event)
    .map((entry) => entry.event);
  expect(eventNames[0]).toBe("response.created");
  expect(eventNames).toContain("response.completed");

  const completed = getCompletedEnvelope(entries);
  expect(completed).not.toBeNull();
  expect(completed.status).toBe("completed");
  expect(completed.model).toBe("codex-5");

  const output = Array.isArray(completed.output) ? completed.output : [];
  const message = output.find((item) => item?.type === "message");
  const functionCall = output.find((item) => item?.type === "function_call");
  expect(message).toBeDefined();
  expect(functionCall).toBeDefined();
  expect(message.role).toBe("assistant");
  expect(Array.isArray(message.content)).toBe(true);
  const content = message.content.filter(Boolean);
  expect(content.some((node) => node.type === "output_text")).toBe(true);
  expect(functionCall.name).toBe("lookup_user");
  expect(functionCall.arguments).toBe('{"id":"42"}');

  // Fake codex emits <use_tool> text alongside tool calls; keep it deterministic in outputs.
  const textNode = content.find((node) => node.type === "output_text");
  expect(textNode?.text || "").toContain("<use_tool>");

  // Usage should be included when stream_options.include_usage=true.
  expect(completed.usage).toMatchObject({
    input_tokens: expect.any(Number),
    output_tokens: expect.any(Number),
    total_tokens: expect.any(Number),
  });
});

test("omits usage when stream_options.include_usage is not requested", async () => {
  const res = await fetch(`http://127.0.0.1:${serverCtx.PORT}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-sk-ci",
    },
    body: JSON.stringify({
      model: "codex-5",
      stream: true,
      input: "no usage",
    }),
  });

  expect(res.ok).toBeTruthy();
  const raw = await res.text();
  const entries = parseSSE(raw);
  const completed = getCompletedEnvelope(entries);
  expect(completed).not.toBeNull();
  expect(completed.usage).toBeUndefined();
});
