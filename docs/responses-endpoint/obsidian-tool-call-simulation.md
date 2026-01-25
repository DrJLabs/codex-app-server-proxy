# Obsidian tool calling without JSON-RPC tool manifests

> **Note**: This v1 draft is superseded. See
> [`obsidian-tool-call-simulation_v2_fix-comments_2026-01-25.md`](obsidian-tool-call-simulation_v2_fix-comments_2026-01-25.md)
> for the current behavior (call_id, sentinel parsing, and transcript flattening).

## Goal
Provide **OpenAI Responses-compatible tool calling** for Obsidian while the app-server schema lacks per-request tool manifests.

We simulate tool calling at the proxy layer:
- The model emits a **tool-call JSON block** in text.
- The proxy converts it into OpenAI Responses **tool call items**.
- The client executes the tool and sends a follow-up request with `function_call_output`.

This yields **wire-level parity** with the OpenAI Responses API even though the backend uses app-server JSON-RPC with only `InputItem` text/image.

## Constraints from app-server schema (Codex 0.89.0)
- `SendUserTurnParams` has **no `tools` field**.
- `SendUserMessageParams` has **no `tools` field**.
- v2 `ThreadStartParams` has **no `tools` field**.
- `ToolsV2` only exposes built-in capability toggles: `web_search`, `view_image`.
- Tool definitions are surfaced via MCP status (`McpServerStatus.tools`), not per request.

See `docs/reference/app-server-schema-0.89-tools.md`.

---

## Proposed tool-call schema (text-only)

The model is instructed to emit tool calls **as strict JSON blocks** that the proxy can parse deterministically. The block is embedded in text output, but the proxy strips it and converts it to OpenAI tool-call items.

### Schema (single tool call)

```json
{
  "type": "tool_call",
  "id": "call_abc123",
  "name": "localSearch",
  "arguments": "{\"query\":\"...\",\"salientTerms\":[...]}"
}
```

**Rules**
- `id` is required and must be stable. The client will use it as `call_id` in the next request.
- `name` must match one of the `tools[].function.name` provided by the client.
- `arguments` must be a **string**, matching OpenAI Responses semantics.
- The JSON block **must not** be wrapped in Markdown (no code fences). It should appear by itself on its own line.

### Sentinel framing (optional but recommended)
To avoid accidental parsing of ordinary JSON, wrap tool calls in explicit sentinels:

```
<tool_call>{...}</tool_call>
```

The proxy treats only sentinel-wrapped JSON as a tool call.

---

## OpenAI Responses parity mapping

### OpenAI standard (reference)

When a model calls a tool, OpenAI Responses emits:

1. **Tool call item** in the response stream:
   - `response.output_item.added` (type `function_call`)
   - `response.function_call.delta` (optional streaming of arguments)
   - `response.output_item.done`
2. The response ends with `finish_reason: "tool_calls"`.

Then the client executes the tool and sends a follow-up request with:

```json
{
  "type": "function_call_output",
  "call_id": "call_abc123",
  "output": "..."
}
```

### Proxy simulation mapping

| OpenAI Responses concept | Proxy simulation behavior |
|---|---|
| `tools[]` in request | Stored in proxy (not sent to app-server) |
| Tool call emitted by model | Model emits JSON tool-call block in text |
| `response.output_item.added` | Proxy emits SSE event for function_call item |
| `response.function_call.delta` | Proxy streams argument deltas (optional) |
| `response.output_item.done` | Proxy closes tool call item |
| `finish_reason: tool_calls` | Proxy sets finish reason accordingly |
| `function_call_output` input | Client sends output; proxy flattens to `[tool:<id>] <output>` |

This preserves OpenAI wire format while keeping the app-server payload text-only.

---

## Detailed flow

### 1) Ingress tool registry
- Accept the OpenAI `tools[]` array on `/v1/responses`.
- Validate and normalize tool names, parameters, and ordering.
- Store a **request-scoped tool registry** with deterministic order.

### 2) Prompt injection (tool schema)
- Inject a strict tool-call schema into the developer/system transcript.
- **Do not use `baseInstructions`** (must remain unchanged).
- Append a concise rule block like:
  - “When calling a tool, output exactly one JSON object in the schema above.”

### 3) Streaming parse
- As text deltas stream from app-server, buffer per choice.
- Detect tool-call blocks (JSON line or sentinel-wrapped JSON).
- Parse and validate:
  - required fields (`id`, `name`, `arguments`)
  - `name` must be in tool registry
  - `arguments` coerced to string

### 4) Emit OpenAI tool-call items
- Convert parsed tool calls into OpenAI Responses tool-call items:
  - Create a function-call item with `id`, `name`, `arguments`.
  - Emit SSE events identical to OpenAI:
    - `response.output_item.added`
    - `response.function_call.delta` (optional) / `response.output_item.done`
- Remove tool-call JSON from output text (so it never appears in user-visible content).
- End the response with finish reason `tool_calls`.

### 5) Tool output round-trip
- Client runs the tool and sends `function_call_output` in the next request.
- Proxy flattens into:
  - `[tool:<call_id>] <output>`
- The model gets the tool result in the prompt text (stateless, safe for new session per request).

---

## Implementation plan (code-level)

### A) Tool registry + schema injection
- `src/handlers/responses/native/request.js`
  - If `tools` present, append a strict tool-call schema block to the transcript text.
  - Preserve deterministic order and tool id semantics.

### B) Tool-call parser
- New parser module (e.g., `src/handlers/responses/tool-call-parser.js`)
  - Accepts streaming text chunks.
  - Extracts tool-call JSON blocks.
  - Returns `{ toolCalls, remainingText }`.

### C) Stream adapter integration
- `src/handlers/responses/stream-adapter.js`
  - On each text delta, run parser.
  - Emit tool-call SSE events when parser returns a call.
  - Forward only `remainingText` as `response.output_text.delta`.

### D) Non-stream path
- `src/handlers/responses/nonstream.js`
  - Parse the final combined output text.
  - Convert tool calls into `function_call` items via `buildResponsesEnvelope`.
  - Remove tool-call JSON from `output_text`.

### E) Tool output handling (already present)
- `src/handlers/responses/native/request.js`
  - `function_call_output` items are already flattened to `[tool:<id>] <output>`.

### F) Tests and fixtures
- Add fixtures that contain tool-call JSON blocks in model output.
- Assert:
  - SSE tool-call events are emitted correctly.
  - Output text excludes tool-call JSON.
  - Follow-up request with `function_call_output` round-trips into the transcript.

---

## Notes on strict parity
- The proxy must emit **only** OpenAI-standard fields in SSE and response payloads.
- Tool IDs must be stable and preserved (`id` in response; `call_id` in follow-up).
- Arguments must remain **raw strings** (no JSON parse/serialize round-trip unless needed to stringify).
- Unknown tool names should be logged; the proxy should still emit the tool call item for parity but mark the response failed if policy requires strict validation.

---

## Summary
This approach preserves OpenAI Responses semantics while working within app-server JSON-RPC constraints. The proxy simulates tool calls at the boundary by converting structured tool-call JSON blocks into OpenAI-native tool call items and expecting tool outputs in follow-up requests.
