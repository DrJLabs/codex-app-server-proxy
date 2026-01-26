import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

let transport;

const logStructured = vi.fn();

vi.mock("../../../src/services/logging/schema.js", () => ({
  logStructured,
}));

vi.mock("../../../src/services/transport/index.js", async () => {
  const actual = await vi.importActual("../../../src/services/transport/index.js");
  return {
    ...actual,
    getJsonRpcTransport: () => transport,
  };
});

const ORIGINAL_AUTH_LOGIN_URL = process.env.PROXY_AUTH_LOGIN_URL;

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

const loadAdapter = async () => {
  vi.resetModules();
  const adapterModule = await import("../../../src/services/transport/child-adapter.js");
  const transportModule = await import("../../../src/services/transport/index.js");
  return {
    createJsonRpcChildAdapter: adapterModule.createJsonRpcChildAdapter,
    TransportError: transportModule.TransportError,
  };
};

const setupAdapter = async (options = {}) => {
  const { createJsonRpcChildAdapter } = await loadAdapter();
  const emitter = new EventEmitter();
  let resolvePromise;
  const context = {
    emitter,
    usage: { prompt_tokens: 2, completion_tokens: 3 },
    promise: new Promise((resolve) => {
      resolvePromise = resolve;
    }),
  };

  transport = {
    createChatRequest: vi.fn(async () => context),
    sendUserMessage: vi.fn(),
    cancelContext: vi.fn(),
  };

  const adapter = createJsonRpcChildAdapter({
    reqId: "req-test",
    timeoutMs: 1000,
    trace: { route: "/v1/chat/completions", mode: "chat_stream" },
    ...options,
  });

  const stdout = [];
  const stderr = [];
  const exits = [];

  adapter.stdout.on("data", (chunk) => {
    const trimmed = String(chunk || "").trim();
    if (!trimmed) return;
    stdout.push(JSON.parse(trimmed));
  });
  adapter.stderr.on("data", (chunk) => {
    const trimmed = String(chunk || "").trim();
    if (!trimmed) return;
    stderr.push(trimmed);
  });
  adapter.on("exit", (code) => exits.push(code));

  return { adapter, emitter, context, resolvePromise, stdout, stderr, exits };
};

afterEach(() => {
  transport = undefined;
  if (ORIGINAL_AUTH_LOGIN_URL === undefined) {
    delete process.env.PROXY_AUTH_LOGIN_URL;
  } else {
    process.env.PROXY_AUTH_LOGIN_URL = ORIGINAL_AUTH_LOGIN_URL;
  }
  vi.clearAllMocks();
  logStructured.mockClear();
});

