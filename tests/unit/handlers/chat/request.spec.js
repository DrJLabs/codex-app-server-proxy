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

  it("maps tools to dynamicTools on the turn and omits tools payloads", () => {
    const result = normalizeChatJsonRpcRequest({
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Find data",
              parameters: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        ],
        tool_choice: "auto",
      },
      messages: [{ role: "user", content: "hi" }],
      prompt: "",
      effectiveModel: "gpt-test",
      stream: false,
      reasoningEffort: "",
      sandboxMode: "",
      codexWorkdir: "/tmp",
      approvalMode: "",
    });

    expect(result.turn.dynamicTools).toEqual([
      {
        name: "lookup",
        description: "Find data",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      },
    ]);
    expect(result.turn.tools).toBeUndefined();
    expect(result.message.tools).toBeUndefined();
  });
});
