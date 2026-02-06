# Subtask 04 — Streaming Notifications: v2 `response.*` events + tool-call streaming

## Reasoning
Assumptions + logic:
- There are **two different “v2 event” contexts** in this repo:
  1) **Ingress (worker → proxy)**: JSON-RPC notifications handled by `src/services/transport/index.js`.
  2) **Egress (proxy → client)**: `/v1/responses` SSE output produced by `src/handlers/responses/stream-adapter.js`.
- The v2 `response.*` tool-call lifecycle is already supported by:
  - `src/lib/tool-call-aggregator.js` (parses v2 tool-call events), and
  - `src/handlers/responses/stream-adapter.js` (synthesizes v2 `response.*` egress events).
- The only **true correctness risk** is *dropping* v2 signals if they arrive as unexpected ingress shapes, or *swallowing* text deltas if we naively “route all `response.*`” through the tool-call aggregator.

---

## Verification of suggested updates

### Confirmed accurate
- **Aggregator supports v2 tool-call events**: `collectFragments(...)` explicitly handles:
  - `response.output_item.added` / `response.output_item.done` with `item.type === "function_call"` (`src/lib/tool-call-aggregator.js:L291–L305`).
  - `response.function_call_arguments.delta` (`L305–L314`).
  - `response.function_call_arguments.done` (`L314–L324`).
- **Responses stream adapter synthesizes v2 egress events**:
  - Tool-call egress emission is implemented in `emitToolCallDeltas(...)` (`src/handlers/responses/stream-adapter.js:L442–L492`) and `finalizeToolCalls(...)` (`L494–L653`).
  - The adapter ingests *normalized internal events* (`text_delta`, `tool_calls_delta`, etc.) in `handleEvent(...)` (`L833–L941`) and finalizes the stream in `finalize(...)` (`L943–L1019`).
- **Transport drops unknown notification methods**:
  - `JsonRpcTransport.#handleNotification(...)` normalizes the JSON-RPC method name and uses a switch with a `default: break` (`src/services/transport/index.js:L953–L1062`).

### Correctness nuance
- Calling Transport Patch B **“mandatory”** is accurate **only if** the worker emits v2 events as JSON-RPC notification methods (e.g. `codex/event/response.output_item.added`).
- If the worker never emits `response.*` as notification methods, adding Transport Patch B is not required for correctness, but it is still a safe forward-compatible hardening.

### Confirmed risk: “Patch A can swallow text deltas”
- If we add a blanket ingress rule like `if (event.type.startsWith("response.")) { ingestDelta(...); return true; }`, then `response.output_text.delta` would be consumed.
- The tool-call aggregator intentionally ignores non-tool events, so `ingestDelta(...)` would return `{ updated: false }`, and the adapter would drop the text.
- Therefore: **either** explicitly handle `response.output_text.delta` **or** restrict raw `response.*` ingress handling to tool-lifecycle event types only.

---

## Objective
Ensure the proxy handles (or safely ignores) **all relevant v2 tool-call lifecycle events** with correct semantics:
- Preserve text streaming
- Preserve tool-call reconstruction and ordering
- Clean, single termination (`response.completed` then `done: [DONE]`)

---

## Where to look (actual file+line refs)

### Ingress: JSON-RPC notification router
- `src/services/transport/index.js`
  - `JsonRpcTransport.#handleNotification(...)`: `L953–L1062`
  - Legacy handled methods include: `agent_message_delta`, `task_complete`, `item_completed`, etc. (`L970–L1058`)

### Tool-call assembly
- `src/lib/tool-call-aggregator.js`
  - v2 event parsing: `L291–L324`
  - Public API factory: `createToolCallAggregator(...)`: `L556–L731`

### Egress: `/v1/responses` SSE adapter
- `src/handlers/responses/stream-adapter.js`
  - `handleEvent(...)`: `L833–L941`
  - Tool-call egress: `emitToolCallDeltas(...)`: `L442–L492`
  - Tool-call finalize egress: `finalizeToolCalls(...)`: `L494–L653`
  - Stream finalize: `finalize(...)`: `L943–L1019`

---

## Decision gate (must be settled first)

### Do we ever receive v2 `response.*` as JSON-RPC notification *method names*?
If yes, Transport must not drop them.

How to prove quickly (no guesswork):
- Capture a real worker notification line (stdout JSON) and confirm `payload.method`.
- Look for `codex/event/response.` prefixes.

---

## Tasks (exact operations)

### 1) Inventory ingress notification methods
- Enumerate all observed `normalizeNotificationMethod(message.method)` values in `#handleNotification`.
- If any begin with `response.`:
  - classify as `text`, `tool_lifecycle`, or `other`.

### 2) Harden transport to preserve v2 tool-call lifecycle methods
Applies when ingress includes v2 methods (and is safe even if it does not).

