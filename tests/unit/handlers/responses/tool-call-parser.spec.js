import { describe, expect, it } from "vitest";
import {
  createToolCallParser,
  createXmlToolCallParser,
} from "../../../../src/handlers/responses/tool-call-parser.js";

describe("responses tool call parser", () => {
  it("buffers partial <tool_call> tags across chunks", () => {
    const parser = createToolCallParser({ allowedTools: new Set(["localSearch"]) });

    const first = parser.ingest("Hello <tool");
    expect(first.visibleTextDeltas).toEqual(["Hello "]);
    expect(first.parsedToolCalls).toEqual([]);
    expect(first.errors).toEqual([]);

    const second = parser.ingest(
      '_call>{"name":"localSearch","arguments":"{\\"q\\":\\"x\\"}"}</tool_call> world'
    );

    expect(second.visibleTextDeltas).toEqual([" world"]);
    expect(second.errors).toEqual([]);
    expect(second.parsedToolCalls).toEqual([
      {
        name: "localSearch",
        arguments: '{"q":"x"}',
      },
    ]);
  });

  it("parses multiple tool calls in one chunk", () => {
    const parser = createToolCallParser({ allowedTools: new Set(["one", "two"]) });

    const result = parser.ingest(
      'A <tool_call>{"name":"one","arguments":"{}"}</tool_call> B <tool_call>{"name":"two","arguments":"{\\"x\\":1}"}</tool_call> C'
    );

    expect(result.visibleTextDeltas.join("")).toBe("A  B  C");
    expect(result.parsedToolCalls).toEqual([
      { name: "one", arguments: "{}" },
      { name: "two", arguments: '{"x":1}' },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("buffers partial </tool_call> tags across chunks", () => {
    const parser = createToolCallParser({ allowedTools: new Set(["webSearch"]) });

    const first = parser.ingest('<tool_call>{"name":"webSearch","arguments":"{}"}</tool');
    expect(first.visibleTextDeltas).toEqual([]);
    expect(first.parsedToolCalls).toEqual([]);

    const second = parser.ingest("_call> done");

    expect(second.visibleTextDeltas).toEqual([" done"]);
    expect(second.parsedToolCalls).toEqual([{ name: "webSearch", arguments: "{}" }]);
    expect(second.errors).toEqual([]);
  });

  it("falls back to text on invalid JSON when non-strict", () => {
    const parser = createToolCallParser({ allowedTools: new Set(["oops"]) });

    const result = parser.ingest("<tool_call>{bad}</tool_call>");

    expect(result.visibleTextDeltas).toEqual(["<tool_call>{bad}</tool_call>"]);
    expect(result.parsedToolCalls).toEqual([]);
    expect(result.errors[0]?.type).toBe("invalid_json");
  });

  it("parses tool calls with a stray trailing >", () => {
    const parser = createToolCallParser({ allowedTools: new Set(["webSearch"]) });

    const result = parser.ingest('<tool_call>{"name":"webSearch","arguments":"{}"}></tool_call>');

    expect(result.visibleTextDeltas).toEqual([]);
    expect(result.parsedToolCalls).toEqual([{ name: "webSearch", arguments: "{}" }]);
    expect(result.errors).toEqual([]);
  });

  it("parses tool calls with a stray trailing }", () => {
    const parser = createToolCallParser({ allowedTools: new Set(["webSearch"]) });

    const result = parser.ingest('<tool_call>{"name":"webSearch","arguments":"{}"}}</tool_call>');

    expect(result.visibleTextDeltas).toEqual([]);
    expect(result.parsedToolCalls).toEqual([{ name: "webSearch", arguments: "{}" }]);
    expect(result.errors).toEqual([]);
  });

  it("parses tool calls with a stray trailing ]", () => {
    const parser = createToolCallParser({ allowedTools: new Set(["webSearch"]) });

    const result = parser.ingest('<tool_call>{"name":"webSearch","arguments":"{}"}]</tool_call>');

    expect(result.visibleTextDeltas).toEqual([]);
    expect(result.parsedToolCalls).toEqual([{ name: "webSearch", arguments: "{}" }]);
    expect(result.errors).toEqual([]);
  });

  it("returns an error for unknown tools when strict fallback is enabled", () => {
    const parser = createToolCallParser({
      allowedTools: new Set(["known"]),
      strictFallback: true,
    });

    const result = parser.ingest('<tool_call>{"name":"unknown","arguments":"{}"}</tool_call>');

    expect(result.visibleTextDeltas).toEqual([]);
    expect(result.parsedToolCalls).toEqual([]);
    expect(result.errors[0]?.type).toBe("unknown_tool");
  });

  it("parses an unterminated tool call on flush", () => {
    const parser = createToolCallParser({ allowedTools: new Set(["webSearch"]) });

    const first = parser.ingest('<tool_call>{"name":"webSearch","arguments":"{}"}');

    expect(first.visibleTextDeltas).toEqual([]);
    expect(first.parsedToolCalls).toEqual([]);

    const flushed = parser.flush();

    expect(flushed.visibleTextDeltas).toEqual([]);
    expect(flushed.parsedToolCalls).toEqual([{ name: "webSearch", arguments: "{}" }]);
  });

  it("parses <use_tool> blocks into tool calls", () => {
    const parser = createXmlToolCallParser({ allowedTools: new Set(["localSearch"]) });

    const result = parser.ingest(
      '<use_tool><name>localSearch</name><query>piano</query><salientTerms>["piano"]</salientTerms></use_tool>'
    );

    expect(result.visibleTextDeltas).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.parsedToolCalls).toEqual([
      {
        name: "localSearch",
        arguments: '{"query": "piano", "salientTerms": ["piano"]}',
      },
    ]);
  });

  it("uses args tag content when provided", () => {
    const parser = createXmlToolCallParser({ allowedTools: new Set(["webSearch"]) });

    const result = parser.ingest(
      '<use_tool><name>webSearch</name><args>{"query":"x","chatHistory":[]}</args></use_tool>'
    );

    expect(result.visibleTextDeltas).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.parsedToolCalls).toEqual([
      { name: "webSearch", arguments: '{"query":"x","chatHistory":[]}' },
    ]);
  });
});
