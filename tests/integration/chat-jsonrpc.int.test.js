import { afterEach, describe, expect, it } from "vitest";
import fetch from "node-fetch";
import { spawnServer, stopServer, wait, waitForUrlOk } from "./helpers.js";
import { config as CFG } from "../../src/config/index.js";

const CAPTURE_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 5;
const INTERNAL_TOOLS_INSTRUCTION =
  "Never use internal tools (shell/exec_command/apply_patch/update_plan/view_image). Request only dynamic tool calls provided by the client.";

const mapSandboxPolicyType = (mode) => {
  switch (String(mode || "").trim()) {
    case "read-only":
      return "readOnly";
    case "workspace-write":
      return "workspaceWrite";
    case "danger-full-access":
      return "dangerFullAccess";
    default:
      return mode;
  }
};

const attachCaptureCollector = (stream, out) => {
  if (!stream) return;
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        const jsonStart = line.indexOf("{");
        if (jsonStart >= 0) {
          const candidate = line.slice(jsonStart);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed?.capture?.payload) {
              out.push(parsed.capture);
            }
          } catch {}
        }
      }
      idx = buffer.indexOf("\n");
    }
  });
};

async function startServerWithCapture(envOverrides = {}) {
  const captures = [];
  const server = await spawnServer(
    {
      PROXY_API_KEY: envOverrides.PROXY_API_KEY || "test-sk-ci",
      CODEX_BIN: envOverrides.CODEX_BIN || "scripts/fake-codex-jsonrpc.js",
      PROXY_USE_APP_SERVER: "true",
      PROXY_PROTECT_MODELS: envOverrides.PROXY_PROTECT_MODELS || "false",
      FAKE_CODEX_CAPTURE_RPCS: "true",
      ...(envOverrides || {}),
    },
    { waitForReady: true }
  );
  attachCaptureCollector(server.child.stdout, captures);
  attachCaptureCollector(server.child.stderr, captures);
  return { PORT: server.PORT, child: server.child, captures };
}

const waitForCapture = async (captures, predicate, timeoutMs = CAPTURE_TIMEOUT_MS) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (captures.some(predicate)) return;
    await wait(50);
  }
  throw new Error("timeout waiting for JSON-RPC capture");
};

const findCapture = (captures, method) =>
  captures
    .slice()
    .reverse()
    .find((entry) => entry?.payload?.method === method);

const postChatCompletions = async (port, payload) => {
  let response;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-sk-ci",
      },
      body: JSON.stringify(payload),
    });
    if (response.status !== 503) break;
    await wait(200);
  }
  return response;
};

const readSSEBody = async (body) => {
  if (!body) throw new Error("Expected response body for streaming request");
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  return chunks.join("");
};

const parseSSEPayloads = (raw) => {
  if (!raw) return [];
  return raw
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\n/).map((line) => line.trim());
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!dataLine) return null;
      return dataLine.slice("data:".length).trimStart();
    })
    .filter((value) => value !== null);
};

