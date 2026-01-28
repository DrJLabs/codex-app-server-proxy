# API V2 Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fully adopt Codex app-server API v2 in the proxy while preserving OpenAI-compatible output and streaming behavior.

**Architecture:** Extend the JSON-RPC transport and handlers to explicitly negotiate v2, preserve streaming/tool-call semantics end-to-end, normalize responses to OpenAI parity, and centralize error mapping with exactly-once completion.

**Tech Stack:** Node.js 22, Express, JSON-RPC transport, Jest/Vitest unit tests, integration tests, Playwright e2e.

## Pre-flight (do before Task 1)
- Create a new branch: `git checkout -b feat/api-v2-migration`
- Note: repo instructions say do not use git worktrees for routine work; stay on the new branch.

---

### Task 1: V2 initialize handshake in transport

**Files:**
- Modify: `src/services/transport/index.js` (initialize params)
- (Optional) Modify: `src/services/transport/index.js` (v1 fallback)
- Test: `tests/unit/json-rpc-schema.test.ts` (if needed)
- Test (optional): `tests/integration/json-rpc-schema-validation.int.test.js`

**Step 1: Write the failing test**
Add/extend a unit or integration test to assert the runtime initialize payload includes v2 fields.

Example (integration-style if you wire capture):
```js
it("sends v2 initialize params", async () => {
  // arrange: start fake-codex with capture, run transport handshake
  // assert: captured initialize params include protocolVersion === "v2" and capabilities {}
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/json-rpc-schema.test.ts`
Expected: FAIL (no v2 params present in handshake capture or helper assertions).

**Step 3: Write minimal implementation**
Update initialize params in `ensureHandshake()`:
```js
const initParams = buildInitializeParams({
  clientInfo: DEFAULT_CLIENT_INFO,
  protocolVersion: "v2",
  capabilities: {},
});
```
(Optional fallback) If needed, add retry when JSON-RPC returns invalid params:
```js
if (isCompatInitError(err)) {
  return await tryInitialize(buildInitializeParams({ clientInfo: DEFAULT_CLIENT_INFO }));
}
```

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/json-rpc-schema.test.ts`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/transport/index.js tests/unit/json-rpc-schema.test.ts
git commit -m "feat: send v2 initialize handshake params"
```

---

### Task 2: newConversation params passthrough

**Files:**
- Modify: `src/services/transport/index.js` (conversationParams mapping)
- Modify: `tests/unit/json-rpc-schema.test.ts`

**Step 1: Write the failing tests**
Add tests for config + compactPrompt + sandbox edge cases:
```ts
it("passes through config", () => {
  const config = { featureFlags: { experimental: true } };
  const params = buildNewConversationParams({ config });
  expect(params.config).toEqual(config);
});

it("passes through compactPrompt", () => {
  const params = buildNewConversationParams({ compactPrompt: "true" });
  expect(params.compactPrompt).toBe("true");
});

it("drops invalid sandbox types", () => {
  const params = buildNewConversationParams({ sandbox: true });
  expect(params.sandbox).toBeUndefined();
});

it("normalizes legacy sandbox policy", () => {
  const params = buildNewConversationParams({ sandbox: { type: "read-only" } });
  expect(params.sandbox).toBe("read-only");
});
```

**Step 2: Run tests to verify they fail**
Run: `npm run test:unit -- tests/unit/json-rpc-schema.test.ts`
Expected: FAIL (missing passthrough, sandbox behavior not asserted).

**Step 3: Write minimal implementation**
Update conversation params in `JsonRpcTransport.#ensureConversation()`:
```js
const conversationParams = buildNewConversationParams({
  // existing fields ...
  config: basePayload.config ?? undefined,
  compactPrompt: basePayload.compactPrompt ?? basePayload.compact_prompt ?? undefined,
});
```

