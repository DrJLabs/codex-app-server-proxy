# 03 — Request Path: `sendUserTurn` vs `sendUserMessage` (v2 streaming refactor)

This plan is **Codex-hand-off ready**: it uses **repo-path references**, **function names**, and **ripgrep commands** instead of blob/line citations.

---

## Scope

Refactor the JSON-RPC request pipeline so that:

1. **Streaming is explicitly driven by `sendUserMessage(stream:true)`** (not implied).
2. **Non-stream endpoints remain correct** even if upstream prefers/only supports streaming.
3. Tool schemas are **declared at thread start** via `dynamicTools` (proxy does **not** execute tools), and per-request tool payloads are removed.
4. Conversation bootstrap/system prompts remain intact (no loss of `baseInstructions`).

---

## Verified codebase facts (anchor points)

### JSON-RPC transport lifecycle (core)
- File: `src/services/transport/index.js`
- Key functions:
  - `createChatRequest(...)` → ensures conversation + listener, then currently calls `#sendUserTurn(...)`.
  - `sendUserMessage(context, payload)` → builds `SendUserMessageParams`, sends RPC, and completion is gated by **result + final message**.
  - `#handleNotification(...)` routes:
    - `agentMessageDelta` / `agent_message_delta` / `agent_message_content_delta` → `context.addDelta(...)`
    - `agentMessage` / `agent_message` → `context.setFinalMessage(...)`, triggers completion check
    - `tokenCount` / `token_count` → `context.setUsage(...)`
    - `taskComplete` / `task_complete` → `context.setResult(...)`, triggers completion check

**Codex search:**
```bash
rg "createChatRequest\(|sendUserMessage\(|#handleNotification\(" src/services/transport/index.js
```

### JsonRpcChildAdapter submission format (handlers use this)
- File: `src/services/transport/child-adapter.js`
- Key behavior:
  - Adapter accepts a single `stdin.write(...)` payload and extracts prompt from either:
    - `submission.op.items[0].text`, **or**
    - `submission.prompt`
  - Then it calls:
    - `transport.createChatRequest({ turnParams })`
    - `transport.sendUserMessage(context, messagePayload)`

  - Adapter no longer needs to align per-request tool payloads; **dynamicTools** live on the turn payload and are only read by `newConversation`.

**Codex search (tools plumbing):**
```bash
rg "dynamicTools|newConversation" src/services/transport/index.js
```


**Codex search:**
```bash
rg "#extractPrompt\(|createChatRequest\(|sendUserMessage\(" src/services/transport/child-adapter.js
```

### Chat request normalization (where `stream` is currently asymmetric)
- File: `src/handlers/chat/request.js`
- Key behavior:
  - `normalizeChatJsonRpcRequest(...)` produces `{ turn, message }`
  - `turn.stream` is set from handler `stream` flag
  - **`message.stream` is NOT set today** → streaming is currently implicit for chat path

**Codex search:**
```bash
rg "normalizeChatJsonRpcRequest\(" -n src/handlers/chat/request.js
rg "turn\s*=\s*\{" -n src/handlers/chat/request.js
rg "messagePayload\s*=\s*\{" -n src/handlers/chat/request.js
```

### Responses native stream currently builds a “user_input” op manually
- File: `src/handlers/responses/stream.js`
- It creates `JsonRpcChildAdapter(...)` with a `normalizedRequest = { turn, message }`
- It then submits input via a manual op envelope:
  - `{ op: { type: "user_input", items: [...] } }`

**Important:** `JsonRpcChildAdapter` already supports the simpler `{ prompt: "..." }` envelope (see `#extractPrompt`), so we can eliminate the op-shape construction.

**Codex search:**
```bash
rg "user_input|child\.stdin\.write" src/handlers/responses/stream.js
```

---

## Problems to solve

### P0 — Streaming is not explicit for chat
Even when the external chat endpoint is `stream:true`, `sendUserMessage` can be invoked without `stream:true` because the chat normalizer does not carry it into the message payload.

### P0 — Nonstream should not assume upstream supports “nonstream mode”
If app-server increasingly expects streaming semantics (common for v2 event models), nonstream handlers must be able to **buffer** stream events and emit a single JSON response.

### P1 — Avoid inline “CLI submission op” construction in handlers
Handlers should not hand-build submission JSON envelopes if the adapter already supports a simpler/safer format.

### P1 — Per-request tool payloads are no longer valid in v2
`SendUserMessageParams` does **not** accept tool manifests. Tools must be declared once per thread via `dynamicTools` on `newConversation`.

### P0 — Dynamic tool manifests must be attached at thread start
Client-defined tools must reach `newConversation(dynamicTools)` and **must not** be forwarded on `sendUserTurn`/`sendUserMessage`.

