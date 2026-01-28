# Subtask 04 — Streaming Notifications: v2 `response.*` events + tool-call streaming

## Objective

Ensure **codex-app-server-proxy** handles (or safely ignores) *all* v2 streaming notifications emitted by **Codex app-server**, with correct OpenAI-compatible streaming semantics for:

- normal assistant text streaming
- output item lifecycle events
- tool calls (function call items + arguments deltas/done)
- turn completion markers / stream termination

---

## Reasoning: assumptions + approach

Assumptions (based on the task template and existing proxy patterns):

- The proxy consumes **app-server “notifications”** that include a `type` discriminator (e.g. `response.output_item.added`).
- The proxy **emits Chat Completions–style SSE** to clients (e.g. VS Code extensions), including the terminal `[DONE]` marker.
- Tool calls are surfaced via an internal `ToolCallAggregator` that reconstructs a *single* tool call (or multiple tool calls) from `response.*` deltas.

Core approach:

- Treat **all v2 `response.*` notifications as first-class inputs** to the streaming pipeline.
- Centralize logic into a **normalization + routing layer**, keeping the main handler readable and preventing drift as new `response.*` events appear.
- Make tool-call streaming **idempotent, bounded, and testable** by replaying recorded notification streams and asserting emitted SSE frames.

---

## Line references to the original task template

The attached template was ~70 lines long. These are the key line ranges that were expanded/clarified in this revision:

- **L11–L23**: “Where to look” placeholder list → replaced with a structured, fill-in *file+line* checklist + a single ripgrep command.
- **L27–L42**: “Tasks” outline → expanded into a concrete event matrix + step-by-step operations.
- **L45–L57**: patch snippet → expanded into multiple copy/paste snippets (router + aggregator + SSE chunks).
- **L61–L66**: validation checklist → promoted into explicit **Acceptance criteria**.
- **L69–L70**: deliverable → expanded into **Deliverable** + recommended tests.

---

## Where to look (fill with exact file+line refs from this repo)

> This section is intentionally structured so you can paste in **exact file paths + line ranges** after running repository search.
> 
> Suggested command to generate references:
> - `rg -n "handleNotification|agentMessageDelta|item_completed|task_complete|ToolCallAggregator|ingestDelta|response\.output_item\.added|response\.function_call_arguments\.(delta|done)|response\.output_item\.done" -S .`

### Primary handler(s): notification routing & SSE emission

- **`<<FILL>>`** — `handleNotification(...)` switch / router: `<<path>>:L<<start>>-L<<end>>`
- **`<<FILL>>`** — SSE writer / chunk builder (ChatCompletions chunk schema): `<<path>>:L<<start>>-L<<end>>`
- **`<<FILL>>`** — “turn done” / `[DONE]` emission: `<<path>>:L<<start>>-L<<end>>`

### Tool call reconstruction

- **`<<FILL>>`** — `ToolCallAggregator` class definition: `<<path>>:L<<start>>-L<<end>>`
- **`<<FILL>>`** — `ToolCallAggregator.ingestDelta(...)`: `<<path>>:L<<start>>-L<<end>>`
- **`<<FILL>>`** — any state reset / cleanup paths: `<<path>>:L<<start>>-L<<end>>`

### Legacy / v1 notification support (for compatibility checks)

- **`<<FILL>>`** — legacy `agentMessageDelta` / `agent_message_delta`: `<<path>>:L<<start>>-L<<end>>`
- **`<<FILL>>`** — `item_completed` / `task_complete`: `<<path>>:L<<start>>-L<<end>>`

---

## Event handling matrix (v2 `response.*` family)

> Goal: every event is either **handled** or **explicitly ignored** with a safe default.

| Notification `type` | Expected payload (high-level) | Action in proxy | Output impact |
|---|---|---|---|
| `response.output_text.delta` (or equivalent) | incremental assistant text | forward as `delta.content` | SSE chunk(s) |
| `response.output_item.added` | output item created; for tool calls: `type=function_call` and identifiers | if tool-call item: create tool call in aggregator; else ignore or map | may start tool-call mode |
| `response.function_call_arguments.delta` | JSON-string fragment | append to tool call args buffer | emits `delta.tool_calls[].function.arguments` |
| `response.function_call_arguments.done` | done marker (optional final args) | finalize args string | stops args buffering |
| `response.output_item.done` | output item finished | finalize tool call (and/or mark finished) | emits finish chunk with `finish_reason: "tool_calls"` |
| `response.completed` / `response.done` (if present) | response finished | end stream | `[DONE]` |
| `response.failed` / `response.error` (if present) | error info | surface as error + end | error SSE + `[DONE]` |
| any other `response.*` | unknown / future | ignore + debug log once | none |

