import { describe, expect, it } from "vitest";
import { buildResponsesEnvelope } from "../../../../../src/handlers/responses/native/envelope.js";

describe("native responses envelope builder", () => {
  it("builds response object with object/created", () => {
    const envelope = buildResponsesEnvelope({
      responseId: "chatcmpl-123",
      created: 1700000000,
      model: "gpt-4.1",
      outputText: "hello",
      functionCalls: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      status: "completed",
    });

    expect(envelope.object).toBe("response");
    expect(envelope.created).toBe(1700000000);
    expect(envelope.id.startsWith("resp_")).toBe(true);
    expect(envelope.output[0].type).toBe("message");
    expect(envelope.output[0].content[0].type).toBe("output_text");
  });

  it("maps function calls to output items with string arguments", () => {
    const envelope = buildResponsesEnvelope({
      responseId: "resp_1",
      created: 1,
      model: "gpt-4.1",
      outputText: "",
      functionCalls: [{ id: "call_1", function: { name: "lookup", arguments: 42 } }],
      usage: null,
      status: "completed",
    });

    const fnItem = envelope.output[1];
    expect(fnItem.type).toBe("function_call");
    expect(fnItem.call_id).toBe("call_1");
    expect(fnItem.id).toBe("call_1");
    expect(fnItem.name).toBe("lookup");
    expect(fnItem.arguments).toBe("42");
  });
});
