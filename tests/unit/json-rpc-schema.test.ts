import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CODEX_CLI_VERSION,
  JSONRPC_VERSION,
  buildInitializeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  createUserMessageItem,
  extractConversationId,
  extractRequestId,
  isAgentMessageDeltaNotification,
  isAgentMessageNotification,
  isInitializeResult,
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  isTokenCountNotification,
  type AgentMessageDeltaNotification,
  type AgentMessageNotification,
  type TokenCountNotification,
  type JsonRpcSuccessResponse,
} from "../../src/lib/json-rpc/schema.ts";
import { ensureTranscripts, loadTranscript } from "../shared/transcript-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const FAKE_WORKER_PATH = resolve(PROJECT_ROOT, "scripts", "fake-codex-jsonrpc.js");

interface LineReader {
  read(): Promise<string>;
  close(): void;
}

function createLineReader(stream: Readable): LineReader {
  const rl = createInterface({ input: stream });
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  rl.on("line", (line) => {
    if (waiters.length > 0) {
      // Schedule to avoid nested resolution issues.
      const next = waiters.shift();
      if (next) next(line);
    } else {
      queue.push(line);
    }
  });

  return {
    async read() {
      if (queue.length > 0) {
        return queue.shift() as string;
      }
      return new Promise<string>((resolveLine) => {
        waiters.push(resolveLine);
      });
    },
    close() {
      rl.removeAllListeners();
      rl.close();
    },
  };
}

function parseJsonLine(line: string) {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

async function waitForPayload<T>(
  reader: LineReader,
  predicate: (payload: any) => payload is T,
  { timeoutMs = 5000 }: { timeoutMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Timed out waiting for JSON-RPC payload");
    }
    const line = await Promise.race<string | "__timeout__">([
      reader.read(),
      delay(remaining).then(() => "__timeout__" as const),
    ]);
    if (line === "__timeout__") {
      throw new Error("Timed out waiting for JSON-RPC payload");
    }
    const payload = parseJsonLine(line);
    if (!payload) continue;
    if (predicate(payload)) return payload;
  }
}

async function nextLineAsJson(reader: LineReader, timeoutMs = 5000) {
  return waitForPayload(
    reader,
    (payload: unknown): payload is Record<string, unknown> => {
      return typeof payload === "object" && payload !== null;
    },
    { timeoutMs }
  );
}

