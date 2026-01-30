import { describe, expect, it } from "vitest";

import {
  JSONRPC_VERSION,
  createUserMessageItem,
  buildInitializeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  extractConversationId,
  extractRequestId,
  isAgentMessageDeltaNotification,
  isAgentMessageNotification,
  isInitializeResult,
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  isRequestTimeoutNotification,
  isTokenCountNotification,
  normalizeInputItems,
} from "../../src/lib/json-rpc/schema.ts";
import * as jsonRpcSchema from "../../src/lib/json-rpc/schema.ts";

describe("json-rpc schema helper behavior", () => {
  it("normalizes input items and falls back to provided text", () => {
    const items = normalizeInputItems(
      [
        { type: "image", data: { image_url: "https://example.com/image.png" } },
        { data: { text: "hello" } },
        { text: "world" },
      ],
      "fallback"
    );

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "image",
      data: { image_url: "https://example.com/image.png" },
    });
    expect(items[1]).toMatchObject({ type: "text", data: { text: "hello" } });
    expect(items[2]).toMatchObject({ type: "text", data: { text: "world" } });

    const fallbackItems = normalizeInputItems([], "fallback");
    expect(fallbackItems).toHaveLength(1);
    expect(fallbackItems[0]).toMatchObject({ type: "text", data: { text: "fallback" } });
  });

  it("creates message items with nullish text and ignores non-array inputs", () => {
    const item = createUserMessageItem(undefined as unknown as string);
    expect(item.data.text).toBe("");

    const items = normalizeInputItems("oops", 123 as unknown as string);
    expect(items).toEqual([]);
  });

  it("applies approval, summary, and sandbox fallbacks", () => {
    const params = buildTurnStartParams({
      items: [],
      threadId: "conv",
      approvalPolicy: "invalid",
      sandboxPolicy: { type: "unknown" },
      summary: "unknown",
    });

    expect(params.approvalPolicy).toBe("on-request");
    expect(params.summary).toBe("auto");
    expect(params.sandboxPolicy).toEqual({ type: "unknown" });
  });

  it("preserves workspace-write sandbox options", () => {
    const params = buildTurnStartParams({
      items: [],
      threadId: "conv",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspace-write",
        writable_roots: ["/tmp"],
        network_access: true,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
      summary: "auto",
    });

    expect(params.sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      writableRoots: ["/tmp"],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });

  it("normalizes optional approval and sandbox modes for thread start", () => {
    const params = buildThreadStartParams({
      approvalPolicy: "bad",
      sandbox: { mode: "read-only" },
    });

    expect(params.approvalPolicy).toBe("on-request");
    expect(params.sandbox).toBe("read-only");

    const nullParams = buildThreadStartParams({ approvalPolicy: null });
    expect(nullParams.approvalPolicy).toBeUndefined();
  });

  it("builds initialize params with protocol versions and capabilities", () => {
    const params = buildInitializeParams({
      clientInfo: { name: "tester", version: "1.0.0" },
      capabilities: { feature: true },
      protocolVersion: "v2",
    });

    expect(params.protocolVersion).toBe("v2");
    expect(params).not.toHaveProperty("protocol_version");
    expect(params.capabilities).toEqual({ feature: true });
  });

  it("fills initialize defaults without snake_case fields", () => {
    const params = buildInitializeParams({
      clientInfo: {},
      capabilities: null,
      protocolVersion: "v2",
    });

    expect(params.clientInfo.name).toBe("codex-app-server-proxy");
    expect(params.clientInfo.version).toBe("0.92.0");
    expect(params).not.toHaveProperty("client_info");
    expect(params).not.toHaveProperty("protocol_version");
    expect(params.capabilities).toBeNull();
  });

  it("extracts conversation and request ids from nested payloads", () => {
    expect(extractConversationId({ threadId: "conv-1" })).toBe("conv-1");
    expect(extractConversationId({ threadId: "conv-1b" })).toBe("conv-1b");
    expect(extractConversationId({ conversation: { id: "conv-2" } })).toBe("conv-2");
    expect(extractConversationId({ context: { threadId: "conv-3" } })).toBe("conv-3");

    expect(extractRequestId({ request_id: "req-1" })).toBe("req-1");
    expect(extractRequestId({ requestId: "req-1b" })).toBe("req-1b");
    expect(extractRequestId({ context: { request_id: "req-2" } })).toBe("req-2");
  });

  it("builds thread/start params with nullable fields", () => {
    const params = buildThreadStartParams({
      sandbox: { mode: "read-only" },
      profile: "",
      config: "nope" as unknown as Record<string, unknown>,
    });

    expect(params.sandbox).toBe("read-only");
    expect(params.profile).toBeNull();
    expect(params).not.toHaveProperty("config");
  });

  it("skips invalid effort values", () => {
    const params = buildTurnStartParams({
      items: [],
      threadId: "conv",
      approvalPolicy: "never",
      sandboxPolicy: "read-only",
      summary: "auto",
      effort: "invalid" as unknown as string,
    });

    expect(params).not.toHaveProperty("effort");
  });

  it("identifies jsonrpc notifications and responses", () => {
    const notification = {
      jsonrpc: JSONRPC_VERSION,
      method: "requestTimeout",
      params: { request_id: "req-1", threadId: "conv-1" },
    };
    const success = { jsonrpc: JSONRPC_VERSION, id: 1, result: { ok: true } };
    const error = { jsonrpc: JSONRPC_VERSION, id: 2, error: { code: "bad", message: "boom" } };

    expect(isJsonRpcNotification(notification)).toBe(true);
    expect(isJsonRpcSuccessResponse(success)).toBe(true);
    expect(isJsonRpcErrorResponse(error)).toBe(true);
    expect(isJsonRpcNotification({})).toBe(false);
  });

  it("returns null when extracting identifiers from non-objects", () => {
    expect(extractConversationId(null)).toBeNull();
    expect(extractRequestId("nope")).toBeNull();
  });

  it("handles notification predicates for invalid payloads", () => {
    const badDelta = {
      jsonrpc: JSONRPC_VERSION,
      method: "agentMessageDelta",
      params: { threadId: "conv" },
    };
    expect(isAgentMessageDeltaNotification(badDelta)).toBe(false);

    const badToken = {
      jsonrpc: JSONRPC_VERSION,
      method: "tokenCount",
      params: { threadId: "conv" },
    };
    expect(isTokenCountNotification(badToken)).toBe(false);

    const timeout = {
      jsonrpc: JSONRPC_VERSION,
      method: "requestTimeout",
      params: { request_id: "req-1" },
    };
    expect(isRequestTimeoutNotification(timeout)).toBe(true);
  });

  it("does not expose legacy listener builders in v2-only schema", () => {
    expect("buildAddConversationListenerParams" in jsonRpcSchema).toBe(false);
    expect("buildRemoveConversationListenerParams" in jsonRpcSchema).toBe(false);
  });

  it("accepts valid chat notifications", () => {
    const delta = {
      jsonrpc: JSONRPC_VERSION,
      method: "agentMessageDelta",
      params: { threadId: "conv-1", delta: { content: "hello" } },
    };

    expect(isAgentMessageDeltaNotification(delta)).toBe(true);
  });

  it("recognizes notifications with alternate identifiers", () => {
    const agentMessage = {
      jsonrpc: JSONRPC_VERSION,
      method: "agentMessage",
      params: { threadId: "conv-1", message: { role: "assistant" } },
    };
    expect(isAgentMessageNotification(agentMessage)).toBe(true);

    const tokenCount = {
      jsonrpc: JSONRPC_VERSION,
      method: "tokenCount",
      params: { requestId: "req-1", completion_tokens: 5 },
    };
    expect(isTokenCountNotification(tokenCount)).toBe(true);

    const timeout = {
      jsonrpc: JSONRPC_VERSION,
      method: "requestTimeout",
      params: { requestId: "req-2" },
    };
    expect(isRequestTimeoutNotification(timeout)).toBe(true);
  });

  it("validates initialize results for type mismatches", () => {
    expect(isInitializeResult({ advertised_models: "not-array" })).toBe(false);
  });

  it("rejects invalid jsonrpc responses", () => {
    expect(isJsonRpcErrorResponse({ jsonrpc: JSONRPC_VERSION, error: {} })).toBe(false);
    expect(isJsonRpcSuccessResponse({ jsonrpc: JSONRPC_VERSION, id: 1 })).toBe(false);
  });
});