describe("JsonRpcChildAdapter auth handling", () => {
  it("cancels context when error notification indicates 401 and willRetry is false", async () => {
    process.env.PROXY_AUTH_LOGIN_URL = "false";
    const { createJsonRpcChildAdapter, TransportError } = await loadAdapter();
    const emitter = new EventEmitter();
    let resolvePromise;
    const context = {
      emitter,
      promise: new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    };

    transport = {
      createChatRequest: vi.fn(async () => context),
      sendUserMessage: vi.fn(),
      cancelContext: vi.fn(),
    };

    const adapter = createJsonRpcChildAdapter({
      reqId: "req-auth",
      timeoutMs: 1000,
      trace: { route: "/v1/responses", mode: "responses_stream" },
    });

    adapter.stdin.write(JSON.stringify({ prompt: "hello" }));
    await flushAsync();

    emitter.emit("notification", {
      method: "error",
      params: {
        error: {
          message: "unexpected status 401 Unauthorized: ",
          codexErrorInfo: "other",
        },
        willRetry: false,
      },
    });

    await flushAsync();

    expect(transport.cancelContext).toHaveBeenCalledTimes(1);
    expect(transport.cancelContext).toHaveBeenCalledWith(context, expect.any(TransportError));
    const errorArg = transport.cancelContext.mock.calls[0][1];
    expect(errorArg.code).toBe("auth_required");

    resolvePromise();
    await flushAsync();
  });

  it("attaches login details when auth login flag is enabled", async () => {
    process.env.PROXY_AUTH_LOGIN_URL = "true";
    const { createJsonRpcChildAdapter } = await loadAdapter();
    const emitter = new EventEmitter();
    let resolvePromise;
    const context = {
      emitter,
      promise: new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    };

    transport = {
      createChatRequest: vi.fn(async () => context),
      sendUserMessage: vi.fn(),
      cancelContext: vi.fn(),
      getAuthLoginDetails: vi.fn(async () => ({
        auth_url: "https://example.test/login",
        login_id: "login-123",
      })),
    };

    const adapter = createJsonRpcChildAdapter({
      reqId: "req-auth-details",
      timeoutMs: 1000,
      trace: { route: "/v1/chat/completions", mode: "chat_stream" },
    });

    adapter.stdin.write(JSON.stringify({ prompt: "hello" }));
    await flushAsync();

    emitter.emit("notification", {
      method: "error",
      params: {
        codexErrorInfo: "unauthorized",
        willRetry: false,
      },
    });

    await flushAsync();
    await flushAsync();

    expect(transport.getAuthLoginDetails).toHaveBeenCalledTimes(1);
    expect(transport.cancelContext).toHaveBeenCalledTimes(1);
    const errorArg = transport.cancelContext.mock.calls[0][1];
    expect(errorArg.code).toBe("auth_required");
    expect(errorArg.details).toMatchObject({
      auth_url: "https://example.test/login",
      login_id: "login-123",
    });

    resolvePromise();
    await flushAsync();
  });

  it("redacts inline auth URLs in auth_required log entries", async () => {
    process.env.PROXY_AUTH_LOGIN_URL = "false";
    const { createJsonRpcChildAdapter } = await loadAdapter();
    const emitter = new EventEmitter();
    let resolvePromise;
    const context = {
      emitter,
      promise: new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    };

    transport = {
      createChatRequest: vi.fn(async () => context),
      sendUserMessage: vi.fn(),
      cancelContext: vi.fn(),
    };

    const adapter = createJsonRpcChildAdapter({
      reqId: "req-auth-log",
      timeoutMs: 1000,
      trace: { route: "/v1/chat/completions", mode: "chat_stream" },
    });

    adapter.stdin.write(JSON.stringify({ prompt: "hello" }));
    await flushAsync();

    emitter.emit("notification", {
      method: "error",
      params: {
        codexErrorInfo: "unauthorized",
        error: {
          message: "unauthorized | login_url=https://example.test/oauth?x=1,y=2 | login_id=abc",
          codexErrorInfo: "other",
        },
        willRetry: false,
      },
    });

    await flushAsync();

    expect(logStructured).toHaveBeenCalled();
    const [, extras] = logStructured.mock.calls[0];
    expect(extras.error_message).toContain("login_url=[REDACTED]");
    expect(extras.error_message).not.toContain("example.test");
    expect(extras.error_message).not.toContain("y=2");

    resolvePromise();
    await flushAsync();
  });
});

