# Outline - App-server tool events to client response (reverse trace)

- Goal and scope
  - Reverse trace: app-server tool request/output events -> proxy transformations -> client response
  - Focus: tool-call aggregation, obsidian-xml vs openai-json, SSE shaping (chat + responses)

- Key entrypoints and primitives
  - JSON-RPC transport + server requests
  - Stream event parsing + routing
  - Tool call aggregation + XML/JSON shaping
  - SSE emitters (chat vs responses)

- Reverse trace (by endpoint)
  - /v1/chat/completions stream
    - dynamic_tool_call_request -> tool_calls deltas
    - tool-call aggregation (structured + textual)
    - obsidian-xml output path (use_tool XML)
    - SSE chunk shaping and finish
  - /v1/chat/completions nonstream
    - aggregation + buildAssistantMessage
  - /v1/responses stream
    - runNativeResponses -> stream-adapter SSE events
    - tool call parsing (<tool_call>) + aggregation
  - /v1/responses nonstream
    - tool output inputs (function_call_output/tool_output)
    - parseToolCallText + aggregation -> envelope

- Abnormalities / concerns
  - Mixed tool-call sources (structured + textual) -> duplicates
  - Different XML tags between chat (<use_tool>) and responses (<tool_call>)
  - Strict parsing failures -> stream failure / status failed
  - Output-mode header differences between chat and responses
  - Tool outputs only wired for responses endpoint

- Recommendations
  - Normalize tool-call parsing and tags across endpoints
  - Guard against double-emitting tool calls
  - Clarify output-mode semantics for v2 migration
  - Add/extend tests and logging around tool-call deltas and SSE

- References
  - List file paths + key functions
