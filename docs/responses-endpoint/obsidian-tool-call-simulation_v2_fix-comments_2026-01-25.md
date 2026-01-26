# Obsidian tool calling without JSON-RPC tool manifests (v2) — **with inline fix comments**

> **Purpose**: This is a revision of the original strategy doc with explicit, in-line comments describing concrete changes required to achieve closer **OpenAI Responses API** parity while operating within Codex app-server JSON-RPC constraints.
>
> **Comment legend**
> - **[FIX]** = required change to meet Responses parity / avoid client breakage
> - **[IMPROVE]** = strongly recommended hardening for “works with most clients” behavior
> - **[NOTE]** = clarifying detail or scope boundary

---

## Goal
Provide **OpenAI Responses-compatible tool calling** for Obsidian while the app-server schema lacks per-request tool manifests.

We simulate tool calling at the proxy layer:
- The model emits a **tool-call block** in text.
- The proxy converts it into OpenAI Responses **function_call output items**.
- The client executes the tool and sends a follow-up request with `function_call_output`.

This yields **wire-level compatibility** with the OpenAI Responses API even though the backend uses app-server JSON-RPC with only `InputItem` text/image.

> **[NOTE] Scope boundary**: This plan targets **custom function tools** (client-executed tools) in `/v1/responses`. It does not attempt to emulate OpenAI-hosted built-in tools (e.g., server-side web search) beyond whatever Codex app-server supports natively.

---

## Constraints from app-server schema (Codex 0.89.0)
- `SendUserTurnParams` has **no `tools` field**.
- `SendUserMessageParams` has **no `tools` field**.
- v2 `ThreadStartParams` has **no `tools` field**.
- `ToolsV2` only exposes built-in capability toggles: `web_search`, `view_image`.
- Tool definitions are surfaced via MCP status (`McpServerStatus.tools`), not per request.

See:
- `docs/reference/app-server-schema-0.89-tools.md`
- `docs/reference/app-server-tools.md`

---

## Proposed tool-call schema (text-only)

The model is instructed to emit tool calls as deterministic blocks that the proxy can parse.

### Schema (single tool call)

**Preferred (minimal) model output**
```
<tool_call>{"name":"localSearch","arguments":"{\"query\":\"...\"}"}</tool_call>
```

> **[FIX] Do not require the model to generate IDs.**  
> The original version required an `id` to be “stable” and reused as `call_id`. In OpenAI Responses, the *system* returns `call_id`; clients do not need the model to invent it. For reliability, have the **proxy generate `call_id`** and return it to the client.
>
> **[IMPROVE] Keep `arguments` as a JSON-encoded string.**  
> This matches Responses semantics and avoids accidental re-serialization differences.

### If you must support a model-authored ID (not recommended)
```
<tool_call>{"call_id":"call_abc123","name":"localSearch","arguments":"{\"query\":\"...\"}"}</tool_call>
```
> **[NOTE]** Only use this if you *cannot* generate ids in the proxy (rare). It increases model-formatting failure rates.

### Rules
- `name` must match an allowed tool in the proxy’s request-scoped registry.
- `arguments` must be a **string** containing JSON.
- The tool-call JSON must **not** be wrapped in Markdown fences.
- Only sentinel-wrapped blocks are interpreted as tool calls.

> **[FIX] Name validation must match Responses tool shape.**  
> The original doc referenced `tools[].function.name` (Chat Completions style). In **Responses**, function tools use `{ "type":"function", "name":"..." }`. The proxy should validate against `tools[].name` for Responses requests.

---

## OpenAI Responses parity mapping

### OpenAI standard (reference)

When a model calls a tool, OpenAI Responses typically returns an **output item** of type `function_call`, including:
- an output item `id` (item id)
- a `call_id` (correlation id the client must echo back on `function_call_output`)
- `name`
- `arguments` (JSON string)

Then the client executes the tool and sends a follow-up input item:
```json
{
  "type": "function_call_output",
  "call_id": "call_abc123",
  "output": "..."
}
```

