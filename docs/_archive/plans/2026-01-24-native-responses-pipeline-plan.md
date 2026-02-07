# Native Responses Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a native `/v1/responses` pipeline that talks to JSON-RPC directly (no chat handler wrapper) while preserving existing Responses contract (output envelope + typed SSE).
**Architecture:** Responses handlers (`src/handlers/responses/stream.js`, `nonstream.js`) normalize Responses inputs into chat messages, call `createJsonRpcChildAdapter` directly, parse JSON-RPC events with `parseStreamEventLine`/`createStreamEventRouter`, and build Responses envelopes/typed SSE events without delegating to `postChatStream`/`postChatNonStream`.
**Tech Stack:** Node.js 22, Express, JSON-RPC transport (`src/services/transport`), SSE utilities (`src/services/sse.js`), tool-call aggregation (`src/lib/tool-call-aggregator.js`), tests via Vitest + Playwright.

## Goal
- Make `/v1/responses` a first-class pipeline that does not call chat handlers.
- Preserve the current Responses contract: `output[]` with `message` + `tool_use` items, `status`, `usage`, and `previous_response_id` echoing.
- Keep typed SSE events (`event:` lines) consistent with existing transcripts.

## Assumptions / constraints
- `/v1/responses` continues to emit the existing Responses envelope (`output[]`, `status`, `usage`) used by transcripts under `test-results/responses/*`.
- Streaming uses typed SSE events (with `event:`), not raw `data:` chunks. This matches `parseSSE` in `tests/shared/transcript-utils.js`.
- Multi-turn role preservation is achieved via `messages[]` passed to `normalizeChatJsonRpcRequest` which encodes role labels in the transcript; JSON-RPC `InputItem` does not support roles.
- `PROXY_COPILOT_AUTO_DETECT` only affects chat endpoints; `/v1/responses` stays `openai-json` unless `x-proxy-output-mode` is explicit or config is set.
- Accept `messages[]` as a compatibility alias when `input`/`instructions` are absent; reject mixed `messages[]` + `input`/`instructions` to avoid ambiguous precedence.

## Research (current state)
- Current wrapper path:
  - `src/handlers/responses/stream.js` and `nonstream.js` convert inputs and call `postChatStream` / `postChatNonStream`.
  - `src/handlers/responses/shared.js` contains `coerceInputToChatMessages` and `convertChatResponseToResponses` for wrapper conversion.
  - `src/handlers/responses/stream-adapter.js` converts chat SSE to typed Responses events.
- Native building blocks already in repo:
  - JSON-RPC transport: `createJsonRpcChildAdapter` (`src/services/transport/child-adapter.js`), `getJsonRpcTransport` (`src/services/transport/index.js`).
  - JSON-RPC event parsing: `parseStreamEventLine` (`src/handlers/chat/stream-event.js`), `createStreamEventRouter` (`src/handlers/chat/stream-event-router.js`), `wireStreamTransport` (`src/handlers/chat/stream-transport.js`).
  - SSE helpers: `setSSEHeaders`, `computeKeepaliveMs`, `startKeepalives`, `writeSseChunk` (`src/services/sse.js`).
  - Tool-call aggregation: `createToolCallAggregator` (`src/lib/tool-call-aggregator.js`).
  - Responses contracts/tests: `tests/integration/responses.contract.*`, `tests/e2e/responses-contract.spec.js`, transcripts in `test-results/responses/*`.

## Analysis
### Options
1) Keep wrapper and improve conversion helpers.
2) Native responses handlers using JSON-RPC child adapter + event router (no chat handler calls).
3) Directly use `JsonRpcTransport` and bypass child adapter/event router.

### Decision
- Chosen: Option 2.
- Why: It avoids chat handler dependency while still using the existing JSON-RPC adapter, event parsing, SSE utilities, and tool aggregation already proven in chat.

### Risks / edge cases
- JSON-RPC `InputItem` cannot encode roleful messages; role order is preserved only in transcript labels (`[assistant]`, `[tool:...]`).
- Tool-call arguments are expected to be parsed into `tool_use.input` objects in the current transcripts; changing this would break fixtures.
- Typed SSE ordering must match transcripts or tests will fail.

### Open questions
- None.

## Q&A (answer before implementation)
- Decision: accept `messages[]` as an alias only when it is the sole input shape.

## Task list with acceptance criteria
- Task 1: Add a native Responses request normalizer.
  - AC: `input[]` message items preserve role order; `function_call_output` becomes tool-role messages; `messages[]` accepted when `input`/`instructions` are absent; mixed shapes return 400 with `param:"messages"`; `x-proxy-output-mode` overrides config; unit tests pass.
