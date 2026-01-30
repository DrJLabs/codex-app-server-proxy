import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INTERNAL_TOOLS_INSTRUCTION =
  "Never use internal tools (shell/exec_command/apply_patch/update_plan/view_image). Request only dynamic tool calls provided by the client.";

const restoreEnv = () => {
  delete process.env.PROXY_IGNORE_CLIENT_SYSTEM_PROMPT;
};

const loadNormalize = async () => {
  vi.resetModules();
  const mod = await import("../../src/handlers/chat/request.js");
  return mod.normalizeChatJsonRpcRequest;
};

describe("normalizeChatJsonRpcRequest system prompt behavior", () => {
  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("includes baseInstructions when system prompt forwarding is enabled", async () => {
    process.env.PROXY_IGNORE_CLIENT_SYSTEM_PROMPT = "false";
    const normalizeChatJsonRpcRequest = await loadNormalize();

    const messages = [
      { role: "system", content: "You are Codex" },
      { role: "user", content: "List files" },
    ];

    const normalized = normalizeChatJsonRpcRequest({
      effectiveModel: "gpt-5.2",
      body: { messages },
      messages,
    });

    expect(normalized.turn.baseInstructions).toBe(`You are Codex\n\n${INTERNAL_TOOLS_INSTRUCTION}`);
  });

  it("omits baseInstructions when system prompt forwarding is disabled", async () => {
    process.env.PROXY_IGNORE_CLIENT_SYSTEM_PROMPT = "true";
    const normalizeChatJsonRpcRequest = await loadNormalize();

    const messages = [
      { role: "system", content: "You are Codex" },
      { role: "user", content: "List files" },
    ];

    const normalized = normalizeChatJsonRpcRequest({
      effectiveModel: "gpt-5.2",
      body: { messages },
      messages,
    });

    expect(normalized.turn.baseInstructions).toBe(INTERNAL_TOOLS_INSTRUCTION);
  });

  it("treats 0 as false for system prompt forwarding", async () => {
    process.env.PROXY_IGNORE_CLIENT_SYSTEM_PROMPT = "0";
    const normalizeChatJsonRpcRequest = await loadNormalize();

    const messages = [
      { role: "system", content: "You are Codex" },
      { role: "user", content: "List files" },
    ];

    const normalized = normalizeChatJsonRpcRequest({
      effectiveModel: "gpt-5.2",
      body: { messages },
      messages,
    });

    expect(normalized.turn.baseInstructions).toBe(`You are Codex\n\n${INTERNAL_TOOLS_INSTRUCTION}`);
  });
});