> **[FIX] Remove `finish_reason: "tool_calls"` from this strategy.**  
> `finish_reason` is a Chat Completions concept and is not part of the Responses object model. Responses streams terminate with `response.completed` and non-stream responses return typed `output` items plus `status`.

### Proxy simulation mapping (corrected)

| OpenAI Responses concept | Proxy simulation behavior |
|---|---|
| `tools[]` in request | Stored in proxy (not sent to app-server) |
| Tool call emitted by model | Model emits `<tool_call>{...}</tool_call>` in text |
| `function_call` output item | Proxy emits an output item `type:"function_call"` with `call_id`, `name`, `arguments` |
| Streaming arg deltas | Proxy may synthesize `response.function_call_arguments.delta` / `.done` |
| Stream completion | Proxy emits `response.completed` |
| `function_call_output` input | Client sends tool output; proxy flattens into a transcript item for app-server |

> **[FIX] Event names**: use Responses streaming events like:
> - `response.output_item.added`
> - `response.function_call_arguments.delta` and `response.function_call_arguments.done`
> - `response.output_item.done`
> - `response.completed`  
> The original draft referenced `response.function_call.delta` (not the documented event).

---

## Detailed flow (revised)

### 1) Ingress tool registry
- Accept `tools[]` on `/v1/responses`.
- Normalize and store request-scoped registry with deterministic ordering.

> **[IMPROVE] Tool shape normalization for real clients**  
> Some clients send “mixed” shapes during migration. Consider accepting both:
> - Responses: `{ "type":"function", "name":"x", "parameters":{...} }`
> - Chat Completions: `{ "type":"function", "function":{ "name":"x", "parameters":{...} } }`  
> If your proxy is strict `/v1/responses` only, you can reject non-Responses shapes, but that reduces compatibility.

> **[IMPROVE] Respect `tool_choice` / `allowed_tools`**  
> If the request sets `tool_choice: "none"`, the prompt must prohibit `<tool_call>`. If forced to a tool, the prompt must enforce that exact tool name. This avoids client-visible mismatches.

> **[IMPROVE] Strict mode defaults**  
> Responses function calling commonly assumes strict JSON schema conformance. If `strict:true` (or default strict is assumed), validate the produced arguments against the tool schema before emitting a `function_call` item.

### 2) Prompt injection (tool schema)
- Inject a short rule block into the developer/system transcript specifying:
  - sentinel format
  - allowed tool names
  - argument schema expectations
  - tool_choice constraints (if any)

> **[FIX] Do not mutate `baseInstructions`.**  
> Only append to developer/system transcript content at the proxy boundary.

> **[IMPROVE] Include a compact tool manifest**  
> Provide `name`, `description`, and **parameter schema** (JSON Schema) in the injected prompt so the model can form valid arguments.

### 3) Streaming parse
- Buffer streamed deltas from app-server.
- Detect sentinel-wrapped blocks only:
  - Support boundary splits across chunks (`<tool_` in one chunk, rest in next).
- Parse JSON and validate:
  - required fields: `name`, `arguments` (and `call_id` if you allow model-authored ids)
  - `name` is in the registry
  - `arguments` is a string

> **[FIX] Sentinel-only parsing**  
> Do not parse arbitrary JSON lines; many assistants output JSON as content. Sentinel blocks are the safest discriminator.

> **[IMPROVE] State machine parser**  
> Implement a state machine to handle partial tags, multiple tool calls, and malformed blocks without leaking tool-call text to the client output stream.

### 4) Emit OpenAI Responses function_call output items
- On detecting a tool call:
  - Generate a proxy `call_id` (unless model supplied and you accept it).
  - Emit a Responses `function_call` output item including:
    - `id` (output item id; generated)
    - `call_id` (correlation id; generated)
    - `name`
    - `arguments` (string)

- Streaming:
  - Emit `response.output_item.added` for the function_call item.
  - Optionally synthesize `response.function_call_arguments.delta` events.
  - Emit `response.function_call_arguments.done` with the full arguments string.
  - Emit `response.output_item.done` for the function_call item.
  - Then emit `response.completed` for the response.