- Task 2: Build a Responses envelope builder for native handlers.
  - AC: Output envelope matches transcripts (`output[]` with `tool_use`, `status`, `usage`, `previous_response_id` echoed); arguments parsed when valid JSON; unit tests pass.
- Task 3: Rewrite `/v1/responses` non-stream handler to run JSON-RPC directly.
  - AC: No call to `postChatNonStream`; integration transcripts match; logging/capture preserved.
- Task 4: Rewrite `/v1/responses` streaming handler to emit typed SSE directly.
  - AC: No `postChatStream`; typed events only; transcripts match; keepalive and concurrency guard preserved.
- Task 5: Retire wrapper-only helpers or move them to native modules.
  - AC: `coerceInputToChatMessages` / `convertChatResponseToResponses` are removed or unused; tests updated accordingly.

## Implementation plan
### Task 1: Add a native Responses request normalizer
**Files:**
- Create: `src/handlers/responses/native/request.js`
- Modify: `src/handlers/responses/shared.js` (export id helpers, output mode resolver)
- Test: `tests/unit/handlers/responses/native/request.spec.js`

**Step 1: Write the failing test**
```js
it("maps responses input items into chat messages", () => {
  const body = {
    instructions: "Use tools",
    input: [
      { type: "message", role: "developer", content: "Obey" },
      { type: "input_text", text: "Hello" },
      { type: "function_call_output", call_id: "call_1", output: "OK" },
    ],
  };
  const { messages } = normalizeResponsesRequest(body);
  expect(messages).toEqual([
    { role: "system", content: "Use tools" },
    { role: "developer", content: "Obey" },
    { role: "user", content: "Hello" },
    { role: "tool", name: "call_1", content: "OK" },
  ]);
});

it("accepts messages[] alias when input is absent", () => {
  const body = {
    messages: [
      { role: "developer", content: "Use tools" },
      { role: "user", content: "Hi" },
    ],
  };
  const { messages } = normalizeResponsesRequest(body);
  expect(messages).toEqual(body.messages);
});

it("rejects mixed messages[] with input/instructions", () => {
  const body = { messages: [{ role: "user", content: "Hi" }], input: "Yo" };
  expect(() => normalizeResponsesRequest(body)).toThrowError(/messages/);
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/handlers/responses/native/request.spec.js`
Expected: FAIL (module not implemented).