**Step 4: Run tests to verify they pass**
Run: `npm run test:unit -- tests/unit/json-rpc-schema.test.ts`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/transport/index.js tests/unit/json-rpc-schema.test.ts
git commit -m "feat: forward newConversation config and compactPrompt"
```

---

### Task 3: Request path streaming + tool injection robustness

**Files:**
- Modify: `src/handlers/chat/request.js` (explicit message.stream)
- Modify: `src/services/transport/child-adapter.js` (tools forwarding)
- Modify: `src/handlers/responses/stream.js` (submission shape)
- Tests:
  - `tests/unit/handlers/chat/request.spec.js` (new or extend)
  - `tests/unit/services/json-rpc-child-adapter.spec.js`
  - `tests/unit/handlers/responses/stream.spec.js`

**Step 1: Write the failing tests**
1) Chat normalizer sets `message.stream`:
```js
it("sets message.stream when stream true", () => {
  const result = normalizeChatJsonRpcRequest({ stream: true, messages: [{ role: "user", content: "hi" }] });
  expect(result.message.stream).toBe(true);
});
```

2) Child adapter forwards tools:
```js
it("forwards tools from normalizedRequest", async () => {
  const tools = { definitions: [{ type: "function", function: { name: "t" } }], choice: "auto" };
  // setup adapter with normalizedRequest.turn.tools and message.tools
  // assert sendUserMessage called with tools
});
```

3) Responses stream uses `{ prompt }` submission:
```js
it("writes prompt-only submission", () => {
  // mock child adapter and assert stdin.write includes "prompt" and no "op"
});
```

**Step 2: Run tests to verify they fail**
Run:
- `npm run test:unit -- tests/unit/handlers/chat/request.spec.js`
- `npm run test:unit -- tests/unit/services/json-rpc-child-adapter.spec.js`
- `npm run test:unit -- tests/unit/handlers/responses/stream.spec.js`
Expected: FAIL.

**Step 3: Write minimal implementation**
1) Set stream in message payload:
```js
if (stream) messagePayload.stream = true;
```

2) Forward tools in child adapter:
```js
if (!messagePayload.tools && turnPayload.tools) messagePayload.tools = turnPayload.tools;
```

3) Simplify responses stream submission:
```js
child.stdin.write(JSON.stringify({ prompt }) + "\n");
```

**Step 4: Run tests to verify they pass**
Run the same unit tests as Step 2.
Expected: PASS.

**Step 5: Commit**
```bash
git add src/handlers/chat/request.js src/services/transport/child-adapter.js src/handlers/responses/stream.js \
  tests/unit/handlers/chat/request.spec.js tests/unit/services/json-rpc-child-adapter.spec.js tests/unit/handlers/responses/stream.spec.js
git commit -m "feat: make streaming explicit and preserve tools"
```

---

### Task 4: v2 response.* notification handling (tool lifecycle)

**Files:**
- Modify: `src/services/transport/index.js` (handle v2 tool events)
- (Optional) Modify: `src/handlers/responses/stream-adapter.js` (accept raw response.* tool events)
- Tests:
  - `tests/unit/lib/tool-call-aggregator.spec.js` (add v2 ingestion)
  - `tests/unit/handlers/responses/stream-adapter.spec.js` (text delta not swallowed)

**Step 1: Write the failing tests**
1) ToolCallAggregator v2 ingestion:
```js
it("ingests v2 tool lifecycle events", () => {
  const agg = createToolCallAggregator();
  agg.ingestDelta({ type: "response.output_item.added", item: { type: "function_call", name: "t", call_id: "c" } });
  agg.ingestDelta({ type: "response.function_call_arguments.delta", delta: "{\"x\":" });
  agg.ingestDelta({ type: "response.function_call_arguments.done" });
  agg.ingestDelta({ type: "response.output_item.done" });
  const snapshot = agg.snapshot();
  expect(snapshot.calls[0].arguments).toBe("{\"x\":");
});
```

2) Adapter preserves response.output_text.delta:
```js
it("does not swallow response.output_text.delta", () => {
  // feed handleEvent with response.output_text.delta and assert SSE chunk output
});
```

**Step 2: Run tests to verify they fail**
Run:
- `npm run test:unit -- tests/unit/lib/tool-call-aggregator.spec.js`
- `npm run test:unit -- tests/unit/handlers/responses/stream-adapter.spec.js`
Expected: FAIL.

**Step 3: Write minimal implementation**
Transport add cases:
```js
case "response.output_item.added":
case "response.output_item.done":
case "response.function_call_arguments.delta":
case "response.function_call_arguments.done": {
  if (payload && typeof payload === "object" && !payload.type) payload.type = method;
  context.addDelta(payload);
  break;
}
```

If adapter accepts raw response.* tool events, restrict to tool lifecycle only, and explicitly pass text deltas:
```js
if (event.type === "response.output_text.delta") {
  emitTextDelta(...);
  return true;
}
```

**Step 4: Run tests to verify they pass**
Run the same unit tests as Step 2.
Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/transport/index.js src/handlers/responses/stream-adapter.js \
  tests/unit/lib/tool-call-aggregator.spec.js tests/unit/handlers/responses/stream-adapter.spec.js
git commit -m "feat: handle v2 response tool lifecycle events"
```

---