describe("JsonRpcChildAdapter normalization", () => {
  it("uses op items to derive the prompt for message items", async () => {
    const { adapter, context, resolvePromise } = await setupAdapter();

    adapter.stdin.write(JSON.stringify({ op: { items: [{ text: "from-op" }] } }));
    await flushAsync();

    expect(transport.sendUserMessage).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        items: [{ type: "text", data: { text: "from-op" } }],
      })
    );

    resolvePromise();
    await flushAsync();
  });

  it("uses prompt text when op items are missing", async () => {
    const { adapter, context, resolvePromise } = await setupAdapter();

    adapter.stdin.write(JSON.stringify({ prompt: "from-prompt" }));
    await flushAsync();

    expect(transport.sendUserMessage).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        items: [{ type: "text", data: { text: "from-prompt" } }],
      })
    );

    resolvePromise();
    await flushAsync();
  });

  it("ignores duplicate writes and falls back on invalid JSON", async () => {
    const { adapter, context, resolvePromise } = await setupAdapter();

    adapter.stdin.write("{not json");
    adapter.stdin.write(JSON.stringify({ prompt: "ignored" }));
    await flushAsync();

    expect(transport.createChatRequest).toHaveBeenCalledTimes(1);
    expect(transport.sendUserMessage).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        items: [{ type: "text", data: { text: "" } }],
      })
    );

    resolvePromise();
    await flushAsync();
  });

  it("forwards unknown notifications and strips normalized text payloads", async () => {
    const { adapter, emitter, resolvePromise, stdout } = await setupAdapter({
      normalizedRequest: {
        turn: { items: [], text: "turn text" },
        message: { items: [], text: "message text" },
      },
    });

    adapter.stdin.write(JSON.stringify({ prompt: "hello" }));
    await flushAsync();

    emitter.emit("notification", { method: "custom_event", params: { ok: true } });
    await flushAsync();

    const messagePayload = transport.sendUserMessage.mock.calls[0][1];
    expect(messagePayload.text).toBeUndefined();
    expect(messagePayload.items).toEqual([{ type: "text", data: { text: "hello" } }]);
    expect(stdout).toContainEqual({ type: "custom_event", msg: { ok: true } });

    resolvePromise();
    await flushAsync();
  });

  it("normalizes delta, message, usage, and result payloads", async () => {
    const { adapter, emitter, resolvePromise, stdout } = await setupAdapter();

    adapter.stdin.write(JSON.stringify({ prompt: "hello" }));
    await flushAsync();

    emitter.emit("delta", { delta: "typed" });
    emitter.emit("delta", "raw");
    emitter.emit("delta", { content: "content" });
    emitter.emit("message", { message: { content: "full" } });
    emitter.emit("message", "fallback");
    emitter.emit("usage", { completion_tokens: 9, finish_reason: "stop" });
    emitter.emit("result", { result: { status: "completed" } });

    const deltas = stdout.filter((entry) => entry.type === "agent_message_delta");
    const messages = stdout.filter((entry) => entry.type === "agent_message");
    const usage = stdout.find((entry) => entry.type === "token_count");
    const done = stdout.find((entry) => entry.type === "task_complete");

    expect(deltas).toEqual([
      { type: "agent_message_delta", msg: { delta: "typed" } },
      { type: "agent_message_delta", msg: { delta: "raw" } },
      { type: "agent_message_delta", msg: { delta: "content" } },
    ]);
    expect(messages).toEqual([
      { type: "agent_message", msg: { message: { content: "full" } } },
      { type: "agent_message", msg: { message: { content: "fallback" } } },
    ]);
    expect(usage).toEqual({
      type: "token_count",
      msg: { prompt_tokens: 2, completion_tokens: 9, finish_reason: "stop" },
    });
    expect(done).toEqual({
      type: "task_complete",
      msg: { finish_reason: "completed" },
    });

    resolvePromise();
    await flushAsync();
  });

  it("translates item/completed notifications into agent_message output", async () => {
    const { adapter, emitter, resolvePromise, stdout } = await setupAdapter();

    adapter.stdin.write(JSON.stringify({ prompt: "hello" }));
    await flushAsync();

    emitter.emit("notification", {
      method: "codex/event/item/completed",
      params: {
        msg: {
          item: {
            type: "agentMessage",
            content: [{ type: "output_text", text: "from item" }],
          },
        },
      },
    });
    await flushAsync();

    expect(stdout).toContainEqual({
      type: "agent_message",
      msg: { message: { content: "from item" } },
    });

    resolvePromise();
    await flushAsync();
  });

  it("emits stderr and exits on errors", async () => {
    const { adapter, resolvePromise, stderr, exits } = await setupAdapter();

    adapter.on("error", () => {});
    transport.createChatRequest.mockRejectedValueOnce(new Error("boom"));
    const exitPromise = new Promise((resolve) => adapter.once("exit", resolve));
    adapter.stdin.write(JSON.stringify({ prompt: "hello" }));
    await exitPromise;

    expect(stderr).toContain("Error: boom");
    expect(exits).toContain(1);

    resolvePromise();
    await flushAsync();
  });
});
