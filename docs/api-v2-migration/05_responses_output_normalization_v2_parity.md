# Subtask 05 - /v1/responses output normalization (V2) - codex-app-server-proxy to OpenAI parity

## Objective
Bring the proxy's egress for `/v1/responses` into parity with OpenAI Responses for:

- Non-stream JSON envelope shape (top-level fields + `output[]`)
- Typed SSE event shapes + ordering
- Tool call representation as `output[]` items (`type: "function_call"`) with string `arguments`

This plan uses repo paths + function/identifier anchors (no blob URLs, and no brittle line ranges).

## Out of scope
- Request normalization (`src/handlers/responses/native/request.js`)
- Upstream transport mechanics / JSON-RPC child adapter wiring (`src/services/transport/...`)
- Any `/v1/chat/completions` compatibility work

---

## Repo anchors (stable references Codex can navigate)

### Envelope builder (single source of truth)
File: `src/handlers/responses/native/envelope.js`

Jump-to symbols:
- `mapUsage`
- `normalizeFunctionArguments`
- `buildMessageOutputItem`
- `buildFunctionCallOutputItems`
- `buildResponsesEnvelope`

Fast local nav:
```bash
rg -n "export const buildResponsesEnvelope|mapUsage\s*\(|normalizeFunctionArguments|buildMessageOutputItem|buildFunctionCallOutputItems" src/handlers/responses/native/envelope.js
```

### Non-stream handler
File: `src/handlers/responses/nonstream.js`

Key anchors:
- `postResponsesNonStream`
- `buildResponsesEnvelope(` call site
- `parseToolCallText` / `<tool_call>` stripping path

Fast local nav:
```bash
rg -n "postResponsesNonStream|buildResponsesEnvelope\(|parseToolCallText|tool_call" src/handlers/responses/nonstream.js
```

### Stream adapter (typed SSE)
File: `src/handlers/responses/stream-adapter.js`

Key anchors:
- `createResponsesStreamAdapter`
- `ensureCreated`
- `writeEventInternal`
- `emitTextDelta` / `emitTextPart`
- `emitToolCallDeltas`
- `finalizeToolCalls`
- `finalize` (terminal ordering + `response.completed`)

Fast local nav:
```bash
rg -n "createResponsesStreamAdapter|ensureCreated|writeEventInternal|emitTextDelta|emitToolCallDeltas|finalizeToolCalls|const finalize" src/handlers/responses/stream-adapter.js
```

### Existing unit tests that already cover pieces of this
- `tests/unit/handlers/responses/native/envelope.spec.js`
- `tests/unit/handlers/responses/nonstream.spec.js`

---

## Verify the proposed updates (accuracy + what we adopt)

### 1) Remove brittle line references
Accurate requirement. We will rely on function anchors + `rg` commands. Line numbers drift and should not be authoritative.

### 2) Force `usage` to always exist (default zeros)
Accurate observation about current behavior: `mapUsage(...)` returns `undefined` when usage is absent/empty, which omits `usage` from the final payload.

Not adopted as the default parity target, because this is a behavioral contract change. Streaming usage is commonly gated by `stream_options.include_usage` and/or upstream emission of a `usage` event.

Plan decision:
- Default: keep usage omitted unless provided (recommended)
- Optional: add a strict-defaulting mode (documented below)

### 3) Wire `finish_reason` into the envelope
Accurate observation: `buildResponsesEnvelope(...)` does not accept or emit a finish reason today.

Plan decision (parity-oriented):
- Do not add `finish_reason` to the Responses envelope by default.
- If needed for debugging, add it as a proxy-only extension that strict clients can ignore (details below).

### 4) Verify streaming sequence: output_text.done then tool done events then response.completed
Accurate. We will lock this ordering with a unit test (so clients do not get surprised by reordering).

### 5) Lock output item typing; no mixed items
Accurate, and already the design intent in this repo. We will explicitly test:
- `buildMessageOutputItem` only emits `type: "message"` items
- `buildFunctionCallOutputItems` only emits `type: "function_call"` items

