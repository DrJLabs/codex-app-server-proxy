import { describe, expect, it } from "vitest";
import {
  buildDynamicTools,
  buildToolCallDeltaFromDynamicRequest,
} from "../../../src/lib/tools/dynamic-tools.js";

describe("dynamic tools mapping", () => {
  it("maps function tools to dynamicTools", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "d",
          parameters: { type: "object" },
        },
      },
    ];

    expect(buildDynamicTools(tools, "auto")).toEqual([
      { name: "lookup", description: "d", inputSchema: { type: "object" } },
    ]);
  });

  it("honors tool_choice none", () => {
    const tools = [
      {
        type: "function",
        function: { name: "lookup", parameters: {} },
      },
    ];

    expect(buildDynamicTools(tools, "none")).toEqual([]);
  });

  it("honors forced tool_choice", () => {
    const tools = [
      { type: "function", function: { name: "a", parameters: {} } },
      { type: "function", function: { name: "b", parameters: {} } },
    ];

    expect(buildDynamicTools(tools, { type: "function", function: { name: "b" } })).toEqual([
      { name: "b", description: "", inputSchema: {} },
    ]);
  });
});

describe("dynamic tool call request mapping", () => {
  it("builds tool_calls delta from dynamic_tool_call_request", () => {
    const delta = buildToolCallDeltaFromDynamicRequest({
      tool: "lookup",
      arguments: { id: 1 },
      callId: "call_1",
    });

    expect(delta).toEqual({
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"id":1}' },
        },
      ],
    });
  });
});
