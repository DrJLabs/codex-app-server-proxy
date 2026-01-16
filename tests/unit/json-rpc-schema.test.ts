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
  buildNewConversationParams,
  buildAddConversationListenerParams,
  buildRemoveConversationListenerParams,
  buildSendUserMessageParams,
  buildSendUserTurnParams,
  createUserMessageItem,
  extractConversationId,
  extractRequestId,
  isAgentMessageDeltaNotification,
  isAgentMessageNotification,
  isInitializeResult,
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  isSendUserMessageResult,
  isSendUserTurnResult,
  isTokenCountNotification,
  type AgentMessageDeltaNotification,
  type AgentMessageNotification,
  type TokenCountNotification,
  type JsonRpcSuccessResponse,
  type SendUserMessageResult,
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

  it("pins the schema to Codex CLI 0.84.0", () => {
    expect(CODEX_CLI_VERSION).toBe("0.84.0");
  });

  it("parses streaming text notifications and token counts", async () => {
    const worker = startWorker();
    try {
      await waitForReady(worker.reader);

      const initResp = await sendAndExpectResult(worker.child, worker.reader, {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "initialize",
        params: { client_info: { name: "unit-test", version: "1.0.0" } },
      });
      expect(isInitializeResult(initResp.result)).toBe(true);

      const turnResp = await sendAndExpectResult(worker.child, worker.reader, {
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: "sendUserTurn",
        params: { conversation_id: "conv-text" },
      });
      expect(isSendUserTurnResult(turnResp.result)).toBe(true);
      const conversationId =
        turnResp.result?.conversation_id ||
        (turnResp.result as Record<string, unknown>).conversationId;
      expect(typeof conversationId === "string").toBe(true);

      const requestId = "req-text";
      const sendMessageRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 3,
        method: "sendUserMessage",
        params: {
          conversation_id: conversationId,
          request_id: requestId,
          text: "User says hello",
          metadata: { include_usage: true },
        },
      } as const;

      worker.child.stdin.write(`${JSON.stringify(sendMessageRequest)}\n`);

      const notifications: Record<string, unknown>[] = [];
      let messageResponse: JsonRpcSuccessResponse<SendUserMessageResult> | null = null;
      while (!messageResponse) {
        const payload = await nextLineAsJson(worker.reader);
        if (payload.method) {
          notifications.push(payload);
          continue;
        }
        if (payload.id === sendMessageRequest.id) {
          expect(isJsonRpcSuccessResponse<SendUserMessageResult>(payload)).toBe(true);
          messageResponse = payload as JsonRpcSuccessResponse<SendUserMessageResult>;
          break;
        }
      }

      expect(messageResponse).not.toBeNull();
      expect(isSendUserMessageResult(messageResponse?.result)).toBe(true);

      const delta = notifications.find(isAgentMessageDeltaNotification);
      expect(delta).toBeDefined();
      if (delta) {
        const params = (delta as AgentMessageDeltaNotification).params;
        expect(extractConversationId(params)).toBe(conversationId);
        expect(extractRequestId(params)).toBe(requestId);
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
        params: { client_info: { name: "unit-test", version: CODEX_CLI_VERSION } },
      });

      const turnResp = await sendAndExpectResult(worker.child, worker.reader, {
        jsonrpc: JSONRPC_VERSION,
        id: 12,
        method: "sendUserTurn",
        params: {},
      });
      const conversationId =
        turnResp.result?.conversation_id ||
        (turnResp.result as Record<string, unknown>).conversationId;

      const requestId = "req-tool";
      const sendMessageRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 13,
        method: "sendUserMessage",
        params: {
          conversation_id: conversationId,
          request_id: requestId,
          text: "Execute tool",
          metadata: { include_usage: true },
        },
      } as const;

      worker.child.stdin.write(`${JSON.stringify(sendMessageRequest)}\n`);

      const notifications: Record<string, unknown>[] = [];
      let messageResponse: JsonRpcSuccessResponse<SendUserMessageResult> | null = null;
      while (!messageResponse) {
        const payload = await nextLineAsJson(worker.reader);
        if (payload.method) {
          notifications.push(payload);
          continue;
        }
        if (payload.id === sendMessageRequest.id) {
          expect(isJsonRpcSuccessResponse<SendUserMessageResult>(payload)).toBe(true);
          messageResponse = payload as JsonRpcSuccessResponse<SendUserMessageResult>;
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

      expect(isSendUserMessageResult(messageResponse?.result)).toBe(true);
      if (messageResponse?.result?.finish_reason) {
        expect(typeof messageResponse.result.finish_reason).toBe("string");
      }
    } finally {
      worker.reader.close();
      worker.stderr?.close();
      worker.child.kill("SIGTERM");
    }
  });

  it("deserializes parity fixture streams into notification envelopes", async () => {
    const fixture = await loadTranscript("streaming-tool-calls.json", { backend: "app" });
    const conversationId = "fixture-conv";
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
            conversation_id: conversationId,
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
            conversation_id: conversationId,
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
        conversation_id: conversationId,
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
    it("builds initialize params with camelCase mirrors", () => {
      const params = buildInitializeParams({ clientInfo: { name: "tester", version: "1.2.3" } });
      expect(params.clientInfo).toMatchObject({ name: "tester", version: "1.2.3" });
      expect(params.client_info).toMatchObject({ name: "tester", version: "1.2.3" });
      expect(params.protocolVersion).toBeUndefined();
      expect(params.protocol_version).toBeUndefined();
    });

    it("builds newConversation params with normalized optional fields", () => {
      const params = buildNewConversationParams({
        model: " gpt-5.2 ",
        profile: "",
        cwd: "/tmp/codex-work",
        approvalPolicy: "On-Request",
        sandbox: { type: "workspace-write", writable_roots: ["/tmp"] },
        baseInstructions: "  base ",
        developerInstructions: null,
        includeApplyPatchTool: true,
      });
      expect(params.model).toBe("gpt-5.2");
      expect(params.profile).toBeNull();
      expect(params.cwd).toBe("/tmp/codex-work");
      expect(params.approvalPolicy).toBe("on-request");
      expect(params.sandbox).toBe("workspace-write");
      expect(params.baseInstructions).toBe("base");
      expect(params.developerInstructions).toBeNull();
      expect(params.includeApplyPatchTool).toBe(true);
    });

    it("builds sendUserTurn params with normalized values", () => {
      const item = createUserMessageItem("hello", { message_count: 1, messageCount: 1 });
      const params = buildSendUserTurnParams({
        items: [item],
        conversationId: "conv-1",
        cwd: "/tmp/work",
        approvalPolicy: "NEVER",
        sandboxPolicy: { type: "workspace-write", writable_roots: ["/tmp"] },
        model: "gpt-5.2",
        summary: "concise",
        effort: "high",
      });
      expect(params.conversationId).toBe("conv-1");
      expect(params.cwd).toBe("/tmp/work");
      expect(params.approvalPolicy).toBe("never");
      expect(params.sandboxPolicy).toMatchObject({
        type: "workspace-write",
        writable_roots: ["/tmp"],
      });
      expect(params.summary).toBe("concise");
      expect(params.effort).toBe("high");
      expect(params.items).toHaveLength(1);
      expect(params.items[0]).not.toBe(item);
    });

    it("normalizes output schema options for sendUserTurn params", () => {
      const item = createUserMessageItem("hello");
      const outputSchema = { type: "object", properties: { title: { type: "string" } } };
      const snakeSchema = { type: "array" };
      const legacySchema = { type: "string" };
      const params = buildSendUserTurnParams({
        items: [item],
        conversationId: "conv-schema",
        outputSchema,
        output_schema: snakeSchema,
        finalOutputJsonSchema: legacySchema,
      });

      expect(params.outputSchema).toEqual(outputSchema);
      expect(params.output_schema).toEqual(outputSchema);

      const paramsSnake = buildSendUserTurnParams({
        items: [item],
        conversationId: "conv-schema-snake",
        output_schema: snakeSchema,
      });

      expect(paramsSnake.outputSchema).toEqual(snakeSchema);
      expect(paramsSnake.output_schema).toEqual(snakeSchema);

      const paramsLegacy = buildSendUserTurnParams({
        items: [item],
        conversationId: "conv-schema-legacy",
        finalOutputJsonSchema: legacySchema,
      });

      expect(paramsLegacy.outputSchema).toEqual(legacySchema);
      expect(paramsLegacy.output_schema).toEqual(legacySchema);
    });

    it("normalizes legacy item shapes to typed input items", () => {
      const params = buildSendUserTurnParams({
        items: ["hi", { text: "hello" }, { data: { text: "hey" } }],
        conversationId: "conv-legacy",
        cwd: "/tmp/work",
        approvalPolicy: "never",
        sandboxPolicy: "read-only",
        model: "gpt-5.2",
        summary: "auto",
      });
      expect(params.items).toHaveLength(3);
      expect(params.items[0]).toMatchObject({ type: "text", data: { text: "hi" } });
      expect(params.items[1]).toMatchObject({ type: "text", data: { text: "hello" } });
      expect(params.items[2]).toMatchObject({ type: "text", data: { text: "hey" } });
    });

    it("builds sendUserMessage params with normalized items and options", () => {
      const item = createUserMessageItem("payload");
      const params = buildSendUserMessageParams({
        items: [item],
        conversationId: "conv-9",
        includeUsage: true,
        metadata: { trace: true },
        stream: true,
        temperature: 0.75,
        topP: 0.5,
        maxOutputTokens: 256,
        tools: { definitions: [{ type: "function", function: { name: "noop" } }] },
        responseFormat: { type: "json_schema" },
        reasoning: { effort: "low" },
        finalOutputJsonSchema: { type: "object" },
      });
      expect(params.conversationId).toBe("conv-9");
      expect(params.items).toHaveLength(1);
      expect(params.items[0]).not.toBe(item);
      expect(params.includeUsage).toBe(true);
      expect(params.include_usage).toBe(true);
      expect(params.metadata).toEqual({ trace: true });
      expect(params.stream).toBe(true);
      expect(params.temperature).toBe(0.75);
      expect(params.topP).toBe(0.5);
      expect(params.top_p).toBe(0.5);
      expect(params.maxOutputTokens).toBe(256);
      expect(params.max_output_tokens).toBe(256);
      expect(params.tools).toEqual({
        definitions: [{ type: "function", function: { name: "noop" } }],
      });
      expect(params.responseFormat).toEqual({ type: "json_schema" });
      expect(params.response_format).toEqual({ type: "json_schema" });
      expect(params.reasoning).toEqual({ effort: "low" });
      expect(params.finalOutputJsonSchema).toEqual({ type: "object" });
      expect(params.final_output_json_schema).toEqual({ type: "object" });
    });

    it("normalizes legacy item shapes for sendUserMessage params", () => {
      const params = buildSendUserMessageParams({
        items: ["hi", { text: "hello" }, { data: { text: "hey" } }],
        conversationId: "conv-legacy",
        includeUsage: true,
      });
      expect(params.items).toHaveLength(3);
      expect(params.items[0]).toMatchObject({ type: "text", data: { text: "hi" } });
      expect(params.items[1]).toMatchObject({ type: "text", data: { text: "hello" } });
      expect(params.items[2]).toMatchObject({ type: "text", data: { text: "hey" } });
    });

    it("builds add/remove conversation listener params", () => {
      const addParams = buildAddConversationListenerParams({
        conversationId: "conv-abc",
        experimentalRawEvents: undefined,
      });
      expect(addParams.conversationId).toBe("conv-abc");
      expect(addParams.experimentalRawEvents).toBeUndefined();

      const removeParams = buildRemoveConversationListenerParams({
        subscriptionId: "sub-123",
      });
      expect(removeParams.subscriptionId).toBe("sub-123");
    });
  });
});