**Step 3: Write minimal implementation**
```js
import { normalizeChatJsonRpcRequest } from "../../chat/request.js";
import { resolveResponsesOutputMode } from "../shared.js";

export const normalizeResponsesRequest = ({ body, req, effectiveModel, choiceCount, stream }) => {
  const messages = buildMessagesFromResponses(body); // new helper in this module
  const outputMode = resolveResponsesOutputMode({
    req,
    defaultValue: CFG.PROXY_RESPONSES_OUTPUT_MODE,
  }).effective;

  const normalized = normalizeChatJsonRpcRequest({
    body: mapResponsesFieldsToChat(body),
    messages,
    prompt: "",
    effectiveModel,
    choiceCount,
    stream,
    reasoningEffort: body.reasoning?.effort,
    sandboxMode: SANDBOX_MODE,
    codexWorkdir: CODEX_WORKDIR,
    approvalMode: APPROVAL_POLICY,
  });

  return { messages, normalized, outputMode };
};
```

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/handlers/responses/native/request.spec.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/handlers/responses/native/request.js tests/unit/handlers/responses/native/request.spec.js
git commit -m "feat(responses): add native request normalizer"
```

### Task 2: Add a Responses envelope builder
**Files:**
- Create: `src/handlers/responses/native/envelope.js`
- Modify: `src/handlers/responses/shared.js` (export `normalizeResponseId`, `normalizeMessageId`)
- Test: `tests/unit/handlers/responses/native/envelope.spec.js`

**Step 1: Write the failing test**
```js
it("builds tool_use content with parsed args", () => {
  const toolCalls = [{ id: "call_1", function: { name: "lookup", arguments: "{\"id\":\"42\"}" } }];
  const envelope = buildResponsesEnvelope({
    responseId: "resp_1",
    model: "codex-5",
    text: "",
    toolCalls,
    usage: { prompt_tokens: 1, completion_tokens: 2 },
    previousResponseId: "resp_prev",
  });
  expect(envelope.output[0].content[0]).toEqual({
    type: "tool_use",
    id: expect.any(String),
    name: "lookup",
    input: { id: "42" },
  });
  expect(envelope.previous_response_id).toBe("resp_prev");
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/handlers/responses/native/envelope.spec.js`
Expected: FAIL.

**Step 3: Write minimal implementation**
- Reuse the JSON parsing behavior from `mapToolCallToContent` (currently in `src/handlers/responses/shared.js`).
- Keep output shape consistent with `test-results/responses/nonstream-tool-call.json`.

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/handlers/responses/native/envelope.spec.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/handlers/responses/native/envelope.js tests/unit/handlers/responses/native/envelope.spec.js
git commit -m "feat(responses): add native envelope builder"
```

### Task 3: Rewrite non-stream handler to use native pipeline
**Files:**
- Modify: `src/handlers/responses/nonstream.js`
- Modify: `src/handlers/responses/capture.js` (if shape changes)
- Test: `tests/integration/responses.contract.nonstream.int.test.js`

**Step 1: Write the failing test**
Add a test that asserts handler does not call `postChatNonStream` (via mock) and still matches transcript.

**Step 2: Run test to verify it fails**
Run: `npm run test:integration -- tests/integration/responses.contract.nonstream.int.test.js`
Expected: FAIL until handler is rewritten.

**Step 3: Write minimal implementation**
- Create child adapter: `const child = createJsonRpcChildAdapter({ reqId, timeoutMs, normalizedRequest, trace })`.
- Parse stdout lines with `parseStreamEventLine` + `createStreamEventRouter` to accumulate deltas, tool calls, usage, finish reason.
- Build envelope with `buildResponsesEnvelope` (Task 2).
- Preserve existing logging/capture (`logResponsesIngressRaw`, `captureResponsesNonStream`, `logStructured`).

**Step 4: Run test to verify it passes**
Run: `npm run test:integration -- tests/integration/responses.contract.nonstream.int.test.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/handlers/responses/nonstream.js
git commit -m "feat(responses): native nonstream handler"
```

### Task 4: Rewrite stream handler to use native pipeline
**Files:**
- Modify: `src/handlers/responses/stream.js`
- Modify: `src/handlers/responses/stream-adapter.js` (if reusing logic)
- Test: `tests/integration/responses.contract.streaming.int.test.js`

**Step 1: Write the failing test**
Add an assertion that SSE only includes typed responses events (no `chat.completion.chunk`).

**Step 2: Run test to verify it fails**
Run: `npm run test:integration -- tests/integration/responses.contract.streaming.int.test.js`
Expected: FAIL until handler is rewritten.

**Step 3: Write minimal implementation**
- Use `setSSEHeaders`, `computeKeepaliveMs`, `startKeepalives` from `src/services/sse.js`.
- Reuse `setupStreamGuard` and `applyGuardHeaders` from `src/services/concurrency-guard.js` (see chat stream).
- Wire JSON-RPC stdout into a Responses stream runtime (either refactor `responses/stream-adapter.js` into a runtime or create `src/handlers/responses/native/stream-runtime.js`).
- Emit typed events via `writeSseChunk` with `event:` lines (`response.created`, `response.output_text.delta`, `response.output_item.added`, etc.).
- Ensure terminal `response.completed` matches non-stream envelope from Task 2, then `event: done` with `[DONE]`.

**Step 4: Run test to verify it passes**
Run: `npm run test:integration -- tests/integration/responses.contract.streaming.int.test.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/handlers/responses/stream.js src/handlers/responses/native/stream-runtime.js
git commit -m "feat(responses): native streaming handler"
```

### Task 5: Retire wrapper-only helpers and update tests
**Files:**
- Modify: `src/handlers/responses/shared.js`
- Modify: `tests/unit/responses.shared.spec.js`

**Step 1: Write the failing test**
Remove tests for wrapper-only helpers (`coerceInputToChatMessages`, `convertChatResponseToResponses`) and add coverage for new native helpers.

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/responses.shared.spec.js`
Expected: FAIL until helpers are removed and tests updated.

**Step 3: Write minimal implementation**
- Remove unused wrapper helpers.
- Export id helpers and any shared parsing utilities needed by new native modules.

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/responses.shared.spec.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/handlers/responses/shared.js tests/unit/responses.shared.spec.js
git commit -m "chore(responses): remove wrapper-only helpers"
```

## Tests to run
- `npm run test:unit`
- `npm run test:integration`
- `npm test`
- `node scripts/generate-responses-transcripts.mjs` (only if fixtures change)

## Definition of Done
- `/v1/responses` handlers no longer call chat handlers.
- Non-stream and stream outputs match existing transcripts in `test-results/responses/*`.
- Tool-use items continue to be `tool_use` with parsed `input` objects when JSON is valid.
- Typed SSE events and `[DONE]` sentinel match transcript ordering.
