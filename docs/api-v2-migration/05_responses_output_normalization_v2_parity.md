# Subtask 05 — `/v1/responses` Output Normalization: V2 → OpenAI parity

## Reasoning:
- **Assumptions**
  - `codex-app-server-proxy` currently responds on **`POST /v1/responses`** but its *outbound* JSON/SSE deviates from OpenAI’s Responses API in at least one of:
    - extra wrapper/envelope (e.g. `{ response: {...} }`)
    - missing/renamed top-level fields (common bug: `created` vs `created_at`)
    - `output[]` flattened to only text/message content (dropping tool calls)
    - streaming SSE event names/order don’t match the Responses API event contract
  - This task is about **output parity** (what clients receive) rather than “model quality” or upstream routing.

- **Logic**
  - Codex and other Responses clients treat `output[]` as the canonical “what happened” log. It must include **tool invocations as first-class items** (e.g. `type:"function_call"`) so clients can append tool calls + tool outputs into future `input` arrays (agent loop). See OpenAI’s description of how Codex consumes `response.*` SSE events and appends `reasoning` + `function_call` output items into the next request payload. (Spec refs below.)

---

## Recommended approach (best): One normalizer for both non-streaming + streaming

Implement a single, shared normalization layer:

- **Non-streaming**: normalize the final JSON `Response` object **once** right before returning.
- **Streaming**: normalize SSE events via a streaming transform **and** assemble a final `response.completed` payload that matches the non-streaming normalizer.

This prevents drift where the “final JSON” path and the “SSE path” diverge.

### Alternative approaches (when you want less surface area)
- **Alt A — “Pass-through”**: if upstream is already OpenAI Responses, forward bytes untouched and only inject headers/auth. Lowest risk, but no ability to correct upstream quirks.
- **Alt B — “Minimal patch”**: remove wrapper + stop stripping tool calls, without full spec alignment. Faster, but tends to regress later when new item types appear.
- **Alt C — “Translate from Chat Completions”**: if upstream is Chat Completions, build a full Responses shim (bigger effort; only do if required by architecture).

---

## Spec anchors (authoritative) — use these as the parity contract

> These line references are from the OpenAI docs snapshots captured during this analysis (Jan 2026).

### Response object fields
- **Top-level Response fields** like `id`, `object:"response"`, `created_at`, `status`, `model`, `output`, `usage`, etc.  
  Spec: OpenAI *Responses API Reference → “The response object”* (lines **1808–1974** in docs snapshot).

### Streaming event names + shapes
- **`response.output_item.added`** example + required fields `output_index`, `item`, `sequence_number` (lines **829–883**).  
- **`response.output_item.done`** example (lines **886–952**).  
- **`response.content_part.added/done`** examples (lines **956–1090**).  
- **`response.output_text.delta/done`** examples (lines **1093–1223**).  
- **`response.function_call_arguments.delta/done`** examples (lines **1346–1451**).  
  Spec: OpenAI *Responses API Reference → “Streaming events”*.

### Why tool calls must be output items (Codex agent loop behavior)
- Codex consumes SSE events such as `response.output_item.added`, `response.output_text.delta`, and uses output items (incl. `type=function_call`) as prefix input for the next request.  
  Spec: OpenAI blog *“Unrolling the Codex agent loop”* (lines **475–620** in docs snapshot).

---

## Where to look in `codex-app-server-proxy` (fill in exact file:line refs)

> I don’t have direct filesystem access to your `codex-app-server-proxy` repository in this environment, so I can’t pre-fill exact repo line numbers. Below is the exact *search plan* that will produce those file+line refs quickly; once you run it, replace the placeholders with the results.

### High-signal search commands
Run these from repo root:

```bash
rg -n "POST\s+/v1/responses|/v1/responses" .
rg -n "response\.completed|response\.output_item|output_item\.done|output_text\.delta" .
rg -n "buildResponsesEnvelope|ResponsesEnvelope|normalize.*response|output\s*:" .
rg -n "function_call|function_call_arguments|tool_calls|finish_reason" .
```

### Expected hotspots to annotate with file+line refs
- `POST /v1/responses` route handler (request parsing, upstream forwarding, response writing)
- any “envelope builder” (e.g., `buildResponsesEnvelope(...)`)
- streaming/SSE transform (anything that writes `data: {...}\n\n`)
- any code that:
  - rewrites `output`
  - flattens `message.content`
  - drops unknown output item types

---

## Tasks (exact operations)

### 1) Normalize the top-level `Response` object (non-streaming)
**Goal:** return a JSON object that matches the Responses API “Response object” contract.

