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

  it("keeps message output first and tool calls typed as function_call", () => {
    const envelope = buildResponsesEnvelope({
      responseId: "resp_2",
      created: 2,
      model: "gpt-4.1",
      outputText: "hello",
      functionCalls: [
        { id: "call_1", function: { name: "lookup", arguments: "{}" } },
        { id: "call_2", function: { name: "search", arguments: "{}" } },
      ],
      usage: null,
      status: "completed",
    });

    expect(envelope.output[0].type).toBe("message");
    expect(envelope.output[0].content[0].type).toBe("output_text");
    expect(envelope.output.slice(1).every((item) => item.type === "function_call")).toBe(true);
  });

  it("normalizes function arguments without double-encoding", () => {
    const envelope = buildResponsesEnvelope({
      responseId: "resp_3",
      created: 3,
      model: "gpt-4.1",
      outputText: "",
      functionCalls: [
        { id: "call_str", function: { name: "echo", arguments: '{"x":1}' } },
        { id: "call_obj", function: { name: "echo", arguments: { x: 1 } } },
      ],
      usage: null,
      status: "completed",
    });

    const [strItem, objItem] = envelope.output.slice(1);
    expect(strItem.arguments).toBe('{"x":1}');
    expect(objItem.arguments).toBe('{"x":1}');
  });
});
