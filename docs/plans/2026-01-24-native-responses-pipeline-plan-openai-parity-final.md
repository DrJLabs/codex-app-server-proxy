# Native `/v1/responses` Pipeline — OpenAI Parity Implementation Plan

**Goal:** Replace the wrapper (Responses → Chat → Responses) with a native `/v1/responses` pipeline that matches OpenAI request/response semantics.

**Architecture:** A native request normalizer builds JSON-RPC turn/message payloads directly, a shared execution core ingests JSON-RPC events, and dedicated non-stream/stream handlers emit canonical OpenAI envelopes and typed SSE.

**Tech Stack:** Node.js 22, Express handlers, Codex JSON-RPC transport, SSE via `src/services/sse.js`, Vitest unit tests, integration tests, Playwright e2e.

## Goal
- Strict OpenAI `/v1/responses` parity (request schema, non-stream JSON, typed SSE streaming) with no chat-wrapper behavior.

## Assumptions / constraints
- Only `/v1/responses` parity is in scope (no `/v1/completions`).
- Stateless proxy: accept `previous_response_id` but never echo or persist it.
- Output mode for `/v1/responses` is header override or config default; no UA-based switching.
- Preserve response/message id aliasing behavior by reusing `normalizeResponseId`/`normalizeMessageId` (accept `chatcmpl-`/`msg_`/`resp_` inputs; always emit `resp_`/`msg_` prefixes).
- `input_image` maps to JSON-RPC `image` with `image_url` (no local file paths in OpenAI parity mode).

## Streaming contract (typed SSE)
Emit typed SSE events consistent with OpenAI Responses behavior:

- `response.created`
- `response.output_text.delta` / `response.output_text.done`
- tool events:
  - `response.output_item.added`
  - `response.function_call_arguments.delta` / `.done`
  - `response.output_item.done`
- `response.completed` (includes final `response` object that matches the non-stream envelope)
- On upstream/transport error after SSE starts: emit `response.failed` with an OpenAI-style error payload, then terminate with `event: done` + `data: [DONE]`. Do not emit `response.completed`.
- `event: done` + `data: [DONE]`

## Research (current state)
- Wrapper path (non-stream): `src/handlers/responses/nonstream.js` coerces `input` into chat messages and calls `postChatNonStream`.
- Wrapper path (stream): `src/handlers/responses/stream.js` calls `postChatStream` and uses `createResponsesStreamAdapter`.
- Wrapper helpers: `src/handlers/responses/shared.js` handles id normalization, output conversion, output mode resolution.
- Stream adapter (typed SSE mapping): `src/handlers/responses/stream-adapter.js` converts chat deltas → responses events.
- Title/summary intercept: `src/handlers/responses/title-summary-intercept.js` builds its own responses envelope.
- JSON-RPC schema limits `InputItem` to `text/image/localImage`: `src/lib/json-rpc/schema.ts`.
- Tool/format validation lives in chat request normalizer: `src/handlers/chat/request.js`.
- Stream parsing/router utilities exist: `src/handlers/chat/stream-event.js`, `src/handlers/chat/stream-event-router.js`.
- Contract tests and fixtures: `tests/integration/responses.contract.*`, `tests/e2e/responses-contract.spec.js`, `tests/shared/transcript-utils.js`, `test-results/responses/*`.

## Analysis
### Options
1) **Native Responses pipeline (recommended)** — new request normalizer, native execution core, canonical envelope + typed SSE. Most direct OpenAI parity, removes wrapper ambiguity.
2) Wrapper patch — keep chat handler and only re-map outputs. Lowest effort, but can never fully match OpenAI request semantics (messages vs input, tool outputs, ordering).
3) Hybrid — native non-stream but wrapper stream (or vice versa). Partial parity and inconsistent behavior between modes.

### Decision
- **Chosen:** Option 1. It is the most straightforward path to strict OpenAI Responses behavior and reduces long-term maintenance.

### Risks / edge cases
- JSON-RPC schema mismatch (missing `function_call_output`, `input_image`).
- Tool call arguments must remain string concatenations in outputs.
- Stream event ordering must match OpenAI typed SSE.
- Usage token counts may appear in multiple events; ensure deterministic final usage.

### Open questions
- None. Proceed with message pass-through; if JSON-RPC rejects `message` items, fall back to role-prefixed flattening in the normalizer.

## Q&A (answer before implementation)
- None.

## Implementation plan

