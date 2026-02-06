# Dynamic Tools Thread Start + Dynamic Tool Call Events Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align tool handling with app-server 0.92: send client tools only at thread start (`dynamicTools`) and map `dynamic_tool_call_request` events into OpenAI tool-call deltas.

**Architecture:** Add a small mapping utility for OpenAI tools → app-server `dynamicTools` and for dynamic tool-call events → tool-call deltas. Update schema + handlers so only `newConversation` receives tools, and update event routing (stream + nonstream) to translate dynamic tool calls.

**Tech Stack:** Node.js, Vitest, JSON-RPC schema builders in `src/lib/json-rpc/schema.ts`.

---

## Task 1: Add dynamic tools mapping utility + tests

**Files:**
- Create: `src/lib/tools/dynamic-tools.js`
- Test: `tests/unit/lib/dynamic-tools.spec.js`

**Step 1: Write the failing tests**
```js
import { describe, expect, it } from "vitest";
import {
  buildDynamicTools,
  buildToolCallDeltaFromDynamicRequest,
} from "../../../src/lib/tools/dynamic-tools.js";

describe("dynamic tools mapping", () => {
  it("maps function tools to dynamicTools", () => {
    const tools = [
      { type: "function", function: { name: "lookup", description: "d", parameters: { type: "object" } } },
    ];
    expect(buildDynamicTools(tools, "auto")).toEqual([
      { name: "lookup", description: "d", inputSchema: { type: "object" } },
    ]);
  });

  it("honors tool_choice none", () => {
    const tools = [
      { type: "function", function: { name: "lookup", parameters: {} } },
    ];
    expect(buildDynamicTools(tools, "none")).toEqual([]);
  });

  it("honors forced tool_choice", () => {
    const tools = [
      { type: "function", function: { name: "a", parameters: {} } },
      { type: "function", function: { name: "b", parameters: {} } },
    ];
    expect(buildDynamicTools(tools, { type: "function", function: { name: "b" } })).toEqual([
      { name: "b", description: undefined, inputSchema: {} },
    ]);
  });
});

describe("dynamic tool call request mapping", () => {
  it("builds tool_calls delta from dynamic_tool_call_request", () => {
    const delta = buildToolCallDeltaFromDynamicRequest({
      tool: "lookup",
      arguments: { id: 1 },
      callId: "call_1",
    });
    expect(delta).toEqual({
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"id":1}' },
        },
      ],
    });
  });
});
```

**Step 2: Run tests to verify they fail**
Run: `npm run test:unit -- tests/unit/lib/dynamic-tools.spec.js`
Expected: FAIL (module not found).

**Step 3: Write minimal implementation**
Implement:
- `buildDynamicTools(definitions, toolChoice)`
- `buildToolCallDeltaFromDynamicRequest(payload)`

**Step 4: Run tests to verify they pass**
Run: `npm run test:unit -- tests/unit/lib/dynamic-tools.spec.js`
Expected: PASS.

**Step 5: Commit**
```
git add src/lib/tools/dynamic-tools.js tests/unit/lib/dynamic-tools.spec.js
git commit -m "feat: add dynamic tools mapping helpers"
```

---

## Task 2: Update JSON-RPC schema (dynamicTools on newConversation; remove tools on sendUser*)

**Files:**
- Modify: `src/lib/json-rpc/schema.ts`
- Test: `tests/unit/json-rpc-schema.test.ts`
- Test: `tests/unit/json-rpc-schema.helpers.spec.ts`

**Step 1: Write failing tests**
Add/adjust tests:
- `buildNewConversationParams` includes `dynamicTools` when provided.
- `buildSendUserMessageParams` does **not** include `tools`.
- `buildSendUserTurnParams` does **not** include `tools`.

**Step 2: Run tests to verify they fail**
Run: `npm run test:unit -- tests/unit/json-rpc-schema.test.ts tests/unit/json-rpc-schema.helpers.spec.ts`
Expected: FAIL.

**Step 3: Implement schema changes**
- Add `dynamicTools?: JsonValue[]` to `NewConversationParams` + `BuildNewConversationOptions`.
- Add builder logic to include `dynamicTools` if array.
- Remove `tools` from `SendUserTurnParams`, `BuildSendUserTurnOptions`, `SendUserMessageParams`, `BuildSendUserMessageOptions`, and builder logic.

**Step 4: Run tests to verify they pass**
Run: `npm run test:unit -- tests/unit/json-rpc-schema.test.ts tests/unit/json-rpc-schema.helpers.spec.ts`
Expected: PASS.

**Step 5: Commit**
```
git add src/lib/json-rpc/schema.ts tests/unit/json-rpc-schema.test.ts tests/unit/json-rpc-schema.helpers.spec.ts
git commit -m "feat: align json-rpc schema for dynamic tools"
```