describe("chat JSON-RPC normalization", () => {
  let server;

  afterEach(async () => {
    if (server?.child) {
      await stopServer(server.child);
      server = null;
    }
  });

  it("maps chat completions request fields into JSON-RPC payloads", async () => {
    server = await startServerWithCapture({
      PROXY_API_KEY: "test-sk-ci",
      PROXY_IGNORE_CLIENT_SYSTEM_PROMPT: "false",
    });

    const payload = {
      model: "codex-5",
      stream: false,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 128,
      reasoning: { effort: "medium" },
      parallel_tool_calls: true,
      stream_options: { include_usage: false },
      user: "tester",
      messages: [
        { role: "system", content: "You are Codex" },
        { role: "user", content: "List files" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "list_files",
            description: "lists files",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "list_files" } },
    };

    const response = await postChatCompletions(server.PORT, payload);

    expect(response.status).toBe(200);
    await response.json();

    await waitForCapture(server.captures, (entry) => entry?.payload?.method === "turn/start");

    const threadStartCapture = findCapture(server.captures, "thread/start");
    expect(threadStartCapture).toBeDefined();
    const threadStartParams = threadStartCapture?.payload?.params ?? {};
    expect(threadStartParams.model).toBe(CFG.CODEX_MODEL);
    expect(threadStartParams.cwd).toBe(CFG.PROXY_CODEX_WORKDIR);
    expect(threadStartParams.sandbox).toBe(CFG.PROXY_SANDBOX_MODE);
    const expectedBaseInstructions = [
      payload.messages.find((msg) => msg.role === "system")?.content ?? undefined,
      CFG.PROXY_DISABLE_INTERNAL_TOOLS ? INTERNAL_TOOLS_INSTRUCTION : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    expect(threadStartParams.baseInstructions).toBe(expectedBaseInstructions);
    const expectedApproval = (() => {
      const raw = process.env.PROXY_APPROVAL_POLICY ?? process.env.CODEX_APPROVAL_POLICY ?? "never";
      const normalized = String(raw).trim().toLowerCase();
      return normalized || "never";
    })();
    expect(threadStartParams.approvalPolicy).toBe(expectedApproval);
    expect(threadStartParams.dynamicTools).toEqual([
      {
        name: "list_files",
        description: "lists files",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
      },
    ]);

    const turnCapture = findCapture(server.captures, "turn/start");
    expect(turnCapture).toBeDefined();
    const turnParams = turnCapture.payload?.params ?? {};
    expect(turnParams.model).toBe(CFG.CODEX_MODEL);
    expect(turnParams.approvalPolicy).toBe(expectedApproval);
    expect(turnParams.cwd).toBe(CFG.PROXY_CODEX_WORKDIR);
    expect(turnParams.summary).toBe("auto");
    expect(turnParams.effort).toBe("medium");
    expect(turnParams.sandboxPolicy).toMatchObject({
      type: mapSandboxPolicyType(CFG.PROXY_SANDBOX_MODE),
    });
    expect(turnParams.input).toBeInstanceOf(Array);
    expect(turnParams.input?.[0]).toMatchObject({
      type: "text",
      text: payload.messages.find((msg) => msg.role === "user")?.content,
    });
    expect(turnParams.threadId).toBeDefined();
  }, 20000);

  it("routes streaming requests through turn/start payloads", async () => {
    server = await startServerWithCapture({ PROXY_API_KEY: "test-sk-ci" });

    const payload = {
      model: "codex-5",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Stream hello" }],
    };

    const response = await postChatCompletions(server.PORT, payload);

    expect(response.status).toBe(200);
    try {
      response.body?.destroy?.();
    } catch {}

    await waitForCapture(server.captures, (entry) => entry?.payload?.method === "turn/start");
    const turnCapture = findCapture(server.captures, "turn/start");
    expect(turnCapture).toBeDefined();
    const streamingTurnParams = turnCapture?.payload?.params ?? {};
    expect(streamingTurnParams.model).toBe(CFG.CODEX_MODEL);
    expect(streamingTurnParams.sandboxPolicy).toMatchObject({
      type: mapSandboxPolicyType(CFG.PROXY_SANDBOX_MODE),
    });
    expect(streamingTurnParams.input?.[0]?.text).toBe("Stream hello");
  }, 20000);

  it("returns invalid_request_error for non-numeric temperature", async () => {
    server = await startServerWithCapture({ PROXY_API_KEY: "test-sk-ci" });

    const payload = {
      model: "codex-5",
      messages: [{ role: "user", content: "hello" }],
      temperature: "fast",
    };

    const response = await postChatCompletions(server.PORT, payload);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.param).toBe("temperature");
  }, 20000);

  it("streams SSE deltas and usage metrics for baseline responses", async () => {
    server = await startServerWithCapture({ PROXY_API_KEY: "test-sk-ci" });

    const payload = {
      model: "codex-5",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Say hello" }],
    };

    const response = await postChatCompletions(server.PORT, payload);
    expect(response.status).toBe(200);

    const raw = await readSSEBody(response.body);
    const payloads = parseSSEPayloads(raw);
    expect(payloads.length).toBeGreaterThan(2);
    expect(payloads[payloads.length - 1]).toBe("[DONE]");

    const jsonEvents = payloads
      .filter((entry) => entry !== "[DONE]")
      .map((entry) => JSON.parse(entry));

    const roleChunk = jsonEvents[0];
    expect(roleChunk.choices?.[0]?.delta?.role).toBe("assistant");

    const contentChunk = jsonEvents.find((evt) => evt.choices?.[0]?.delta?.content);
    expect(contentChunk?.choices?.[0]?.delta?.content).toContain("Hello from fake-codex");

    const usageChunk = jsonEvents.find(
      (evt) => Array.isArray(evt.choices) && evt.choices.length === 0 && evt.usage
    );
    expect(usageChunk).toBeDefined();
    expect(typeof usageChunk.usage.prompt_tokens).toBe("number");
    expect(typeof usageChunk.usage.completion_tokens).toBe("number");
    expect(typeof usageChunk.usage.time_to_first_token_ms).toBe("number");
    expect(usageChunk.usage.time_to_first_token_ms).toBeGreaterThanOrEqual(0);
    expect(typeof usageChunk.usage.total_duration_ms).toBe("number");
    expect(usageChunk.usage.total_duration_ms).toBeGreaterThanOrEqual(
      usageChunk.usage.time_to_first_token_ms ?? 0
    );

    const finishChunk = jsonEvents
      .slice()
      .reverse()
      .find(
        (evt) =>
          Array.isArray(evt.choices) &&
          evt.choices.length > 0 &&
          evt.choices.every((choice) => choice.finish_reason)
      );
    expect(finishChunk?.choices?.[0]?.finish_reason).toBe("stop");
  }, 20000);

  it("streams tool call deltas and reports finish reasons", async () => {
    server = await startServerWithCapture({
      PROXY_API_KEY: "test-sk-ci",
      FAKE_CODEX_MODE: "tool_call",
    });

    const payload = {
      model: "codex-5",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Plan a tool call" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_user",
            description: "Lookup user by id",
            parameters: { type: "object", properties: { id: { type: "string" } } },
          },
        },
      ],
    };

    const response = await postChatCompletions(server.PORT, payload);
    expect(response.status).toBe(200);

    const raw = await readSSEBody(response.body);
    const payloads = parseSSEPayloads(raw);
    expect(payloads[payloads.length - 1]).toBe("[DONE]");
    const jsonEvents = payloads
      .filter((entry) => entry !== "[DONE]")
      .map((entry) => JSON.parse(entry));

    const toolDelta = jsonEvents.find(
      (evt) => evt.choices?.[0]?.delta?.tool_calls && evt.choices[0].delta.tool_calls.length
    );
    expect(toolDelta).toBeDefined();
    expect(toolDelta.choices[0].delta.tool_calls[0]).toMatchObject({
      id: expect.any(String),
      type: "function",
    });

    const finishChunk = jsonEvents
      .slice()
      .reverse()
      .find(
        (evt) =>
          Array.isArray(evt.choices) &&
          evt.choices.length > 0 &&
          evt.choices.every((choice) => choice.finish_reason)
      );
    expect(finishChunk?.choices?.[0]?.finish_reason).toBe("tool_calls");

    const usageChunk = jsonEvents.find(
      (evt) => Array.isArray(evt.choices) && evt.choices.length === 0 && evt.usage
    );
    expect(usageChunk).toBeDefined();
    expect(typeof usageChunk.usage.time_to_first_token_ms).toBe("number");
    expect(usageChunk.usage.time_to_first_token_ms).toBeGreaterThanOrEqual(0);
  }, 20000);

  it("rejects invalid tool definitions", async () => {
    server = await startServerWithCapture({ PROXY_API_KEY: "test-sk-ci" });

    const payload = {
      model: "codex-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            description: "missing name",
          },
        },
      ],
    };

    const response = await postChatCompletions(server.PORT, payload);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.param).toBe("tools[0].function.name");
  }, 20000);

  it("accepts assistant history and forwards it as flattened prompt", async () => {
    server = await startServerWithCapture({ PROXY_API_KEY: "test-sk-ci" });

    const payload = {
      model: "codex-5",
      messages: [
        { role: "system", content: "Keep concise" },
        { role: "assistant", content: "previous reply" },
        { role: "user", content: "continue" },
      ],
    };

    const response = await postChatCompletions(server.PORT, payload);

    expect(response.status).toBe(200);
    await response.json();

    await waitForCapture(server.captures, (entry) => entry?.payload?.method === "turn/start");
    const turnCapture = findCapture(server.captures, "turn/start");
    expect(turnCapture).toBeDefined();
    const promptText = turnCapture.payload?.params?.input?.[0]?.text || "";
    expect(promptText).toContain("[assistant] previous reply");
    expect(promptText).toContain("[user] continue");
  }, 20000);
});