### Task 0: Branch + baseline
**Files:**
- None

**Step 1: Create branch**
```bash
git checkout -b feat/native-responses-openai-parity
```

**Step 2: Run baseline unit tests**
```bash
npm run test:unit
```
Expected: PASS

**Step 3: Commit**
- No commit (no code changes yet).

**Acceptance**
- Branch exists and baseline unit tests are green.

---

### Task 1: Lock output-mode rules to OpenAI parity
**Files:**
- Modify: `src/handlers/responses/shared.js`
- Modify: `src/handlers/responses/nonstream.js`
- Modify: `src/handlers/responses/stream.js`
- Modify: `src/handlers/responses/title-summary-intercept.js`
- Test: `tests/unit/responses-output-mode.copilot.spec.js`

**Step 1: Write the failing test**
```js
it("never flips output mode without explicit header", () => {
  const req = { headers: { "user-agent": "obsidian/1.9.7" } };
  const result = resolveResponsesOutputMode({ req, defaultValue: "openai-json" });
  expect(result).toEqual({ effective: "openai-json", source: "default" });
});
```

**Step 2: Run test to verify it fails**
```bash
npm run test:unit -- tests/unit/responses-output-mode.copilot.spec.js
```
Expected: FAIL (still forces `obsidian-xml`).

**Step 3: Write minimal implementation**
```js
export const resolveResponsesOutputMode = ({ req, defaultValue }) => {
  const explicit = req?.headers?.["x-proxy-output-mode"];
  if (explicit && String(explicit).trim()) {
    return { effective: String(explicit).trim(), source: "header" };
  }
  return { effective: defaultValue, source: "default" };
};
```
Update call sites to stop passing `copilotDefault` / `copilotDetection` for `/v1/responses`.

**Step 4: Run test to verify it passes**
```bash
npm run test:unit -- tests/unit/responses-output-mode.copilot.spec.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add src/handlers/responses/shared.js tests/unit/responses-output-mode.copilot.spec.js

git commit -m "fix: lock responses output mode to header or default"
```

**Acceptance**
- `/v1/responses` never flips to `obsidian-xml` unless `x-proxy-output-mode` is set.

---

### Task 2: Extract shared tool/format validators
**Files:**
- Create: `src/handlers/shared/request-validators.js`
- Modify: `src/handlers/chat/request.js`
- Modify: `src/handlers/responses/native/request.js`

**Step 1: Write the failing test (responses request)**
```js
it("rejects invalid tool_choice", () => {
  expect(() => normalizeResponsesRequest({ tool_choice: "bogus" })).toThrow();
});
```

**Step 2: Run test to verify it fails**
```bash
npm run test:unit -- tests/unit/handlers/responses/native/request.spec.js
```
Expected: FAIL (helpers not available).

**Step 3: Write minimal implementation**
```js
// src/handlers/shared/request-validators.js
export {
  normalizeResponseFormat,
  normalizeToolChoice,
  normalizeParallelToolCalls,
  validateTools,
} from "../chat/request.js";
```
Refactor `src/handlers/chat/request.js` to export these helpers (no behavioral change).

**Step 4: Run test to verify it passes**
```bash
npm run test:unit -- tests/unit/handlers/responses/native/request.spec.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add src/handlers/shared/request-validators.js src/handlers/chat/request.js

git commit -m "refactor: export shared request validators"
```

**Acceptance**
- Responses normalizer can reuse chat validation logic without duplication.

---

### Task 3: Expand JSON-RPC schema types for parity
**Files:**
- Modify: `src/lib/json-rpc/schema.ts`
- Test: `tests/unit/json-rpc-schema.helpers.spec.ts`

**Step 1: Write the failing test**
```ts
expect(() => normalizeInputItems([{ type: "function_call_output", data: { call_id: "c1", output: "ok" } }])).not.toThrow();
```

**Step 2: Run test to verify it fails**
```bash
npm run test:unit -- tests/unit/json-rpc-schema.helpers.spec.ts
```
Expected: FAIL (type not in union).

**Step 3: Write minimal implementation**
```ts
export type InputItem =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { image_url: string } }
  | { type: "localImage"; data: { path: string } }
  | { type: "function_call_output"; data: { call_id: string; output: string } }
  | { type: "message"; role: string; content: unknown };
```
Ensure `normalizeInputItems` passes `function_call_output` and `image` through unchanged.

