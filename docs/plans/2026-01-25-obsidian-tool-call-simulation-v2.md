# Obsidian tool calling without JSON-RPC tool manifests (v2)

> **Objective**: Preserve **OpenAI `/v1/responses` function tool calling parity** (request/response shape + streaming events) while the backend “model” is a Codex app-server that only accepts **text/image `InputItem`s** and does **not** support per-request tool manifests.

> **Approach**: Proxy-layer simulation.
> 1) Client sends `/v1/responses` with `tools[]` (function tools).
> 2) Proxy injects tool schema + strict formatting rules into the app-server transcript.
> 3) Backend emits sentinel-wrapped `<tool_call>{...}</tool_call>` blocks in text.
> 4) Proxy parses the blocks and emits true Responses **`function_call` output items** (with `call_id`) + correct SSE events.
> 5) Client executes tool(s) and sends `function_call_output` on a follow-up request.
> 6) Proxy flattens tool results into transcript text for the backend to continue.

---

## Key decisions (authoritative)

### D1. `call_id` is required for function calling parity
- Every Responses **`function_call`** output item must include:
  - `id` (output item id)
  - `call_id` (correlation id)
  - `name`
  - `arguments` (JSON string)
- Every follow-up Responses **`function_call_output`** input item must include `call_id` and `output`.

**Simplification allowed**: `call_id = id` (acceptable and reduces bookkeeping), but keep both fields.

### D2. `/v1/responses` SSE does **not** include top-level `call_id` on `response.function_call_arguments.*`
For `/v1/responses` streaming events:
- `response.function_call_arguments.delta` and `.done` should contain **only** the documented SSE fields (e.g., `item_id`, `output_index`, `sequence_number`, and `delta`/`arguments`/`name` as applicable).
- Clients correlate to `call_id` via the `function_call` output item’s `item_id` and the emitted output item content (which includes `call_id`).

> If/when you add **Realtime** support later, *Realtime* events include `call_id` for these events. Keep that as a separate emitter/profile; do not pollute `/v1/responses` SSE.

### D3. Accept echoed `function_call` items in follow-up `input`
Many clients append prior `response.output` into the next request’s `input`. Therefore:
- Do **not** reject echoed `function_call` items.
- Accept and either ignore or flatten them (non-fatal).

### D4. Tool shape normalization: Responses-first with migration fallback
Support both tool shapes:
- Responses: `{ "type":"function", "name":"...", "parameters":{...}, "strict":true|false, "description":"..." }`
- Migration fallback: `{ "type":"function", "function":{ "name":"...", "parameters":{...}, "strict":..., "description":"..." } }`

Normalize internally to a single canonical shape.

### D5. `strict` enforcement policy
- Enforce schema validation **only** when `tool.strict === true`.
- When strict is omitted or false:
  - still inject schema into prompt,
  - perform **soft validation** (see D5a) but do not hard-fail.

#### D5a. Soft validation behavior (explicit)
When strict is not enabled:
1. Attempt to parse `arguments` as JSON.
2. If parse fails:
   - attempt one repair pass (e.g., remove trailing commas / fix quoting) *if safe*; otherwise
   - treat the `<tool_call>` block as normal assistant text and **do not** emit a tool call.
3. If parse succeeds but schema mismatch:
   - log a warning and still emit the tool call (best-effort).

When strict is enabled:
- If JSON parse fails or schema mismatch occurs, **do not** emit a tool call; return an error response or convert into an assistant error message per your proxy’s error policy (choose one and keep consistent).

---

## Non-goals / scope boundaries

- Not emulating OpenAI-hosted built-in tools beyond what Codex app-server provides natively.
- Not adding Realtime support in this v2 document (but see D2 note).
- Not guaranteeing perfect “model-level tool reasoning” parity; this is **wire-level** parity for clients.

---

## Wire contract (OpenAI Responses parity targets)

### Requests (ingress)
Proxy should accept:
- `/v1/responses` with `model`, `input`, optional `tools`, optional `tool_choice`, and streaming options.
- `input` items including:
  - `input_text`
  - `input_image` (if supported)
  - echoed `function_call` (must not error)
  - `function_call_output` (must be handled)