---

## Task 3: Map OpenAI tools → dynamicTools at thread start

**Files:**
- Modify: `src/handlers/chat/request.js`
- Modify: `src/handlers/responses/stream.js`
- Modify: `src/handlers/responses/nonstream.js`
- Modify: `src/services/transport/index.js`
- Test: `tests/unit/handlers/chat/request.spec.js`

**Step 1: Write failing tests**
- Add test that chat normalization sets `turn.dynamicTools` and does **not** set `turn.tools` or `message.tools`.

**Step 2: Run tests to verify they fail**
Run: `npm run test:unit -- tests/unit/handlers/chat/request.spec.js`
Expected: FAIL.

**Step 3: Implement handler changes**
- Use `buildDynamicTools` to map `definitions + toolChoice` to `dynamicTools`.
- Attach `dynamicTools` to `turn` in chat + responses handlers.
- Remove tool payload assignments on `turn`/`message` for sendUserTurn/sendUserMessage.
- Update `#ensureConversation` mapping to pass `dynamicTools` into `buildNewConversationParams`.

**Step 4: Run tests to verify they pass**
Run: `npm run test:unit -- tests/unit/handlers/chat/request.spec.js`
Expected: PASS.

**Step 5: Commit**
```
git add src/handlers/chat/request.js src/handlers/responses/stream.js src/handlers/responses/nonstream.js src/services/transport/index.js tests/unit/handlers/chat/request.spec.js
git commit -m "feat: send dynamic tools at thread start"
```

---

## Task 4: Translate dynamic_tool_call_request events to tool_calls deltas

**Files:**
- Modify: `src/handlers/chat/stream-event-router.js`
- Modify: `src/handlers/chat/nonstream.js`
- Test: `tests/unit/handlers/chat/stream-event-router.spec.js`

**Step 1: Write failing tests**
- Add a unit test that verifies `dynamic_tool_call_request` triggers `handleParsedEvent` with a synthesized `agent_message_delta` containing `tool_calls`.

**Step 2: Run tests to verify they fail**
Run: `npm run test:unit -- tests/unit/handlers/chat/stream-event-router.spec.js`
Expected: FAIL.

**Step 3: Implement routing**
- In `createStreamEventRouter`, when `t === "dynamic_tool_call_request"`, build tool_calls delta via helper and call `handleParsedEvent` with a synthesized parsed object.
- In `chat/nonstream.js`, when `tp === "dynamic_tool_call_request"`, ingest tool_calls into the toolCallAggregator and mark `hasToolCalls = true`.

**Step 4: Run tests to verify they pass**
Run: `npm run test:unit -- tests/unit/handlers/chat/stream-event-router.spec.js`
Expected: PASS.

**Step 5: Commit**
```
git add src/handlers/chat/stream-event-router.js src/handlers/chat/nonstream.js tests/unit/handlers/chat/stream-event-router.spec.js
git commit -m "feat: map dynamic tool call requests"
```

---

## Task 5: Update docs to match spec

**Files:**
- Modify: `docs/api-v2-migration/02_conversation_bootstrap_newConversation_params.md`
- Modify: `docs/api-v2-migration/03_request_path_sendUserMessage_streaming_refactor.md`

**Step 1: Write minimal doc updates**
- Note that tools are now thread-start `dynamicTools` only (no per-request tools).
- Document dynamic tool event mapping.

**Step 2: Verify doc references**
Run: `rg -n "dynamicTools|dynamic_tool_call_request" docs/api-v2-migration/02_conversation_bootstrap_newConversation_params.md docs/api-v2-migration/03_request_path_sendUserMessage_streaming_refactor.md`

**Step 3: Commit**
```
git add docs/api-v2-migration/02_conversation_bootstrap_newConversation_params.md docs/api-v2-migration/03_request_path_sendUserMessage_streaming_refactor.md
git commit -m "docs: document dynamic tools alignment"
```

---

## Task 6: Targeted verification

Run:
```
npm run test:unit -- \
  tests/unit/lib/dynamic-tools.spec.js \
  tests/unit/json-rpc-schema.test.ts \
  tests/unit/json-rpc-schema.helpers.spec.ts \
  tests/unit/handlers/chat/request.spec.js \
  tests/unit/handlers/chat/stream-event-router.spec.js
```

---

Plan complete and saved to `docs/plans/2026-01-28-dynamic-tools-thread-start.md`.

Two execution options:

1. Subagent-Driven (this session) — I dispatch a fresh subagent per task, review between tasks.
2. Parallel Session (separate) — Open a new session with `executing-plans` and follow the plan with checkpoints.

Which approach?