---

## Strategy (optimized for this repo)

### Decision: Make `sendUserMessage(stream:true)` the canonical streaming trigger

We do **not** need to eliminate `sendUserTurn` immediately (it is currently used in `createChatRequest()`), but we must ensure:

- streaming handlers always set `message.stream = true`
- nonstream handlers can still succeed if upstream wants to stream
- long-term: allow skipping `sendUserTurn` via a feature flag once parity is validated

---

## Implementation Tasks

### Task 1 — Make chat streaming explicit: set `message.stream`
**File:** `src/handlers/chat/request.js`

**Change:** when `normalizeChatJsonRpcRequest(..., stream=true)` is called, set `messagePayload.stream = true`.

**Snippet (illustrative; place inside `normalizeChatJsonRpcRequest`)**
```js
// after messagePayload is created
if (stream) messagePayload.stream = true;
```

---

### Task 2 (Optional) — Nonstream robustness: allow stream-buffering fallback

#### 2A) Chat nonstream (`/v1/chat/completions` stream=false)
**File:** `src/handlers/chat/nonstream.js`

This handler already consumes structured events via `JsonRpcChildAdapter` and tool aggregators; do not regress to “wait for exit only”.

**Add an explicit plan requirement:**
- Introduce an opt-in flag:
  - `PROXY_FORCE_JSONRPC_STREAM_FOR_NONSTREAM=true` → force `normalizedRequest.message.stream = true` even for nonstream endpoints.
- When enabled, keep buffering deltas/tool calls and return JSON only after completion is observed.

This avoids changing semantics prematurely while giving a production escape hatch. Treat this as **optional** unless production traces show upstream only supports streaming.

#### 2B) Responses nonstream (`/v1/responses` non-stream JSON)
**File:** `src/handlers/responses/nonstream.js`

This path already uses `runNativeResponses(...)` + envelope builder. Ensure it tolerates always-streaming upstream by buffering events until completion.

---

### Task 2.5 — Thread-start dynamic tools (v2)

**Why this exists:** API v2 app-server accepts **tool manifests only at thread start** via `newConversation.dynamicTools`. Per-request tool payloads must be removed.

#### 2.5A) Map OpenAI tools → `dynamicTools` on the turn
**Files:**
- `src/handlers/chat/request.js`
- `src/handlers/responses/stream.js`
- `src/handlers/responses/nonstream.js`

**Requirement:** When tools are present on the incoming request, build `dynamicTools` (function tools only) and attach to the **turn** payload. Do **not** send per-request `tools` on turn/message.

**Codex search:**
```bash
rg "dynamicTools|buildDynamicTools|turn\.dynamicTools" src/handlers/{chat,responses} -g'*.js'
```

#### 2.5B) Forward `dynamicTools` to `newConversation`
**File:** `src/services/transport/index.js`

**Requirement:** Pass `dynamicTools` (and `dynamic_tools` alias) into `buildNewConversationParams(...)`. This is the only valid tool manifest entry point for v2.

#### 2.5C) Map dynamic tool call events to OpenAI tool deltas
**Files:**
- `src/handlers/chat/stream-event-router.js`
- `src/handlers/chat/nonstream.js`

**Requirement:** Translate `dynamic_tool_call_request` events into `tool_calls` deltas so OpenAI clients receive tool call events in the expected shape.


---

### Task 3 — Replace raw “user_input op” writes where unnecessary

#### 3A) Responses stream submission
**File:** `src/handlers/responses/stream.js`

Replace:
```js
const submission = {
  id: reqId,
  op: { type: "user_input", items: [{ type: "text", text: prompt }] },
};
child.stdin.write(JSON.stringify(submission) + "\n");
```

With:
```js
child.stdin.write(JSON.stringify({ prompt }) + "\n");
```

**Why:** The adapter’s `#extractPrompt` supports `submission.prompt` directly. This reduces coupling to “CLI-ish op envelope” shapes.

> Optional follow-up: add `child.submitPrompt(prompt)` on `JsonRpcChildAdapter` to eliminate raw writes entirely, but not required.

---

### Task 4 — Clarify `function_call_output` scope (input vs output)

**Correct scope in this repo:**
- `function_call_output` is an **input item type** you may need to send **to** app-server when a client returns tool results (for full `/v1/responses` parity).
- App-server tool calls are currently represented in **notifications** as `tool_calls` / `function_call` fields rather than a `function_call_output` content item.

Therefore:
- Keep (or add) `function_call_output` to the **InputItem union** in `src/lib/json-rpc/schema.ts` (input side).
- Do **not** assume the server “returns function_call_output items” unless a fixture proves it.
- If server output evolves, extend the **event mapping layer** (e.g., `native/execute.js`, `stream-adapter.js`), not only schema typing.