function startWorker(extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn("node", [FAKE_WORKER_PATH], {
    env: {
      ...process.env,
      CODEX_WORKER_SUPERVISED: "true",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createLineReader(child.stdout);
  const stderr = child.stderr ? createLineReader(child.stderr) : null;
  return { child, reader, stderr };
}

async function waitForReady(reader: LineReader) {
  await waitForPayload(reader, (payload): payload is Record<string, unknown> => {
    return Boolean(payload && (payload as Record<string, unknown>).event === "ready");
  });
}

async function sendAndExpectResult<ResultType>(
  child: ReturnType<typeof startWorker>["child"],
  reader: LineReader,
  request: Record<string, unknown>,
  timeoutMs = 5000
): Promise<JsonRpcSuccessResponse<ResultType>> {
  child.stdin.write(`${JSON.stringify(request)}\n`);
  const response = await waitForPayload(
    reader,
    (payload): payload is Record<string, unknown> => {
      if (!payload || typeof payload !== "object") return false;
      if (!("id" in payload) || (payload as Record<string, unknown>).id !== request.id)
        return false;
      return payload.jsonrpc === JSONRPC_VERSION;
    },
    { timeoutMs }
  );

  expect(isJsonRpcSuccessResponse<ResultType>(response)).toBe(true);
  return response as JsonRpcSuccessResponse<ResultType>;
}

afterEach(async () => {
  // Give spawned processes time to exit cleanly and avoid cross-test interference.
  await delay(10);
});

describe("json-rpc schema bindings", () => {
  beforeAll(() => {
    ensureTranscripts(["streaming-tool-calls.json"], { backend: "app" });
  }, 30000);

  it("pins the schema to Codex CLI 0.92.0", () => {
    expect(CODEX_CLI_VERSION).toBe("0.92.0");
  });

  it("parses streaming text notifications and token counts", async () => {
    const worker = startWorker();
    try {
      await waitForReady(worker.reader);

      const initResp = await sendAndExpectResult(worker.child, worker.reader, {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "unit-test", version: "1.0.0" }, protocolVersion: "v2" },
      });
      expect(isInitializeResult(initResp.result)).toBe(true);

      const threadResp = await sendAndExpectResult(worker.child, worker.reader, {
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: "thread/start",
        params: { model: "gpt-5.2" },
      });
      const threadId =
        threadResp.result?.threadId || (threadResp.result as Record<string, unknown>).thread_id;
      expect(typeof threadId === "string").toBe(true);

      const requestId = "req-text";
      const turnRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 3,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "User says hello", text_elements: [] }],
          approvalPolicy: "never",
          summary: "auto",
        },
      } as const;

      worker.child.stdin.write(`${JSON.stringify(turnRequest)}\n`);

      const notifications: Record<string, unknown>[] = [];
      let turnResponse: JsonRpcSuccessResponse<Record<string, unknown>> | null = null;
      while (!turnResponse) {
        const payload = await nextLineAsJson(worker.reader);
        if (payload.method) {
          notifications.push(payload);
          continue;
        }
        if (payload.id === turnRequest.id) {
          expect(isJsonRpcSuccessResponse<Record<string, unknown>>(payload)).toBe(true);
          turnResponse = payload as JsonRpcSuccessResponse<Record<string, unknown>>;
          break;
        }
      }

      expect(turnResponse).not.toBeNull();

      const delta = notifications.find(isAgentMessageDeltaNotification);
      expect(delta).toBeDefined();
      if (delta) {
        const params = (delta as AgentMessageDeltaNotification).params;
        expect(extractConversationId(params)).toBe(threadId);
        if (extractRequestId(params)) {
          expect(extractRequestId(params)).toBe(requestId);
        }
      }

      const agentMessage = notifications.find(isAgentMessageNotification);
      expect(agentMessage).toBeDefined();
      if (agentMessage) {
        const params = (agentMessage as AgentMessageNotification).params;
        expect(params.message.role).toBe("assistant");
      }

      const tokenCount = notifications.find(isTokenCountNotification);
      expect(tokenCount).toBeDefined();
      if (tokenCount) {
        const params = (tokenCount as TokenCountNotification).params;
        expect(params.prompt_tokens).toBeGreaterThanOrEqual(0);
      }

      // Ensure no unexpected error payload slipped through.
      notifications.forEach((payload) => {
        expect(isJsonRpcNotification(payload)).toBe(true);
        expect(isJsonRpcErrorResponse(payload)).toBe(false);
      });
    } finally {
      worker.reader.close();
      worker.stderr?.close();
      worker.child.kill("SIGTERM");
    }
  });

  it("validates tool-call deltas include structured payloads", async () => {
    const worker = startWorker({
      FAKE_CODEX_MODE: "tool_call",
      FAKE_CODEX_METADATA: "extra",
    });
    try {
      await waitForReady(worker.reader);

      await sendAndExpectResult(worker.child, worker.reader, {
        jsonrpc: JSONRPC_VERSION,
        id: 11,
        method: "initialize",
        params: {
          clientInfo: { name: "unit-test", version: CODEX_CLI_VERSION },
          protocolVersion: "v2",
        },
      });

      const threadResp = await sendAndExpectResult(worker.child, worker.reader, {
        jsonrpc: JSONRPC_VERSION,
        id: 12,
        method: "thread/start",
        params: { model: "gpt-5.2" },
      });
      const threadId =
        threadResp.result?.threadId || (threadResp.result as Record<string, unknown>).thread_id;

      const turnRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 13,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "Execute tool", text_elements: [] }],
          approvalPolicy: "never",
          summary: "auto",
        },
      } as const;

      worker.child.stdin.write(`${JSON.stringify(turnRequest)}\n`);

      const notifications: Record<string, unknown>[] = [];
      let turnResponse: JsonRpcSuccessResponse<Record<string, unknown>> | null = null;
      while (!turnResponse) {
        const payload = await nextLineAsJson(worker.reader);
        if (payload.method) {
          notifications.push(payload);
          continue;
        }
        if (payload.id === turnRequest.id) {
          expect(isJsonRpcSuccessResponse<Record<string, unknown>>(payload)).toBe(true);
          turnResponse = payload as JsonRpcSuccessResponse<Record<string, unknown>>;
        }
      }

      const delta = notifications.find(isAgentMessageDeltaNotification);
      expect(delta).toBeDefined();
      if (delta) {
        const params = (delta as AgentMessageDeltaNotification).params;
        expect(
          Array.isArray((params.delta as any)?.tool_calls || (params.delta as any)?.toolCalls)
        ).toBe(true);
      }

      const agentMessage = notifications.find(isAgentMessageNotification);
      expect(agentMessage).toBeDefined();
      if (agentMessage) {
        const params = (agentMessage as AgentMessageNotification).params;
        const toolCalls = params.message.tool_calls || params.message.toolCalls;
        expect(Array.isArray(toolCalls)).toBe(true);
        if (Array.isArray(toolCalls) && toolCalls[0]) {
          expect(typeof toolCalls[0].function?.name === "string").toBe(true);
          expect(typeof toolCalls[0].function?.arguments === "string").toBe(true);
        }
      }

      const tokenCount = notifications.find(isTokenCountNotification);
      expect(tokenCount).toBeDefined();
    } finally {
      worker.reader.close();
      worker.stderr?.close();
      worker.child.kill("SIGTERM");
    }
  });

  it("deserializes parity fixture streams into notification envelopes", async () => {
    const fixture = await loadTranscript("streaming-tool-calls.json", { backend: "app" });
    const threadId = "fixture-conv";
    const requestId = "fixture-req";

    const notifications: Record<string, unknown>[] = [];
    let aggregatedContent = "";
    let aggregatedToolCalls: unknown = null;
    let finishReason: string | undefined;

    for (const entry of fixture.stream) {
      if (entry.type !== "data") continue;
      const choice = entry.data?.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};
      if (Object.keys(delta).length > 0) {
        notifications.push({
          jsonrpc: JSONRPC_VERSION,
          method: "agentMessageDelta",
          params: {
            threadId,
            request_id: requestId,
            delta,
          },
        });

        if (typeof delta.content === "string") {
          aggregatedContent += delta.content;
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          aggregatedToolCalls = delta.tool_calls;
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (entry.data?.usage) {
        notifications.push({
          jsonrpc: JSONRPC_VERSION,
          method: "tokenCount",
          params: {
            threadId,
            request_id: requestId,
            prompt_tokens: entry.data.usage.prompt_tokens,
            completion_tokens: entry.data.usage.completion_tokens,
            total_tokens: entry.data.usage.total_tokens,
            finish_reason: choice.finish_reason ?? undefined,
          },
        });
      }
    }

    notifications.push({
      jsonrpc: JSONRPC_VERSION,
      method: "agentMessage",
      params: {
        threadId,
        request_id: requestId,
        message: {
          role: "assistant",
          content: aggregatedContent || null,
          ...(aggregatedToolCalls ? { tool_calls: aggregatedToolCalls } : {}),
        },
        ...(finishReason ? { finish_reason: finishReason } : {}),
      },
    });

    expect(notifications.length).toBeGreaterThan(0);
    for (const notification of notifications) {
      expect(isJsonRpcNotification(notification)).toBe(true);
    }
  });

  describe("serializer helpers", () => {
    it("builds initialize params with camelCase fields", () => {
      const params = buildInitializeParams({ clientInfo: { name: "tester", version: "1.2.3" } });
      expect(params.clientInfo).toMatchObject({ name: "tester", version: "1.2.3" });
      expect(params).not.toHaveProperty("client_info");
      expect(params.protocolVersion).toBeUndefined();
      expect(params).not.toHaveProperty("protocol_version");
    });

    it("builds thread/start params with normalized optional fields", () => {
      const params = buildThreadStartParams({
        model: " gpt-5.2 ",
        profile: "",
        cwd: "/tmp/codex-work",
        approvalPolicy: "On-Request",
        sandbox: { type: "workspace-write", writable_roots: ["/tmp"] },
        baseInstructions: "  base ",
        developerInstructions: null,
      });
      expect(params.model).toBe("gpt-5.2");
      expect(params.profile).toBeNull();
      expect(params.cwd).toBe("/tmp/codex-work");
      expect(params.approvalPolicy).toBe("on-request");
      expect(params.sandbox).toBe("workspace-write");
      expect(params.baseInstructions).toBe("base");
      expect(params.developerInstructions).toBeNull();
    });

    it("passes through config and dynamicTools in thread/start params", () => {
      const config = { featureFlags: { experimental: true } };
      const dynamicTools = [{ name: "lookup", description: "", inputSchema: { type: "object" } }];
      const params = buildThreadStartParams({
        config,
        dynamicTools,
      });
      expect(params.config).toEqual(config);
      expect(params.dynamicTools).toEqual(dynamicTools);
      expect(params).not.toHaveProperty("compactPrompt");
      expect(params).not.toHaveProperty("dynamic_tools");
    });

    it("drops invalid sandbox types in thread/start params", () => {
      const params = buildThreadStartParams({
        // @ts-expect-error test runtime validation
        sandbox: true,
      });
      expect(params.sandbox).toBeUndefined();
    });

    it("normalizes legacy sandbox policy objects in thread/start params", () => {
      const params = buildThreadStartParams({
        // @ts-expect-error test legacy object shape support
        sandbox: { type: "read-only" },
      });
      expect(params.sandbox).toBe("read-only");
    });

    it("builds turn/start params with normalized values", () => {
      const item = createUserMessageItem("hello", { message_count: 1, messageCount: 1 });
      const params = buildTurnStartParams({
        items: [item],
        threadId: "conv-1",
        approvalPolicy: "NEVER",
        sandboxPolicy: { type: "workspace-write", writable_roots: ["/tmp"] },
        summary: "concise",
        effort: "high",
      });
      expect(params.threadId).toBe("conv-1");
      expect(params.approvalPolicy).toBe("never");
      expect(params.sandboxPolicy).toMatchObject({
        type: "workspaceWrite",
        writableRoots: ["/tmp"],
      });
      expect(params.summary).toBe("concise");
      expect(params.effort).toBe("high");
      expect(params.input).toHaveLength(1);
    });

    it("normalizes output schema options for turn/start params", () => {
      const item = createUserMessageItem("hello");
      const outputSchema = { type: "object", properties: { title: { type: "string" } } };
      const params = buildTurnStartParams({
        items: [item],
        threadId: "conv-schema",
        outputSchema,
      });

      expect(params.outputSchema).toEqual(outputSchema);
    });

    it("normalizes legacy item shapes to typed input items", () => {
      const params = buildTurnStartParams({
        items: ["hi", { text: "hello" }, { data: { text: "hey" } }],
        threadId: "conv-legacy",
        approvalPolicy: "never",
        sandboxPolicy: "read-only",
        summary: "auto",
      });
      expect(params.input).toHaveLength(3);
      expect(params.input[0]).toMatchObject({ type: "text", text: "hi" });
      expect(params.input[1]).toMatchObject({ type: "text", text: "hello" });
      expect(params.input[2]).toMatchObject({ type: "text", text: "hey" });
    });
  });
});
