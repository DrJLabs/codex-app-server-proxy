import { describe, expect, it } from "vitest";
import { normalizeChatJsonRpcRequest } from "../../../../src/handlers/chat/request.js";

describe("normalizeChatJsonRpcRequest", () => {
  it("sets message.stream when streaming is enabled", () => {
    const result = normalizeChatJsonRpcRequest({
      body: {},
      messages: [{ role: "user", content: "hi" }],
      prompt: "",
      effectiveModel: "gpt-test",
      stream: true,
      reasoningEffort: "",
      sandboxMode: "",
      codexWorkdir: "/tmp",
      approvalMode: "",
    });

    expect(result.message.stream).toBe(true);
  });
});