---

## Tasks (exact operations)

### 1) Inventory current notification handling

- Enumerate all `notif.type` values currently handled.
- Categorize them into:
  - **text streaming**
  - **tool-call streaming**
  - **lifecycle / completion**
  - **legacy / v1**
  - **unknown (default case)**

Deliverable: a short list of handled types + notes on what each emits downstream.

### 2) Add explicit routing for v2 tool-call notifications

**Plan of record (recommended):** route all tool-call-related v2 events through `ToolCallAggregator.ingestDelta(...)`.

Key points:

- Ensure `response.output_item.added` creates a tool call **only when** the added item is a function call output item.
- Ensure argument deltas are appended **in order**, and are **never truncated**.
- Ensure `.done` events produce a clean finalize, even if `.delta` never arrived (edge-case).

### 3) Confirm ToolCallAggregator completeness and bounds

The aggregator must correctly handle:

- creation of call state on `output_item.added` (function_call)
- accumulation of arguments on `function_call_arguments.delta`
- finalization on `function_call_arguments.done`
- completion on `output_item.done`
- **multiple tool calls per response** (if the app-server can emit them)
- bounded memory growth (cap arguments buffer; evict finished calls)

> If the existing aggregator only supports a single active tool call, extend to support multiple via `Map<call_id, ...>`.

### 4) Stream termination semantics (OpenAI parity)

When a tool call completes:

- emit a final chunk with `finish_reason: "tool_calls"`
- then emit `[DONE]`
- enforce “drop assistant text after tool call start”:
  - once the proxy sees the first tool-call `output_item.added`, **stop forwarding any subsequent text deltas** (if any appear)

### 5) Non-tool `response.*` notifications

For turn-level markers (e.g. `turn_started`, `turn_completed`, or response lifecycle markers):

- Prefer **explicit ignore + debug log** if they do not map cleanly to downstream SSE.
- Add mapping only if downstream clients depend on them.

---

## Suggested patch snippets (copy/paste patterns)

### A) Minimal routing: send tool-call v2 events into the aggregator

```ts
// inside handleNotification(...) or equivalent
switch (notif.type) {
  case "response.output_item.added":
  case "response.function_call_arguments.delta":
  case "response.function_call_arguments.done":
  case "response.output_item.done": {
    toolCallAggregator.ingestDelta(notif);
    break;
  }

  // ...existing cases for text deltas, completion, etc...

  default: {
    // Safe default: ignore unknown v2 notifications.
    // Prefer: log once per type to avoid spam.
    debugUnknownNotificationTypeOnce(notif.type);
    break;
  }
}
```

### B) ToolCallAggregator core shape (supports multiple calls)

```ts
type ToolCallState = {
  id: string;              // call_id (stable)
  name: string;            // function name
  index: number;           // tool_calls index in the downstream array
  args: string;            // accumulated JSON string
  argsDone: boolean;
  outputItemDone: boolean;
};

export class ToolCallAggregator {
  private callsById = new Map<string, ToolCallState>();
  private nextIndex = 0;

  ingestDelta(notif: { type: string; [k: string]: any }) {
    switch (notif.type) {
      case "response.output_item.added": {
        const item = notif.item ?? notif.output_item ?? notif.outputItem;
        if (item?.type !== "function_call") return;

        const callId = item.call_id ?? item.id;
        const name = item.name ?? item.function?.name;
        if (!callId || !name) return; // or throw if invariant

        if (!this.callsById.has(callId)) {
          this.callsById.set(callId, {
            id: callId,
            name,
            index: this.nextIndex++,
            args: "",
            argsDone: false,
            outputItemDone: false,
          });
          // Optionally notify downstream that tool call has started.
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const callId = notif.call_id ?? notif.item_id ?? notif.id;
        const delta = notif.delta ?? notif.arguments_delta ?? "";
        const st = callId ? this.callsById.get(callId) : undefined;
        if (!st || st.argsDone) return;

        // Hard cap to prevent unbounded growth.
        if (st.args.length + delta.length > 1_000_000) {
          throw new Error("tool call arguments exceeded 1MB cap");
        }

        st.args += delta;
        break;
      }

      case "response.function_call_arguments.done": {
        const callId = notif.call_id ?? notif.item_id ?? notif.id;
        const st = callId ? this.callsById.get(callId) : undefined;
        if (!st) return;
        st.argsDone = true;
        break;
      }

      case "response.output_item.done": {
        const item = notif.item ?? notif.output_item ?? notif.outputItem;
        const callId = item?.call_id ?? item?.id ?? notif.call_id;
        const st = callId ? this.callsById.get(callId) : undefined;
        if (!st) return;
        st.outputItemDone = true;
        break;
      }
    }
  }

  // Use this to produce downstream SSE tool_call deltas (and cleanup).
  drainCompletedCalls(): ToolCallState[] {
    const completed: ToolCallState[] = [];
    for (const [id, st] of this.callsById) {
      if (st.outputItemDone) {
        completed.push(st);
        this.callsById.delete(id);
      }
    }
    return completed.sort((a, b) => a.index - b.index);
  }
}
```