---

## Critical parity decision to lock before coding

### D1) SSE `output_index` semantics
Current risk pattern: the stream adapter uses `output_index` like a "choice index" (and `/v1/responses` enforces `n=1`), so tool events and text events can collide on index 0.

Recommended parity target: `output_index` should map to the index within final `response.output[]`.

Given the envelope builder emits:
- `output[0]` = message item
- `output[1..]` = function_call items

Then SSE should use:
- Text events: `output_index = 0`
- Tool events: `output_index = 1 + toolOrdinal`

This is the highest leverage change for strict SSE consumers.

### D2) Tool-call ID stability across SSE and final envelope
Recommended: keep `item.id` and `item.call_id` stable and consistent across:
- `response.output_item.added` / `response.output_item.done`
- `response.completed.response.output[]`

Pick a canonical: `call_id` is usually the canonical tool-call identifier. If upstream emits both, mirror into both fields unless you have a reason to split them.

### D3) Usage behavior policy
Lock one of these policies:

- Policy A (recommended / current-contract friendly):
  - Non-stream: include `usage` only if upstream provided it
  - Stream: include `usage` only if requested and upstream provided it

- Policy B (strict defaulting):
  - Always include `usage` with zeros when unknown

If you choose Policy B, update tests and document this as a proxy deviation.

---

## Tasks (exact operations)

### Task 1 - Verify and lock output item typing (no mixed items)
Goal: keep the envelope representation strict and unambiguous.
- assistant text lives in a `type: "message"` item only
- each tool call is a separate `type: "function_call"` item only

Where:
- `src/handlers/responses/native/envelope.js` (`buildMessageOutputItem`, `buildFunctionCallOutputItems`)

Add/confirm tests in:
- `tests/unit/handlers/responses/native/envelope.spec.js`

Assertions:
- `output[0].type === "message"`
- `output[0].content[0].type === "output_text"`
- every subsequent tool item is `type === "function_call"`
- tool item has `id`, `call_id`, `name`, and `arguments` (string)

### Task 2 - Normalize SSE `output_index` to map to `response.output[]`
Goal: make SSE `output_index` match final `response.output[]` indices.

Where:
- `src/handlers/responses/stream-adapter.js`

Implementation notes:
- Introduce:
  - `const MESSAGE_OUTPUT_INDEX = 0`
  - `const toolOutputIndex = (ordinal) => 1 + ordinal`

Update:
- `emitTextDelta(...)` and `emitTextPart(...)`: set `output_index: 0`
- `emitToolCallDeltas(...)`, `finalizeToolCalls(...)`, `emitToolCallComplete(...)`:
  - compute `outIdx = 1 + existing.ordinal`
  - use `outIdx` for all tool-related events

Patch sketch:
```js
const MESSAGE_OUTPUT_INDEX = 0;
const toolOutputIndex = (ordinal) => 1 + ordinal;

// text
writeEvent("response.output_text.delta", {
  type: "response.output_text.delta",
  delta: text,
  output_index: MESSAGE_OUTPUT_INDEX,
});

// tool
const outIdx = toolOutputIndex(existing.ordinal);
writeEvent("response.output_item.added", {
  type: "response.output_item.added",
  response_id: responseId,
  output_index: outIdx,
  item: {
    id: existing.id,
    call_id: existing.id,
    type: existing.type,
    name: existing.name,
    status: "in_progress",
  },
});
```

### Task 3 - Lock streaming terminal ordering
Goal: ensure end-of-stream ordering is deterministic:

1. `response.created`
2. zero+ `response.output_text.delta`
3. `response.output_text.done`
4. tool call done events
5. `response.completed` (contains final envelope)
6. `done: [DONE]`

Where:
- `src/handlers/responses/stream-adapter.js` (`finalize()`)

### Task 4 - Usage accounting behavior (explicit policy)
Pick Policy A or B (see D3), then implement + test.

Policy A (recommended):
- Keep `mapUsage(...)` returning `undefined` when nothing is known.
- Keep `payload.usage` omitted unless a valid usage object exists.
- Document: if usage was requested (stream) but no `usage` event arrived, usage may be omitted.