### Responses (egress)
Non-stream:
- `status: "completed"` and `output: [...]` containing either:
  - `output_text` items and/or
  - `function_call` output items (with `id` + `call_id`)

Stream:
- SSE events with correct ordering, and terminate with `response.completed`.

---

## Tool-call sentinel format (backend output contract)

Backend must emit tool calls only as sentinel-wrapped JSON blocks:

```
<tool_call>{"name":"toolName","arguments":"{\"k\":\"v\"}"}</tool_call>
```

Rules:
- `name`: string, must match allowed tools for the request.
- `arguments`: string containing JSON (not an object).
- No Markdown fences around the block.
- Any content outside `<tool_call>...</tool_call>` is normal assistant text.

> **Hard rule**: Proxy only recognizes sentinel blocks as tool calls (prevents false positives when assistant prints JSON normally).

---

## Proxy internals: normalized representations

### Tool definition normalization
Canonical internal tool shape (example):
```js
{
  type: "function",
  name: "localSearch",
  description: "...",
  parameters: { /* JSON Schema */ },
  strict: true|false|undefined
}
```

Normalization helpers:
- `toolName = tool?.name ?? tool?.function?.name`
- `toolParams = tool?.parameters ?? tool?.function?.parameters`
- `toolStrict = tool?.strict ?? tool?.function?.strict`
- `toolDesc = tool?.description ?? tool?.function?.description`

### Tool call normalization
Canonical internal tool call (parsed from sentinel):
```js
{
  name: "localSearch",
  arguments: "{\"query\":\"...\"}"
}
```

### Finalization step (required)
Use a single, centralized function to render a Responses tool-call output item:
```js
function toResponsesFunctionCallItem({ itemId, callId, name, argumentsStr }) {
  return {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsStr
  };
}
```

> This eliminates drift between internal aggregator shapes and the final Responses shape.

---

## Streaming behavior (SSE)

### Overview
- While streaming assistant text, proxy forwards normal text deltas to the client.
- When a `<tool_call>` sentinel begins, proxy **buffers** until the closing tag arrives.
- Proxy then emits Responses tool-call SSE events and **does not forward** the sentinel text to the client.

### Required SSE event sequence for a tool call
Minimum compliant sequence (single tool call):
1. `response.output_item.added` with a `function_call` item (arguments may be empty or partial if you intend to stream deltas)
2. Optional: one or more `response.function_call_arguments.delta`
3. `response.function_call_arguments.done`
4. `response.output_item.done`
5. `response.completed` (only when the overall response is complete)

### `sequence_number` semantics (explicit)
- Maintain a **single monotonically increasing** `sequence_number` per response stream (global counter).
- Increment for every SSE event emitted by the proxy (including text deltas and tool-call events).
- This avoids ambiguity and simplifies fixtures.

---

## Non-stream behavior

- Parse the full assistant output as a whole (same sentinel parsing logic).
- If a tool call is present:
  - Remove sentinel block from user-visible text output.
  - Emit a `function_call` output item in `output`.
- If text remains after removing sentinel blocks, emit it as `output_text` items.

---

## Follow-up handling: tool outputs

### Accepted input items
On subsequent `/v1/responses` requests, accept:
- `function_call_output` items:
  ```json
  { "type":"function_call_output", "call_id":"call_...", "output":"..." }
  ```
- echoed `function_call` items (ignore or flatten, but do not error).

### Flattening format to backend transcript
Recommended format (self-describing and robust):
- `[function_call id=<itemId> call_id=<callId> name=<name> arguments=<json>]`
- `[function_call_output call_id=<callId> output=<tool_output>]`

This reduces model confusion with multiple tool calls and avoids relying on implicit ordering.

---

## Multi-tool calls (supported)

The proxy must support:
- multiple `<tool_call>...</tool_call>` blocks in one assistant message
- sequential calls across multiple turns
- deterministic ordering of emitted output items (appearance order in text)

### ID/call_id assignment (multi-tool)
- Assign ids in appearance order: `fc_001`, `fc_002`, ...
- Assign `call_id = id` (recommended) or `call_001`, etc.
- Maintain mapping `item_id -> call_id` for correlation in streaming.

---

## Parser requirements