---

### Task 5 — Tool schema typing improvements (low-risk, optional)
**File:** `src/lib/json-rpc/schema.ts`

Introduce a minimal type alias to prevent accidental shape drift:

```ts
export type ToolsPayload = {
  definitions?: Array<unknown>;
  choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  parallelToolCalls?: boolean;
};
```

Then use `tools?: ToolsPayload` on both turn/message param builders.

---

### Task 6 — System prompt preservation (guardrail)

System prompts are currently converted into `baseInstructions` on the **turn payload**.

**Requirement:**
- Any future refactor that skips `sendUserTurn` must still pass `baseInstructions` into `newConversation` (because `sendUserMessage` does not carry it in v2).
- If you introduce `createChatRequestWithoutTurn(...)`, ensure conversation params still include `baseInstructions`.


## Acceptance Criteria

### A) Chat streaming parity
- `/v1/chat/completions` with `stream:true`:
  - continues to emit deltas and tool call deltas
  - stop-after-tools behavior unchanged
  - JSON-RPC `sendUserMessage` params include `stream:true`

### B) Nonstream robustness (Optional)
- `/v1/chat/completions` with `stream:false`:
  - returns one JSON response
  - works even if upstream prefers streaming (via buffering fallback flag)

- `/v1/responses` non-stream:
  - returns canonical envelope after buffering events
  - tool calls appear in canonical output items as expected by envelope builder

### C) Handler submission simplification
- `src/handlers/responses/stream.js` no longer constructs `{ op: { type:"user_input"... } }` envelopes.
- Adapter accepts `{ prompt }` and behavior matches existing stream behavior.


### D) Dynamic tool injection
- `/v1/responses` (stream + nonstream) with `tools` and `tool_choice`:
  - tools are preserved through normalization and forwarded into JSON-RPC `sendUserMessage` params (no silent drops)
  - `tool_choice` and `parallel_tool_calls` mapping preserved
  - proxy does **not** execute tools; it only forwards + surfaces tool-call events

---

## Tests to add / update

### 1) Unit — chat normalizer sets `message.stream`
**File:** add `tests/unit/handlers/chat/request.spec.js` (or extend existing normalizer coverage).

Test:
- call `normalizeChatJsonRpcRequest({ stream:true, ... })`
- assert `result.message.stream === true`

### 2) Unit — JsonRpcChildAdapter forwards tools payload
**File:** `tests/unit/services/json-rpc-child-adapter.spec.js`

Add coverage for tool forwarding:
- given `normalizedRequest.message.tools`, assert `transport.sendUserMessage` receives `tools`
- given only `normalizedRequest.turn.tools`, assert adapter copies tools onto the message payload

Illustrative test shape:
```js
it("forwards tools from normalizedRequest", async () => {
  const tools = {
    definitions: [{ type: "function", function: { name: "t" } }],
    choice: "auto",
  };
  const { adapter, context, resolvePromise } = await setupAdapter({
    normalizedRequest: { turn: { items: [], tools }, message: { items: [] } },
  });

  adapter.stdin.write(JSON.stringify({ prompt: "hello" }));
  await flushAsync();

  expect(transport.sendUserMessage).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ tools })
  );

  resolvePromise();
  await flushAsync();
});
```

### 3) Unit — responses stream uses `{ prompt }` submission
**File:** `tests/unit/handlers/responses/stream.spec.js` (extend)
- mock `createJsonRpcChildAdapter` and assert `.stdin.write(...)` receives JSON containing `"prompt"` and not `"op"`.

### 4) Unit — JSON-RPC schema builder already supports stream
**File:** `tests/unit/json-rpc-schema.test.ts`
- existing coverage builds `sendUserMessage` params with `stream:true`
- add assertions only if you change types (Task 5)

### 5) Integration / E2E
Run existing suites after changes:
```bash
npm run test:unit
npm run test:integration
npm test
```

Prioritize:
- `tests/integration/responses.contract.streaming.int.test.js`
- `tests/integration/responses.contract.nonstream.int.test.js`
- `tests/unit/services/json-rpc-transport.spec.js`
- `tests/unit/services/json-rpc-child-adapter.spec.js`

---

## Rollout plan

1. Land Task 1 (`message.stream`) + unit test.
2. Land Task 2.5 (thread-start dynamic tools + event mapping) + unit test.
3. Land Task 3 (responses stream submission simplification) + unit test.
4. Add optional nonstream fallback flag (Task 2) only if needed in production traces.
5. Consider skipping `sendUserTurn` under a feature flag as a separate, later PR.