### 3) (Optional) Accept raw `response.*` ingress in `/v1/responses` adapter
Only needed if upstream pipelines can feed raw v2 events into `createResponsesStreamAdapter.handleEvent`. This is **optional** unless you observe raw `response.*` events bypassing normalization.

If you do this, you **must**:
- Handle `response.output_text.delta` explicitly, OR
- Restrict raw `response.*` handling to tool-lifecycle events.

### 4) Add tests
- Unit tests for `createToolCallAggregator` v2 event ingestion.
- Integration tests to ensure transport preserves `response.*` methods.
- Integration tests to ensure adapter never drops `response.output_text.delta`.

---

## Patch patterns

### Patch B (Transport): Required *if* ingress includes v2 `response.*` methods
Location: `src/services/transport/index.js` inside `#handleNotification` switch (`L970–L1062`).

Goal: don’t drop v2 tool lifecycle methods.

```js
// src/services/transport/index.js
case "response.output_item.added":
case "response.output_item.done":
case "response.function_call_arguments.delta":
case "response.function_call_arguments.done": {
  // `payload` is derived from params.msg when present; ensure it carries `type`
  if (payload && typeof payload === "object" && !payload.type) {
    payload.type = method; // method is already normalized (e.g. "response.output_item.added")
  }
  context.addDelta(payload);
  break;
}
```

Notes:
- The aggregator’s v2 parsing relies on `node.type` (`src/lib/tool-call-aggregator.js:L291–L324`).
- Injecting `payload.type = method` is a robustness measure in case upstream uses method-name-only typing.

### Patch A (Adapter): Safe handling for raw `response.*` ingress
Location: `src/handlers/responses/stream-adapter.js` inside `handleEvent(...)` (`L833–L941`).

**Do NOT** blindly swallow all `response.*`.

Option A1 (recommended): only accept tool-lifecycle `response.*` ingress
```js
if (typeof event.type === "string") {
  const t = event.type;
  const isToolLifecycle =
    t === "response.output_item.added" ||
    t === "response.output_item.done" ||
    t === "response.function_call_arguments.delta" ||
    t === "response.function_call_arguments.done";

  if (isToolLifecycle) {
    const choiceState = ensureChoiceState(choiceIndex);
    const result = toolCallAggregator.ingestDelta(event, { choiceIndex });
    if (result?.updated) {
      ensureCreated();
      emitToolCallDeltas(choiceState, choiceIndex, result.deltas);
    }
    return true;
  }
}
```

Option A2: accept all `response.*`, but explicitly forward `response.output_text.delta`
```js
if (typeof event.type === "string" && event.type.startsWith("response.")) {
  const choiceState = ensureChoiceState(choiceIndex);

  if (event.type === "response.output_text.delta") {
    if (isNonEmptyString(event.delta)) {
      emitTextDelta(choiceState, choiceIndex, event.delta);
    }
    return true;
  }

  const result = toolCallAggregator.ingestDelta(event, { choiceIndex });
  if (result?.updated) {
    ensureCreated();
    emitToolCallDeltas(choiceState, choiceIndex, result.deltas);
  }
  return true;
}
```

---

## Acceptance criteria

### Functional
- No tool-lifecycle events are silently dropped when ingress emits `response.*` methods.
- Tool call lifecycle is complete:
  - `output_item.added` emitted once per call
  - `function_call_arguments.delta` emitted for growth
  - `function_call_arguments.done` emitted once
  - `output_item.done` emitted once
- Text output is never lost:
  - `response.output_text.delta` always forwards to client.

### Termination
- Exactly one completion sequence:
  - `response.completed` then `done: [DONE]`.

---

## Suggested tests

### Unit: ToolCallAggregator v2 ingestion
- Feed events:
  - `response.output_item.added` (with `item.type="function_call"`)
  - multiple `response.function_call_arguments.delta`
  - `response.function_call_arguments.done`
  - `response.output_item.done`
- Assert `snapshot()` returns the full `function.arguments`.

### Integration: Transport preserves v2 methods
- Simulate a JSON-RPC notification with:
  - `message.method = "codex/event/response.function_call_arguments.delta"`
  - `params.msg = { delta: "{\"x\":" }` (no `type`)
- Assert stored delta has `type === "response.function_call_arguments.delta"`.

### Integration: Adapter does not swallow text deltas
- Feed `handleEvent({ type: "response.output_text.delta", delta: "hi" })`.
- Assert SSE output includes `response.output_text.delta` with that text.

---

## Deliverable
- Implement the required hardening patches (Transport, and Adapter if you accept raw `response.*` ingress).
- Add tests above (at least one per surface).
- Update this document’s “Decision gate” section with evidence from a captured worker notification.