**Step 4: Run test to verify it passes**
```bash
npm run test:unit -- tests/unit/json-rpc-schema.helpers.spec.ts
```
Expected: PASS

**Step 5: Commit**
```bash
git add src/lib/json-rpc/schema.ts tests/unit/json-rpc-schema.helpers.spec.ts

git commit -m "feat: extend json-rpc input items for responses"
```

**Acceptance**
- `function_call_output` and `input_image` map through JSON-RPC without drops.\n+- If protocol supports message items, `message` input is preserved; otherwise role-prefixed flattening is used.

---

### Task 4: Native Responses request normalizer
**Files:**
- Create: `src/handlers/responses/native/request.js`
- Test: `tests/unit/handlers/responses/native/request.spec.js`

**Step 1: Write the failing test**
```js
it("rejects top-level messages", () => {
  const body = { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] };
  const err = expectNormalizeError(() => normalizeResponsesRequest(body));
  expect(err.param).toBe("messages");
});
```

**Step 2: Run test to verify it fails**
```bash
npm run test:unit -- tests/unit/handlers/responses/native/request.spec.js
```
Expected: FAIL (normalizer not implemented).

**Step 3: Write minimal implementation**
```js
export const normalizeResponsesRequest = (body = {}) => {
  if (Array.isArray(body.messages)) {
    throw invalidRequestBody("messages", "messages is not supported for /v1/responses");
  }
  const inputItems = normalizeResponsesInput(body.input);
  const textFormat = body?.text?.format ? { ...body.text.format } : undefined;
  const { responseFormat, finalOutputJsonSchema } = normalizeResponseFormat(textFormat);
  const tools = validateTools(body.tools);
  const toolChoice = normalizeToolChoice(body.tool_choice, tools);
  const parallelToolCalls = normalizeParallelToolCalls(body.parallel_tool_calls);

  return {
    instructions: body.instructions ?? "",
    inputItems,
    responseFormat,
    finalOutputJsonSchema,
    tools,
    toolChoice,
    parallelToolCalls,
    maxOutputTokens: body.max_output_tokens,
  };
};

const normalizeResponsesInput = (input) => {
  if (input === undefined) return [];
  if (typeof input === "string") {
    return [{ type: "text", data: { text: input } }];
  }
  if (!Array.isArray(input)) {
    throw invalidRequestBody("input", "input must be a string or an array of items");
  }
  return input.map((item) => {
    if (item?.type === "input_text") {
      return { type: "text", data: { text: item.text ?? "" } };
    }
    if (item?.type === "input_image") {
      return { type: "image", data: { image_url: item.image_url ?? item.image_url?.url ?? "" } };
    }
    if (item?.type === "function_call_output") {
      return { type: "function_call_output", data: { call_id: item.call_id, output: item.output } };
    }
    if (item?.type === "message") {
      return { type: "message", role: item.role, content: item.content };
    }
    throw invalidRequestBody("input", "unsupported input item type");
  });
};
```
Use `buildSendUserTurnParams` / `buildSendUserMessageParams` from `src/lib/json-rpc/schema.ts` to construct JSON-RPC payloads without calling `normalizeChatJsonRpcRequest`.
If JSON-RPC does not accept `message` items, replace that branch with role-prefixed text flattening.

**Step 4: Run test to verify it passes**
```bash
npm run test:unit -- tests/unit/handlers/responses/native/request.spec.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add src/handlers/responses/native/request.js tests/unit/handlers/responses/native/request.spec.js

git commit -m "feat: add native responses request normalizer"
```

**Acceptance**
- `messages` rejected; `input`/`instructions` preserved and ordered; `function_call_output` passed through.

---

### Task 5: Canonical Responses envelope builder
**Files:**
- Create: `src/handlers/responses/native/envelope.js`
- Modify: `src/handlers/responses/shared.js` (export normalizeResponseId/normalizeMessageId)
- Test: `tests/unit/handlers/responses/native/envelope.spec.js`

**Step 1: Write the failing test**
```js
it("builds response object with object/created", () => {
  const envelope = buildResponsesEnvelope({
    responseId: "chatcmpl-123",
    created: 1700000000,
    model: "gpt-4.1",
    outputText: "hello",
    functionCalls: [],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    status: "completed",
  });
  expect(envelope.object).toBe("response");
  expect(envelope.created).toBe(1700000000);
  expect(envelope.id.startsWith("resp_")).toBe(true);
});
```