describe("chat JSON-RPC error handling", () => {
  let server;

  afterEach(async () => {
    if (server?.child) {
      await stopServer(server.child);
      server = null;
    }
  });

  const buildPayload = () => ({
    model: "codex-5",
    stream: false,
    messages: [{ role: "user", content: "trigger" }],
  });

  const authHeaders = () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer test-sk-ci",
  });

  const requestUrl = (port) => `http://127.0.0.1:${port}/v1/chat/completions`;

  it("surfaces worker_busy as 429 rate limit with retryable hint", async () => {
    server = await startServerWithCapture({
      PROXY_API_KEY: "test-sk-ci",
      WORKER_MAX_CONCURRENCY: "1",
      WORKER_REQUEST_TIMEOUT_MS: "5000",
      FAKE_CODEX_JSONRPC_HANG: "message",
    });

    await waitForUrlOk(`http://127.0.0.1:${server.PORT}/readyz`);

    const controller = new AbortController();
    const firstPromise = fetch(requestUrl(server.PORT), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(buildPayload()),
      signal: controller.signal,
    }).catch(() => {});

    await wait(200);

    const secondResponse = await fetch(requestUrl(server.PORT), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(buildPayload()),
    });

    expect(secondResponse.status).toBe(429);
    const body = await secondResponse.json();
    expect(body.error).toMatchObject({
      code: "worker_busy",
      type: "rate_limit_error",
      retryable: true,
    });

    controller.abort();
    await firstPromise;
  }, 20000);

  it("blocks requests when handshake is not ready", async () => {
    server = await startServerWithCapture({
      PROXY_API_KEY: "test-sk-ci",
      WORKER_HANDSHAKE_TIMEOUT_MS: "200",
      FAKE_CODEX_HANDSHAKE_MODE: "timeout",
    });

    await waitForUrlOk(`http://127.0.0.1:${server.PORT}/readyz`);

    const response = await fetch(requestUrl(server.PORT), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(buildPayload()),
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "worker_not_ready",
      type: "backend_unavailable",
      retryable: true,
    });
    expect(body?.worker_status?.ready).toBe(false);
  }, 20000);

  it("surfaces worker request timeout as 504 timeout_error with retryable hint", async () => {
    server = await startServerWithCapture({
      PROXY_API_KEY: "test-sk-ci",
      WORKER_REQUEST_TIMEOUT_MS: "200",
      FAKE_CODEX_JSONRPC_HANG: "message",
    });

    await waitForUrlOk(`http://127.0.0.1:${server.PORT}/readyz`);

    const response = await fetch(requestUrl(server.PORT), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(buildPayload()),
    });

    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "worker_request_timeout",
      type: "timeout_error",
      retryable: true,
    });
  }, 20000);

  it("surfaces worker exit as 503 backend_unavailable with retryable hint", async () => {
    server = await startServerWithCapture({
      PROXY_API_KEY: "test-sk-ci",
      FAKE_CODEX_MODE: "crash",
    });

    await waitForUrlOk(`http://127.0.0.1:${server.PORT}/readyz`);

    const response = await fetch(requestUrl(server.PORT), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(buildPayload()),
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "worker_exited",
      type: "backend_unavailable",
      retryable: true,
    });
  }, 20000);
});