Policy B (optional strict defaulting):
- Change `mapUsage(...)` so missing/invalid usage returns `{ input_tokens: 0, output_tokens: 0, total_tokens: 0 }`.
- Always attach `payload.usage`.
- Update any tests that assert omission when usage is not provided.

### Task 5 - Finish reason handling (parity first; optional debug-only extension)
Default parity goal: do not emit `finish_reason` in the Responses envelope.

Optional debug-only extension (choose one):
- HTTP response header (example: `x-proxy-finish-reason: stop|tool_calls|...`)
- logging only (preferred if you want zero client impact)
- opt-in namespaced field, e.g. `_proxy.finish_reason` (ONLY in a debug output mode)

If you implement `_proxy.finish_reason`:
- do not put it under `usage`
- do not put it inside `output[]`
- keep it namespaced and opt-in to avoid breaking strict clients

### Task 6 - Tool-call arguments normalization (avoid double encoding)
Goal: `function_call.arguments` is always a string and never double-encoded.

Where:
- `src/handlers/responses/native/envelope.js` (`normalizeFunctionArguments`)
- the non-stream text-parser path in `src/handlers/responses/nonstream.js`

Rules:
- if args are already a string, pass through unchanged
- if args are object/number/bool/null, stringify once
- if args are undefined, lock either `""` (current) or `"{}"` (stricter), and test it

---

## Acceptance criteria

### A) Non-stream JSON envelope
Response JSON includes:
- `object: "response"`
- `id` (stable string)
- `created` (unix seconds integer)
- `status` in `{ completed, incomplete, failed }`
- `model` (string)
- `output` (array)
  - `output[0].type === "message"`
  - `output[0].content[0].type === "output_text"`
  - tool calls are separate items with `type === "function_call"`
  - tool items have `id`, `call_id`, `name`, `arguments` (string)

Usage:
- Policy A: `usage` present only when upstream provided it
- Policy B: `usage` always present, zeros when unknown

### B) Streaming typed SSE
Ordering:
1. `response.created`
2. optional `response.output_text.delta`
3. `response.output_text.done`
4. tool call item events
5. `response.completed`
6. terminal `done: [DONE]`

Indexing (after Task 2):
- text events use `output_index === 0`
- tool events use `output_index === 1 + ordinal`

Stability:
- `sequence_number` is monotonic per event (already implemented in SSE writer)

---

## Suggested tests (additions)

### 1) Extend envelope unit tests
File: `tests/unit/handlers/responses/native/envelope.spec.js`

Add cases:
- `mapUsage` maps `{ prompt_tokens, completion_tokens, total_tokens }` to `{ input_tokens, output_tokens, total_tokens }`
- `normalizeFunctionArguments`:
  - string passthrough
  - object stringify
  - undefined behavior locked ("" or "{}")

### 2) Add stream-adapter unit test (new)
Create: `tests/unit/handlers/responses/stream-adapter.spec.js`

Test goals:
- capture emitted SSE events (mock `writeSseChunk`)
- feed:
  - text delta events
  - tool_calls_delta events with growing argument strings
  - finish, then `finalize()`

Assertions:
- ordering:
  - `response.output_text.done` occurs before `response.output_item.done`
  - `response.completed` occurs after all `.done` events
  - `[DONE]` is last
- indexing:
  - text events use output_index 0
  - tool events use output_index 1..N (by ordinal)

### 3) Non-stream regression tests
File: `tests/unit/handlers/responses/nonstream.spec.js`

Add/strengthen:
- tool-only output still includes message item at `output[0]`
- `<tool_call>` stripping does not double-encode arguments

---

## Codex hand-off checklist
- Implement Task 2 first (SSE output_index semantics) and lock with a new unit test.
- Keep Task 4 (usage) and Task 5 (finish_reason) as explicit policy decisions, not accidental changes.
- Use the `rg` commands in this doc to jump to exact code sites quickly.

