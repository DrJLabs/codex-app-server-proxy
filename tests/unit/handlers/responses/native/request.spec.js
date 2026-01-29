import { describe, expect, it } from "vitest";
import { normalizeResponsesRequest } from "../../../../../src/handlers/responses/native/request.js";

const expectNormalizeError = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err?.body) return err.body;
    return err;
  }
  throw new Error("expected normalization error");
};

describe("native responses request normalizer", () => {
  it("rejects top-level messages", () => {
    const body = { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] };
    const err = expectNormalizeError(() => normalizeResponsesRequest(body));
    expect(err.error.param).toBe("messages");
  });

  it("flattens instructions and input text into a single transcript item", () => {
    const body = { instructions: "Be nice", input: "Hi" };
    const result = normalizeResponsesRequest(body);
    expect(result.developerInstructions).toBe("Be nice");
    expect(result.inputItems).toEqual([{ type: "text", data: { text: "[user] Hi" } }]);
  });

  it("orders developerInstructions with tool schema first", () => {
    const body = {
      instructions: "Be nice",
      tools: [
        {
          type: "function",
          name: "lookup_user",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
      input: [
        { type: "message", role: "system", content: "System prompt" },
        { type: "message", role: "developer", content: "Developer prompt" },
        { type: "message", role: "user", content: "Hi" },
      ],
    };
    const result = normalizeResponsesRequest(body, { injectToolInstructions: true });
    const text = result.developerInstructions;
    const toolIndex = text.indexOf("Available tools (schema):");
    const instructionIndex = text.indexOf("Be nice");
    const systemIndex = text.indexOf("System prompt");
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeGreaterThan(toolIndex);
    expect(systemIndex).toBeGreaterThan(instructionIndex);
    expect(text).toContain("Developer prompt");
  });

  it("flattens message and function_call_output items", () => {
    const body = {
      input: [
        { type: "message", role: "assistant", content: "ok" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
    };
    const result = normalizeResponsesRequest(body);
    expect(result.inputItems).toEqual([
      {
        type: "text",
        data: { text: "[assistant] ok\n[function_call_output call_id=c1 output=done]" },
      },
    ]);
  });

  it("accepts echoed function_call items", () => {
    const body = {
      input: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "fc_1",
          name: "lookup",
          arguments: '{"id":1}',
        },
      ],
    };
    const result = normalizeResponsesRequest(body);
    expect(result.inputItems).toEqual([
      {
        type: "text",
        data: {
          text: '[function_call id=fc_1 call_id=fc_1 name=lookup arguments={"id":1}]',
        },
      },
    ]);
  });

  it("emits role marker and image items for input_image", () => {
    const body = { input: [{ type: "input_image", image_url: "https://img" }] };
    const result = normalizeResponsesRequest(body);
    expect(result.inputItems).toEqual([
      { type: "text", data: { text: "[user]" } },
      { type: "image", data: { image_url: "https://img" } },
    ]);
  });

  it("emits role markers around images inside messages", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "hi" },
            { type: "input_image", image_url: "https://img" },
            { type: "input_text", text: "there" },
          ],
        },
      ],
    };
    const result = normalizeResponsesRequest(body);
    expect(result.inputItems).toEqual([
      { type: "text", data: { text: "[user] hi" } },
      { type: "image", data: { image_url: "https://img" } },
      { type: "text", data: { text: "[user] there" } },
    ]);
  });

  it("accepts responses-style function tools with top-level name", () => {
    const body = {
      tools: [
        {
          type: "function",
          name: "lookup_user",
          description: "lookup",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
      tool_choice: { type: "function", name: "lookup_user" },
    };
    const result = normalizeResponsesRequest(body);
    expect(result.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "lookup_user" }),
      }),
    ]);
    expect(result.toolChoice).toEqual(
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "lookup_user" }),
      })
    );
  });

  it("passes through non-function tools", () => {
    const body = { tools: [{ type: "web_search", foo: "bar" }] };
    const result = normalizeResponsesRequest(body);
    expect(result.tools).toEqual([expect.objectContaining({ type: "web_search", foo: "bar" })]);
  });

  it("moves system and developer messages into developerInstructions", () => {
    const body = {
      input: [
        { type: "message", role: "system", content: "System prompt" },
        { type: "message", role: "developer", content: "Developer prompt" },
        { type: "message", role: "user", content: "Hi" },
      ],
    };
    const result = normalizeResponsesRequest(body);
    expect(result.developerInstructions).toBe("System prompt\n\nDeveloper prompt");
    expect(result.inputItems).toEqual([{ type: "text", data: { text: "[user] Hi" } }]);
  });

  it("defaults tool_choice to auto when tools are provided", () => {
    const body = {
      tools: [{ type: "function", function: { name: "lookup" } }],
    };
    const result = normalizeResponsesRequest(body);
    expect(result.toolChoice).toBe("auto");
  });

  it("respects explicit tool_choice when provided", () => {
    const body = {
      tools: [{ type: "function", function: { name: "writeToFile" } }],
      tool_choice: "none",
      input: "Create a new note named [[Example]].",
    };
    const result = normalizeResponsesRequest(body);
    expect(result.toolChoice).toBe("none");
  });

  it("allows disabling tool schema injection when requested", () => {
    const body = {
      instructions: "Be nice",
      tools: [
        {
          type: "function",
          name: "lookup_user",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
      input: [
        { type: "message", role: "system", content: "System prompt" },
        { type: "message", role: "developer", content: "Developer prompt" },
        { type: "message", role: "user", content: "Hi" },
      ],
    };
    const result = normalizeResponsesRequest(body, { injectToolInstructions: false });
    const text = result.developerInstructions;
    expect(text).toContain("Be nice");
    expect(text).toContain("System prompt");
    expect(text).toContain("Developer prompt");
    expect(text).not.toContain("Tool calling instructions:");
    expect(text).not.toContain("Available tools (schema):");
  });

  it("injects tool schema guidance into the transcript when tools are present", () => {
    const body = {
      tools: [
        {
          type: "function",
          name: "lookup_user",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
      input: "hi",
    };
    const result = normalizeResponsesRequest(body, { injectToolInstructions: true });
    const text = result.developerInstructions;
    expect(text).toContain("Only emit tool calls using <tool_call>...</tool_call>.");
    expect(text).toContain(
      'Inside <tool_call>...</tool_call>, output ONLY a JSON object with keys "name" and "arguments".'
    );
    expect(text).toContain(
      "Always emit <tool_call> blocks exactly as shown; the client executes them."
    );
    expect(text).toContain(
      "Do NOT call internal tools directly (shell, apply_patch, web_search, view_image); only emit <tool_call>."
    );
    expect(text).toContain(
      "Read-only sandbox or approval restrictions do NOT prevent emitting <tool_call> output."
    );
    expect(text).toContain(
      "Use EXACT parameter names from the schema; do NOT invent or rename keys."
    );
    expect(text).toContain(
      'Do not add any extra characters before or after the JSON (no trailing ">", no code fences).'
    );
    expect(text).toContain("Use exactly one opening <tool_call> and one closing </tool_call> tag.");
    expect(text).toContain(
      "Output must be valid JSON. Do not add extra braces or trailing characters."
    );
    expect(text).toContain(
      'Do NOT wrap the JSON object in an array (no leading "[" or trailing "]").'
    );
    expect(text).toContain('Bad: <tool_call>[{"name":"tool","arguments":"{...}"}]</tool_call>');
    expect(text).toContain("Never repeat the closing tag.");
    expect(text).toContain(
      'Example (exact): <tool_call>{"name":"webSearch","arguments":"{\\"query\\":\\"example\\",\\"chatHistory\\":[]}"}</tool_call>'
    );
    expect(text).toContain('If a tool has no parameters, use arguments "{}".');
    expect(text).toContain("Available tools (schema):");
    expect(text).toContain("Per-tool guidance and examples (schema-conformant):");
    expect(text).toContain("Tool: lookup_user");
    expect(text).toContain("Parameters:");
    expect(text).toContain("- id (optional, string)");
    expect(text).toContain("Example tool_call:");
    expect(text).toContain("lookup_user");
    expect(text).toContain('"type":"object"');
    expect(text).toContain("If no tool is needed, respond with plain text.");
    expect(result.inputItems[0].data.text).toContain("[user] hi");
  });

  it("rejects unsupported input item types", () => {
    const err = expectNormalizeError(() =>
      normalizeResponsesRequest({ input: [{ type: "bogus" }] })
    );
    expect(err.error.param).toBe("input[0]");
  });
});