**Step 2: Run test to verify it fails**
```bash
npm run test:unit -- tests/unit/handlers/responses/native/envelope.spec.js
```
Expected: FAIL (builder missing).

**Step 3: Write minimal implementation**
```js
export const buildResponsesEnvelope = ({ responseId, created, model, outputText, functionCalls, usage, status }) => ({
  id: normalizeResponseId(responseId),
  object: "response",
  created,
  status,
  model,
  output: [
    buildMessageOutputItem({ messageId: normalizeMessageId(), role: "assistant", text: outputText }),
    ...buildFunctionCallOutputItems(functionCalls),
  ],
  usage: mapUsageToResponses(usage),
});
```
Ensure `function_call.arguments` stays a string and `previous_response_id` is never emitted.

**Step 4: Run test to verify it passes**
```bash
npm run test:unit -- tests/unit/handlers/responses/native/envelope.spec.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add src/handlers/responses/native/envelope.js src/handlers/responses/shared.js tests/unit/handlers/responses/native/envelope.spec.js

git commit -m "feat: add responses envelope builder"
```

**Acceptance**
- `object: "response"` and `created` are always present; ids normalized to `resp_`/`msg_`.

---

### Task 6: Native execution core (JSON-RPC ingestion)
**Files:**
- Create: `src/handlers/responses/native/execute.js`
- Test: `tests/unit/handlers/responses/native/execute.spec.js`

**Step 1: Write the failing test**
```js
it("emits text_delta and finish events", async () => {
  const events = await collectEvents(runNativeResponses(/* mocked adapter */));
  expect(events).toContainEqual({ type: "text_delta", delta: "hi" });
  expect(events.some((e) => e.type === "finish")).toBe(true);
});
```

**Step 2: Run test to verify it fails**
```bash
npm run test:unit -- tests/unit/handlers/responses/native/execute.spec.js
```
Expected: FAIL (executor missing).

**Step 3: Write minimal implementation**
```js
export const runNativeResponses = async ({ adapter, onEvent }) => {
  const router = createStreamEventRouter({
    parseStreamEventLine,
    handleParsedEvent: (evt) => onEvent(mapParsedEvent(evt)),
    finalizeStream: (info) => onEvent({ type: "finish", ...info }),
  });
  for await (const line of adapter.iterStdoutLines()) {
    const { stop } = router.handleLine(line);
    if (stop) break;
  }
};
```
Map JSON-RPC events into internal events (`text_delta`, `tool_args_delta`, `usage`, `finish`).

**Step 4: Run test to verify it passes**
```bash
npm run test:unit -- tests/unit/handlers/responses/native/execute.spec.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add src/handlers/responses/native/execute.js tests/unit/handlers/responses/native/execute.spec.js

git commit -m "feat: add native responses executor"
```

**Acceptance**
- Executor emits consistent internal events usable by stream and non-stream handlers.

---

### Task 7: Native non-stream handler
**Files:**
- Modify: `src/handlers/responses/nonstream.js`
- Test: `tests/integration/responses.contract.nonstream.int.test.js`

**Step 1: Write the failing integration assertions**
- Update expected payload to include `object` and `created` and `function_call` output items.

**Step 2: Run test to verify it fails**
```bash
npm run test:integration -- tests/integration/responses.contract.nonstream.int.test.js
```
Expected: FAIL (wrapper still in place).

**Step 3: Write minimal implementation**
- Replace chat delegation with:
  - `normalizeResponsesRequest`
  - `runNativeResponses` to collect text/tool calls/usage
  - `buildResponsesEnvelope`
  - `res.status(200).json(envelope)`

**Step 4: Run test to verify it passes**
```bash
npm run test:integration -- tests/integration/responses.contract.nonstream.int.test.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add src/handlers/responses/nonstream.js tests/integration/responses.contract.nonstream.int.test.js

git commit -m "feat: add native responses non-stream handler"
```

**Acceptance**
- Non-stream responses match OpenAI parity (object/created, function_call outputs, no previous_response_id).

---

### Task 8: Native stream handler + SSE emitter
**Files:**
- Modify: `src/handlers/responses/stream.js`
- Modify: `src/handlers/responses/stream-adapter.js` (refactor to pure emitter)
- Test: `tests/integration/responses.contract.streaming.int.test.js`
- Test: `tests/e2e/responses-contract.spec.js`

**Step 1: Write the failing streaming assertions**
- Expect typed SSE ordering: `response.created` → `response.output_text.delta` → `response.output_text.done` → tool events → `response.completed` → `done`.