**Do**
- Return a **`Response` object directly** (no wrapper such as `{ response: ... }`).
- Ensure fields align to Responses naming:
  - ✅ `created_at` (not `created`)
  - ✅ `completed_at` when `status:"completed"` (can be `null` otherwise)
  - ✅ `object:"response"`
  - ✅ `output: []` is always present (even if empty)
  - ✅ `error` + `incomplete_details` preserved if present
- Preserve unknown/new fields from upstream whenever possible (forward-compat).

**Avoid**
- Adding **SDK-only** convenience fields like `output_text` (the JS/Python SDK computes that locally).

#### Patch pattern (TypeScript)
```ts
type ResponseV2 = {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
  model: string;
  output: Array<any>;
  usage: null | {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    // plus optional breakdowns if you have them
  };
  // keep-through fields:
  error?: any;
  incomplete_details?: any;
  completed_at?: number | null;
  metadata?: Record<string, string>;
  // ...and any other upstream fields you’re already forwarding
};

import { randomUUID } from "crypto";

export function normalizeResponseObject(upstream: any): ResponseV2 {
  const created_at =
    typeof upstream.created_at === "number" ? upstream.created_at :
    typeof upstream.created === "number" ? upstream.created : // legacy field you may have
    Math.floor(Date.now() / 1000);

  // Preserve upstream id if present; otherwise generate stable-ish id.
  const id = typeof upstream.id === "string" ? upstream.id : `resp_proxy_${randomUUID()}`;

  return {
    ...upstream, // start with upstream to keep unknown fields
    id,
    object: "response",
    created_at,
    status: upstream.status ?? "completed",
    model: upstream.model ?? "unknown",
    output: Array.isArray(upstream.output) ? upstream.output : [],
    usage: upstream.usage ?? null,
  };
}
```

### 2) Ensure `output[]` includes tool calls as `type:"function_call"`
**Goal:** if the model/tooling path results in tool invocation requests, they must show up in `output[]` as discrete output items.

#### What “good” looks like (input continuation)
Codex expects to be able to append something like:

```json
{
  "type": "function_call",
  "name": "shell",
  "arguments": "{\"command\":\"cat README.md\"}",
  "call_id": "call_8675309..."
}
```

…and then later:

```json
{
  "type": "function_call_output",
  "call_id": "call_8675309...",
  "output": "..."
}
```

#### Patch pattern: normalize function-call item
```ts
type UpstreamToolCall = {
  id?: string;          // chat.completions tool_calls[].id OR similar
  call_id?: string;     // responses call id
  name: string;
  arguments: string | object;
};

function stableJSONStringify(value: unknown): string {
  // Minimal “stable” stringify to avoid key-order diffs in fixtures.
  // Replace with a library if you already use one.
  const normalize = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  };
  return JSON.stringify(normalize(value));
}

import { randomUUID } from "crypto";

export function asFunctionCallItem(call: UpstreamToolCall) {
  const call_id = call.call_id ?? call.id ?? `call_${randomUUID()}`;

  const args =
    typeof call.arguments === "string"
      ? call.arguments
      : stableJSONStringify(call.arguments);

  return {
    type: "function_call",
    call_id,
    name: call.name,
    arguments: args, // must be a JSON string (avoid double-encoding)
  };
}
```

#### Guardrails (avoid common bugs)
- **Don’t double-encode**:
  - Bad: `"\"{\\\"a\\\":1}\""`
  - Good: `"{\"a\":1}"`
- If upstream already gives a string, do **not** `JSON.stringify` it again.

### 3) Streaming SSE parity (Responses-style SSE)
**Goal:** the SSE event stream uses Responses event names and payload shapes.

Minimum event set to support Codex UI:
- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added` (optional but recommended)
- `response.output_text.delta`
- `response.output_text.done`
- `response.output_item.done`
- `response.completed`

#### SSE writer helper
```ts
function writeSSE(res: import("http").ServerResponse, evt: any) {
  res.write(`data: ${JSON.stringify(evt)}\n\n`);
}

let seq = 0;
const nextSeq = () => ++seq;
```

#### State machine sketch (stream normalizer)
```ts
type OutputItem = any;

class ResponseStreamState {
  response: any;
  output: OutputItem[] = [];
  byItemId = new Map<string, OutputItem>();

  constructor(initResponse: any) {
    this.response = initResponse;
  }

  addOutputItem(output_index: number, item: OutputItem) {
    this.output[output_index] = item;
    if (item?.id) this.byItemId.set(item.id, item);
  }