> **[FIX] Do not emit `finish_reason`.**  
> Avoid adding Chat Completions fields to Responses outputs; clients may validate strictly.

> **[IMPROVE] Synthetic argument deltas**  
> If you only learn the full arguments after buffering the entire sentinel block, you can still synthesize deltas by splitting the final string. Clients that don’t care will ignore the deltas; clients that do can still process them.

### 5) Tool output round-trip
- The client executes the tool and sends a follow-up request that includes `function_call_output` items.
- Proxy flattens tool outputs into app-server transcript items.

> **[FIX] Accept that clients often include prior response items.**  
> Many Responses clients append `response.output` items (including the `function_call` item itself) into the next request’s `input`. Your proxy should tolerate/accept `function_call` items echoed back, not only `function_call_output`.

**Recommended flattened transcript format**
- `[function_call call_id=call_abc123 name=localSearch arguments={...}]`
- `[function_call_output call_id=call_abc123 output=... ]`

> **[IMPROVE] More self-describing flattening**  
> The original plan used `[tool:<id>] <output>` only. Including `name` and `call_id` improves reliability with multiple tool calls and reduces model confusion.

---

## Implementation plan (code-level) — annotated

### A) Tool registry + schema injection
- `src/handlers/responses/native/request.js`
  - If `tools` present:
    - Normalize to Responses tool shape (or reject non-conforming shapes).
    - Apply `tool_choice` constraints to injected instructions.
    - Inject compact schema for each tool.

> **[FIX] Validate tool names using `tools[].name` (Responses).**

### B) Tool-call parser
- New module `src/handlers/responses/tool-call-parser.js`
  - Sentinel-only parsing
  - State machine for chunk boundaries
  - Returns:
    - `toolCalls[]` (each with `name`, `arguments`)
    - `remainingText` (safe to forward)

> **[IMPROVE] Add JSON Schema validation hook here** (if strict).

### C) Stream adapter integration
- `src/handlers/responses/stream-adapter.js`
  - Run parser on deltas
  - When tool call found:
    - stop forwarding the tool-call block
    - emit Responses `function_call` events

> **[FIX] Use documented SSE event names**  
> `response.function_call_arguments.delta/done` (not `response.function_call.delta`).

### D) Non-stream path
- `src/handlers/responses/nonstream.js`
  - Parse full assistant output for sentinel blocks
  - Convert to Responses `function_call` items
  - Remove tool-call block from visible text output

> **[FIX] Response JSON must be Responses-shaped** (typed `output` items, no `finish_reason`).

### E) Tool output handling
- `src/handlers/responses/native/request.js`
  - Handle `function_call_output` input items:
    - validate `call_id` exists / matches registry
    - flatten as transcript text for app-server

> **[FIX] Also accept echoed-back `function_call` items** in `input`  
> Ignore or flatten them; do not error solely because they appear.

### F) Tests and fixtures
Add fixtures to assert:
- tool-call blocks never appear in user-visible text
- streaming event ordering matches Responses expectations
- multiple tool calls (parallel) behavior:
  - if `parallel_tool_calls` is supported, test multi-call sequences
- `tool_choice` modes: `none`, `required`, forced function, allowed_tools
- strict schema violations (when `strict` is enabled)

---

## Compatibility hardeners (recommended)

1. **Graceful failure mode**
   - If a tool-call block is malformed:
     - either treat it as plain text (best-effort), or
     - return a structured error response (strict mode).
2. **Call correlation table**
   - Maintain per-request mapping of `call_id -> name` for validation and consistent flattening.
3. **Telemetry**
   - Log: tool name, schema validation pass/fail, parsing errors, client echo patterns.

---

## Summary

This approach can preserve OpenAI Responses semantics while working within app-server JSON-RPC constraints, **provided** you:
- enforce Responses tool shape (`tools[].name`)
- generate and return `call_id` in the proxy (do not require model-authored IDs)
- emit correct Responses SSE event types and completion behavior
- avoid Chat Completions-only fields like `finish_reason`
- accept common client round-trip patterns (echoing `function_call` items)
- optionally implement strict argument schema validation for higher fidelity