**Step 2: Run test to verify it fails**
```bash
npm run test:integration -- tests/integration/responses.contract.streaming.int.test.js
```
Expected: FAIL (wrapper adapter emits chat-shaped events).

**Step 3: Write minimal implementation**
```js
export const createResponsesSseEmitter = ({ res, responseId, created }) => ({
  created: () => writeEvent("response.created", { type: "response.created", response: { id: responseId, status: "in_progress" } }),
  textDelta: (delta) => writeEvent("response.output_text.delta", { type: "response.output_text.delta", delta, output_index: 0 }),
  textDone: () => writeEvent("response.output_text.done", { type: "response.output_text.done" }),
  toolAdded: (item) => writeEvent("response.output_item.added", item),
  toolArgsDelta: (delta) => writeEvent("response.function_call_arguments.delta", delta),
  toolDone: (item) => writeEvent("response.output_item.done", item),
  completed: (envelope) => writeEvent("response.completed", { type: "response.completed", response: envelope }),
  done: () => writeEvent("done", "[DONE]"),
});
```
Wire `runNativeResponses` events to emitter methods and remove chat-specific adapters.

**Step 4: Run test to verify it passes**
```bash
npm run test:integration -- tests/integration/responses.contract.streaming.int.test.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add src/handlers/responses/stream.js src/handlers/responses/stream-adapter.js

git commit -m "feat: add native responses stream handler"
```

**Acceptance**
- Typed SSE matches OpenAI ordering and ends with `response.completed` and `[DONE]`.

---

### Task 9: Align title/summary intercept
**Files:**
- Modify: `src/handlers/responses/title-summary-intercept.js`

**Step 1: Update intercept to use envelope builder**
- Replace local `buildResponsesEnvelope` with `buildResponsesEnvelope` from native module.
- Ensure `object`/`created` and id normalization apply; remove `previous_response_id` echo.

**Step 2: Run focused tests (if any)**
```bash
npm run test:unit -- tests/unit/handlers/responses/title-summary-intercept.spec.js
```
Expected: PASS (add test if missing).

**Step 3: Commit**
```bash
git add src/handlers/responses/title-summary-intercept.js

git commit -m "refactor: align responses title intercept envelope"
```

**Acceptance**
- Intercept responses match native envelope format and output-mode rules.

---

### Task 10: Remove wrapper-only helpers
**Files:**
- Modify: `src/handlers/responses/shared.js`

**Step 1: Remove wrapper helpers**
- Delete or quarantine `coerceInputToChatMessages` and `convertChatResponseToResponses`.
- Keep id normalizers and output-mode resolver (header/default only).

**Step 2: Run unit tests**
```bash
npm run test:unit
```
Expected: PASS

**Step 3: Commit**
```bash
git add src/handlers/responses/shared.js

git commit -m "refactor: remove responses wrapper helpers"
```

**Acceptance**
- Responses handlers no longer depend on chat wrapper conversion.

---

### Task 11: Update tests, fixtures, and docs
**Files:**
- Modify: `tests/shared/transcript-utils.js`
- Regenerate: `test-results/responses/*`
- Modify: `tests/integration/responses.contract.*`
- Modify: `tests/e2e/responses-contract.spec.js`
- Modify: `docs/api/responses.md`
- Modify: `README.md`

**Step 1: Update tests and sanitizers**
- Replace `tool_use` expectations with `function_call` output items.
- Add assertions for `object` and `created`.

**Step 2: Regenerate transcripts**
```bash
node scripts/generate-responses-transcripts.mjs
```

**Step 3: Run full suite**
```bash
npm run test:unit
npm run test:integration
npm test
```
Expected: PASS

**Step 4: Commit**
```bash
git add tests docs README.md test-results/responses

git commit -m "test: update responses parity fixtures"
```

**Acceptance**
- Tests, fixtures, and docs reflect OpenAI parity for `/v1/responses`.

---

## Tests to run
- `npm run test:unit`
- `npm run test:integration`
- `npm test`

## Definition of Done
- `/v1/responses` is native (no chat delegation).
- Strict input parity (rejects `messages`, supports `function_call_output`).
- Strict output parity (object/created, function_call output items with string args, no previous_response_id).
- Typed SSE parity with correct event ordering and `[DONE]` sentinel.
- Output mode only changes via explicit header or config default.
- Tests, transcripts, and docs updated and passing.