  appendTextDelta(item_id: string, content_index: number, delta: string) {
    const item = this.byItemId.get(item_id);
    if (!item) return;
    const part = item.content?.[content_index];
    if (part?.type === "output_text") part.text = (part.text ?? "") + delta;
  }

  appendFunctionArgsDelta(item_id: string, delta: string) {
    const item = this.byItemId.get(item_id);
    if (!item) return;
    if (item.type === "function_call") item.arguments = (item.arguments ?? "") + delta;
  }

  finalizeResponse() {
    return normalizeResponseObject({
      ...this.response,
      output: this.output.filter(Boolean),
      status: "completed",
      completed_at: Math.floor(Date.now() / 1000),
    });
  }
}
```

**Implementation notes**
- If upstream already emits Responses SSE events, prefer **pass-through + minimal fixups** rather than re-synthesizing.
- If upstream emits something else (e.g., Chat Completions deltas), translate into the above event set and update state as you stream.

### 4) Remove Chat-Completions-only concerns
The current task doc mentions `finish_reason`. That’s **Chat Completions** vocabulary; the Responses API contract relies on:
- `response.status`
- `response.incomplete_details` when incomplete
- output item completion via `response.output_item.done` (streaming)

So:
- **Delete/ignore** any “finish_reason parity” requirements unless you are also serving Chat Completions.

### 5) Usage normalization
If you can’t compute usage, `usage: null` is acceptable; but don’t return malformed partial objects.

If you *do* map usage from another upstream schema, ensure:
- `input_tokens`, `output_tokens`, `total_tokens` are integers
- keep any upstream “breakdown” fields if present

---

## Acceptance criteria

### Non-streaming
- [ ] `POST /v1/responses` returns a **top-level Response object** (`object:"response"`) with **`created_at`** and **`output`** fields present.
- [ ] No extra wrapper key (e.g., no `{ response: ... }`).
- [ ] When the model requests a tool, the response includes at least one output item with:
  - [ ] `type:"function_call"`
  - [ ] `name`
  - [ ] `arguments` as a JSON **string** (not object, not double-encoded)
  - [ ] `call_id`
- [ ] Unknown/new output item types are preserved (don’t drop them).

### Streaming
- [ ] Event `type` values match the Responses API naming (e.g. `response.output_item.added`, `response.output_text.delta`, `response.completed`).
- [ ] Every emitted event contains a monotonic `sequence_number` integer.
- [ ] For text streaming:
  - [ ] `response.output_item.added` emitted before `response.output_text.delta`
  - [ ] `response.output_text.done` emitted before `response.output_item.done`
- [ ] If function-call arguments stream, emit `response.function_call_arguments.delta/done` and assemble a final `function_call` output item containing full `arguments`.

---

## Suggested tests (add/extend as needed)

### 1) Golden contract tests (recommended)
**Goal:** compare proxy output to OpenAI Responses for the same request shape.

- Record fixtures from OpenAI:
  - `simple_text_response.json`
  - `tool_call_response.json`
  - `tool_call_stream.sse` (raw)
- Run the same prompts through your proxy with the same inputs; compare after stripping nondeterministic fields:
  - ids (`resp_*`, `msg_*`, `call_*`)
  - timestamps (`created_at`, `completed_at`)
  - usage (if upstream doesn’t provide)

**Assertion:** structural equality of:
- event `type` set + ordering constraints
- presence/shape of `output[]` items
- `arguments` string semantics (JSON parseable)

### 2) Unit tests for normalization helpers
- `normalizeResponseObject()`
  - maps `created` → `created_at`
  - guarantees `output` array
- `asFunctionCallItem()`
  - string arguments unchanged
  - object arguments stringify once
  - generated `call_id` is stable format

### 3) Streaming state machine tests
Feed a synthetic sequence:
- output_item.added(message)
- content_part.added(output_text)
- output_text.delta × N
- output_text.done
- output_item.done
- response.completed

Assert final assembled response:
- output[0].content[0].text equals concatenated delta

Also test tool-call streaming:
- output_item.added(function_call)
- function_call_arguments.delta × N
- function_call_arguments.done
- output_item.done
- response.completed

### 4) End-to-end smoke test (Codex client compatibility)
Run a Codex CLI or Codex SDK request through the proxy that triggers a tool call, and confirm:
- the client receives a `function_call` output item
- the client can append a `function_call_output` item and continue the loop without schema errors

---

## Deliverable
- Updated `/v1/responses` implementation with a shared normalizer for JSON + SSE output
- A contract/golden test suite proving parity for:
  - plain text completion
  - tool call (single + multi-call)
  - streaming (text + tool-call-arguments)