### C) Downstream SSE chunk: tool_call delta (Chat Completions streaming shape)

```ts
function makeToolCallDeltaChunk(call: { id: string; name: string; args: string; index: number }) {
  return {
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: call.index,
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.args,
              },
            },
          ],
        },
      },
    ],
  };
}
```

### D) Finish + DONE after tool call completion

```ts
// After you emit the final tool_calls delta chunk(s):
writeSse({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
writeDone(); // emits `data: [DONE]\n\n`
```

---

## Acceptance criteria

### Functional

- [ ] All observed v2 `response.*` notifications are either:
  - handled explicitly, or
  - ignored safely via default branch (no crash), with a debug log **once per type**.
- [ ] For a streaming tool call:
  - [ ] arguments are reconstructed correctly (no truncation / missing segments)
  - [ ] `call_id` and `function.name` remain stable across deltas
  - [ ] downstream SSE emits `delta.tool_calls` in correct order
- [ ] Mixed content + tool call:
  - [ ] assistant text streaming ends **exactly** when tool call begins (no text after tool call start)
- [ ] Stream termination:
  - [ ] after tool call completion, proxy emits `finish_reason: "tool_calls"` then `[DONE]`
  - [ ] non-tool responses still end with normal finish + `[DONE]`
- [ ] Resource safety:
  - [ ] tool-call argument buffering is bounded (cap and/or cleanup)
  - [ ] aggregator does not retain completed calls after completion

### Non-functional

- [ ] No unbounded memory growth in long-running sessions.
- [ ] Unknown event types do not spam logs (log once per type, or rate-limit).

---

## Suggested tests

### Unit tests (fast)

1. **ToolCallAggregator accumulates deltas**
   - given: `output_item.added(function_call)`, then N `arguments.delta`, then `arguments.done`
   - assert: final args == concatenation of deltas

2. **ToolCallAggregator handles output_item.done**
   - assert: `drainCompletedCalls()` returns the completed call(s) and removes them

3. **Multiple tool calls**
   - interleave deltas for call A and call B
   - assert: both calls preserved and emitted with stable indexes

4. **Bounds**
   - feed >1MB worth of args deltas
   - assert: throws (or emits an error path) and cleans up state

### Integration tests (replay streams)

Create a **fixture** that replays a recorded notification stream (JSONL):

- Input: list of notifications (v2) representing:
  1) assistant text only
  2) tool call only
  3) mixed text then tool call
  4) unknown `response.*` event types sprinkled in

Assertions:

- output SSE sequence matches a golden file:
  - correct `data:` frames
  - correct `delta.content` frames for text
  - correct `delta.tool_calls` frames for tool call
  - correct finish chunk and `[DONE]`

### Regression test (legacy support)

- Replay a v1/legacy stream (if supported) to ensure no breakage:
  - `agentMessageDelta` / `item_completed` / `task_complete` still function

---

## Deliverable

- Updated notification routing + tool-call handling for v2 events
- Added tests:
  - unit tests for `ToolCallAggregator`
  - an integration “replay harness” that asserts emitted SSE frames against golden output