### Sentinel-only parser
A robust streaming parser should be state-machine based:
- `TEXT` state: forward text deltas
- `IN_TAG` state: buffering from `<tool_call>` until `</tool_call>` found
- On completion:
  - parse JSON
  - validate tool name exists in registry
  - validate `arguments` is a string
  - strict/soft validation as per D5

### Failure modes
- Malformed JSON inside sentinel:
  - strict: error/fail
  - non-strict: treat as normal text (do not emit tool call)
- Unknown tool name:
  - strict: error/fail
  - non-strict: treat as normal text

---

## Tool schema injection into backend transcript

### Injection goals
- Provide tool names + parameter schemas to help the backend form correct arguments.
- Enforce sentinel-only tool call format.
- Apply `tool_choice` policy (none/required/forced tool) when present.

### Injection content (recommendation)
Add a developer/system segment before the user content:
- “Only call tools using `<tool_call>...</tool_call>` format; never emit tool calls otherwise.”
- List allowed tools with compact schemas.
- Include strict guidance:
  - If strict is required for any tool, say “arguments MUST conform exactly.”
- If tool_choice is forced:
  - “If you call a tool, it must be `<name>`.”
- If tool_choice none:
  - “Never emit `<tool_call>`.”

---

## Implementation tasks (concrete)

### Task 1 — `<tool_call>` parser module
- New module: `src/handlers/responses/tool-call-parser.js`
- Inputs: streaming text deltas + allowed tool names + strict map
- Outputs:
  - `visibleTextDeltas[]`
  - `parsedToolCalls[]` (appearance-ordered)
  - `errors[]` (for telemetry or strict failures)

Required tests:
- split `<tool_call>` boundaries across chunks
- invalid JSON inside sentinel
- unknown tool name
- multiple tool calls in one message

### Task 2 — Streaming integration
- Hook parser into `src/handlers/responses/stream-adapter.js`
- When tool call completes:
  - stop forwarding sentinel text
  - emit SSE sequence for tool-call item
  - ensure `function_call` item includes `call_id` (but `response.function_call_arguments.*` events do not include top-level `call_id` in `/v1/responses` profile)

### Task 3 — Non-stream integration
- In `src/handlers/responses/nonstream.js`:
  - parse full assistant output
  - emit `output_text` and/or `function_call` items
  - render with `toResponsesFunctionCallItem(...)` finalizer

### Task 4 — Tool registry + injection
- In ingress handler `src/handlers/responses/native/request.js`:
  - normalize tools
  - build tool registry (name → schema/strict)
  - inject tool manifest and formatting rules into backend transcript

### Task 5 — Tool output handling
- In ingress handler:
  - accept `function_call_output`
  - accept echoed `function_call` items (ignore/flatten)
  - flatten to transcript text blocks

### Task 6 — Capability gating bypass
- Ensure proxy-level tool simulation is not blocked by backend “tools enabled” toggles
- Keep backend toggles reserved for native features (web_search/view_image), not function tool simulation

### Task 7 — Documentation + examples
Document:
- tool shapes supported (Responses + migration fallback)
- output item shape (includes `id` + `call_id`)
- follow-up input expectations (echoed `function_call` accepted)
- SSE profiles:
  - `/v1/responses` (no call_id on FCA events)
  - future Realtime profile (includes call_id)

---

## Telemetry / observability (recommended)

Log per request:
- tool registry (names only)
- parse failures
- strict validation failures
- number of tool calls detected
- whether the client echoed `function_call` items
- number of repaired argument strings (non-strict only)

---

## Appendix — Example: streaming tool call (proxy-emitted)

1) Client requests `/v1/responses` with tools.
2) Backend begins streaming normal text.
3) Backend emits `<tool_call>...</tool_call>`; proxy buffers.
4) Proxy emits:

- `response.output_item.added` (function_call item with `id`, `call_id`, `name`, `arguments:""`)
- `response.function_call_arguments.delta` (optional synthetic chunks)
- `response.function_call_arguments.done` (full `arguments` string)
- `response.output_item.done`
- ...later `response.completed`

---

## Appendix — Example: follow-up tool output

Client sends:
```json
{
  "model": "...",
  "input": [
    { "type":"function_call_output", "call_id":"fc_001", "output":"{...}" }
  ]
}
```

Proxy flattens into backend transcript:
- `[function_call_output call_id=fc_001 output={...}]`

Backend continues generation.