### Task 5: /v1/responses output normalization parity

**Files:**
- Modify: `src/handlers/responses/native/envelope.js` (arguments normalization, output typing)
- Modify: `src/handlers/responses/stream-adapter.js` (output_index semantics, ordering)
- Tests:
  - `tests/unit/handlers/responses/native/envelope.spec.js`
  - `tests/unit/handlers/responses/stream-adapter.spec.js`
  - `tests/unit/handlers/responses/nonstream.spec.js`

**Step 1: Write the failing tests**
1) Envelope output typing:
```js
expect(output[0].type).toBe("message");
expect(output[0].content[0].type).toBe("output_text");
expect(output.slice(1).every((item) => item.type === "function_call")).toBe(true);
```

2) Stream output_index semantics:
```js
expect(textEvent.output_index).toBe(0);
expect(toolEvent.output_index).toBe(1);
```

3) Arguments normalization:
```js
expect(normalizeFunctionArguments("{\"x\":1}")).toBe("{\"x\":1}");
expect(normalizeFunctionArguments({ x: 1 })).toBe("{\"x\":1}");
```

**Step 2: Run tests to verify they fail**
Run:
- `npm run test:unit -- tests/unit/handlers/responses/native/envelope.spec.js`
- `npm run test:unit -- tests/unit/handlers/responses/stream-adapter.spec.js`
Expected: FAIL.

**Step 3: Write minimal implementation**
1) Keep output item typing strict (message vs function_call).
2) Update stream adapter output_index mapping:
```js
const MESSAGE_OUTPUT_INDEX = 0;
const toolOutputIndex = (ordinal) => 1 + ordinal;
```
3) Ensure normalizeFunctionArguments returns a string once (no double-encoding).

**Step 4: Run tests to verify they pass**
Run the same tests as Step 2.
Expected: PASS.

**Step 5: Commit**
```bash
git add src/handlers/responses/native/envelope.js src/handlers/responses/stream-adapter.js \
  tests/unit/handlers/responses/native/envelope.spec.js tests/unit/handlers/responses/stream-adapter.spec.js \
  tests/unit/handlers/responses/nonstream.spec.js
git commit -m "feat: normalize responses output parity"
```

---

### Task 6: Error mapping + completion semantics (exactly-once termination)

**Files:**
- Modify: `src/lib/errors.js` (normalizeCodexError helper)
- Modify: `src/handlers/chat/stream-runtime.js` (termination guard)
- Modify: `src/handlers/chat/stream-transport.js` (v2 event forwarding)
- Modify: `src/services/transport/child-adapter.js` (preserve raw error payload)
- Tests:
  - `tests/unit/lib/errors.spec.js`
  - `tests/unit/handlers/chat/stream-runtime.spec.js`

**Step 1: Write the failing tests**
1) normalizeCodexError mappings:
```js
expect(normalizeCodexError({ codexErrorInfo: "Unauthorized", message: "Authentication required" }).httpStatus).toBe(401);
expect(normalizeCodexError({ codexErrorInfo: "UsageLimitExceeded" }).httpStatus).toBe(429);
```

2) Stream runtime terminates once:
```js
const runtime = createStreamRuntime(...);
runtime.handleError(...);
runtime.handleResult(...);
// assert only one terminal emission
```

**Step 2: Run tests to verify they fail**
Run:
- `npm run test:unit -- tests/unit/lib/errors.spec.js`
- `npm run test:unit -- tests/unit/handlers/chat/stream-runtime.spec.js`
Expected: FAIL.

**Step 3: Write minimal implementation**
1) Implement normalizeCodexError with mapping table in `src/lib/errors.js`.
2) Add termination guard in stream runtime (first terminal wins).
3) Forward `turn/completed` and `error` events in stream-transport.
4) Preserve raw error payload from child-adapter on auth-required path.

**Step 4: Run tests to verify they pass**
Run the same tests as Step 2.
Expected: PASS.

**Step 5: Commit**
```bash
git add src/lib/errors.js src/handlers/chat/stream-runtime.js src/handlers/chat/stream-transport.js \
  src/services/transport/child-adapter.js tests/unit/lib/errors.spec.js \
  tests/unit/handlers/chat/stream-runtime.spec.js
git commit -m "feat: normalize codex errors and enforce single termination"
```

---

### Task 7: Full verification

**Step 1: Run full verification**
Run: `npm run verify:all`
Expected: PASS.

**Step 2: Optional targeted re-runs**
If failures occur, re-run the failing suite with verbose flags.

**Step 3: Commit any fixes**
Only if needed.
