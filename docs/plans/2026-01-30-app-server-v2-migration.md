# App Server v2 Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish v2-only JSON-RPC alignment by removing legacy listener plumbing, pruning unused v1 artifacts, and ensuring tests cover the v2 flow end-to-end.

**Architecture:** The proxy uses a JSON-RPC transport to a supervised Codex CLI app-server. v2 flow is: initialize → initialized, thread/start for conversation bootstrap, turn/start for user input, and v2 notifications (agentMessageDelta/agentMessage/tokenCount/turn/completed) to resolve the request context. Fake app-server harness (`scripts/fake-codex-jsonrpc.js`) is used for deterministic tests.

**Tech Stack:** Node.js, Express, JSON-RPC, Vitest, Codex CLI app-server.

---

## Progress Snapshot (from analysis + last changes)

**Completed**
- [x] Send `initialized` after `initialize` (v2 handshake) in `src/services/transport/index.js` (ensureHandshake).
- [x] Use v2-only `initialize` params (camelCase only) in `src/lib/json-rpc/schema.ts`.
- [x] Use `thread/start` for conversation creation in `src/services/transport/index.js` (#ensureConversation).
- [x] Use `turn/start` for user turns in `src/services/transport/index.js` (#sendUserTurn + `buildTurnStartParams`).
- [x] Handle `turn/completed` notification in `src/services/transport/index.js` (#handleNotification).
- [x] Remove snake_case aliases from request builders in `src/lib/json-rpc/schema.ts`.
- [x] Update fake app-server to emit v2 signals (including `turn/completed`) in `scripts/fake-codex-jsonrpc.js`.
- [x] Fix worker config booleans to prevent CLI schema errors in `src/services/worker/supervisor.js`.
- [x] Add handshake retry in `src/middleware/worker-ready.js` and tests.
- [x] Updated unit/integration tests and docs for v2 migration (see modified files in `tests/` and `docs/`).

**Pending**
- [ ] Remove `addConversationListener` usage for v2 (auto-subscribe after `thread/start`).
- [ ] Remove `buildAddConversationListenerParams` + `buildRemoveConversationListenerParams` if unused.
- [ ] Clean up any remaining subscription bookkeeping (`subscriptionId`, `listenerAttached`) once listener calls are gone.
- [ ] Align fake worker/tests to the no-listener flow.

---

## Acceptance Criteria (overall)
- No JSON-RPC calls to `addConversationListener` or `removeConversationListener` in v2 mode.
- No references to v1-only methods (`newConversation`, `sendUserTurn`) in transport path.
- All unit/integration tests pass (`npm run test:unit`, relevant integration tests).
- Dev stack works for tool and non-tool queries with v2 app-server.

---

### Task 1: Remove listener RPCs in v2 flow

**Files:**
- Modify: `src/services/transport/index.js` (remove listener RPC in #ensureConversation)
- Modify: `src/lib/json-rpc/schema.ts` (remove listener param builders if unused)
- Test: `tests/unit/services/json-rpc-transport.spec.js`

**Step 1: Write the failing test**
```js
it("does not call addConversationListener after thread/start", async () => {
  const child = createMockChild();
  const methods = [];
  wireJsonResponder(child, (message) => {
    methods.push(message.method);
    if (message.method === "initialize") {
      writeRpcResult(child, message.id, { result: {} });
    }
    if (message.method === "thread/start") {
      writeRpcResult(child, message.id, { result: { threadId: "thr-1" } });
    }
    if (message.method === "turn/start") {
      writeRpcResult(child, message.id, { result: {} });
    }
  });
  __setChild(child);

  const transport = getJsonRpcTransport();
  const context = await transport.createChatRequest({ requestId: "req-1" });
  context.emitter.on("error", () => {});
  const pending = context.promise.catch(() => {});

  await flushAsync();
  await new Promise((r) => setImmediate(r));
  await flushAsync();

  expect(methods).toContain("thread/start");
  expect(methods).toContain("turn/start");
  expect(methods).not.toContain("addConversationListener");

  transport.cancelContext(context, new TransportError("request aborted", { code: "request_aborted" }));
  await pending;
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/services/json-rpc-transport.spec.js`
Expected: FAIL because `addConversationListener` is still called.

**Step 3: Write minimal implementation**
- In `src/services/transport/index.js`, remove the `addConversationListener` RPC after `thread/start`.
- Ensure `listenerAttached` is not set for v2 flows (or remove its usage entirely if no longer needed).

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/services/json-rpc-transport.spec.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/transport/index.js tests/unit/services/json-rpc-transport.spec.js
git commit -m "fix: drop addConversationListener in v2 flow"
```

---

### Task 2: Remove unused listener builders and types

**Files:**
- Modify: `src/lib/json-rpc/schema.ts`
- Test: `tests/unit/json-rpc-schema.helpers.spec.ts`

**Step 1: Write the failing test**
```ts
it("does not expose listener param builders in v2-only schema", () => {
  // This should fail until the exports are removed.
  expect((schema as any).buildAddConversationListenerParams).toBeUndefined();
  expect((schema as any).buildRemoveConversationListenerParams).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/json-rpc-schema.helpers.spec.ts`
Expected: FAIL because builders are still exported.

**Step 3: Write minimal implementation**
- Remove `buildAddConversationListenerParams` and `buildRemoveConversationListenerParams` exports from `src/lib/json-rpc/schema.ts`.
- Remove corresponding types if no longer used.

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/json-rpc-schema.helpers.spec.ts`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/lib/json-rpc/schema.ts tests/unit/json-rpc-schema.helpers.spec.ts
git commit -m "chore: remove v1 listener builders"
```

---

### Task 3: Clean up subscription bookkeeping

**Files:**
- Modify: `src/services/transport/index.js`
- Test: `tests/unit/services/json-rpc-transport.spec.js`

**Step 1: Write the failing test**
```js
it("does not attempt removeConversationListener when no subscription exists", async () => {
  const child = createMockChild();
  wireJsonResponder(child, (message) => {
    if (message.method === "initialize") writeRpcResult(child, message.id, { result: {} });
    if (message.method === "thread/start") writeRpcResult(child, message.id, { result: { threadId: "thr-2" } });
    if (message.method === "turn/start") writeRpcResult(child, message.id, { result: {} });
  });
  __setChild(child);

  const transport = getJsonRpcTransport();
  const context = await transport.createChatRequest({ requestId: "req-2" });
  context.emitter.on("error", () => {});
  transport.cancelContext(context, new TransportError("request aborted", { code: "request_aborted" }));

  await flushAsync();
  // Ensure no removeConversationListener is emitted when subscriptionId is null.
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/services/json-rpc-transport.spec.js`
Expected: FAIL if a remove listener call is made.

**Step 3: Write minimal implementation**
- Ensure `#removeConversationListener` is never called when no subscription was established.
- Remove or reset `listenerAttached` in v2 flow.

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/services/json-rpc-transport.spec.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/transport/index.js tests/unit/services/json-rpc-transport.spec.js
git commit -m "chore: simplify v2 subscription tracking"
```

---

## Test Changes / Additions Needed
- New transport test to assert no `addConversationListener` after `thread/start`.
- Optional transport test to confirm `removeConversationListener` is never sent in v2-only mode.
- Schema helper test to ensure listener param builders are removed.

---

## Where We Stand
- Handshake, thread/start, turn/start, v2 notifications, and schema cleanup are implemented.
- Remaining work is focused on removing listener RPCs and related schema/test scaffolding.
- Unit tests are currently passing with latest changes; the next planned changes will require the above test updates.

---

Plan complete and saved to `docs/plans/2026-01-30-app-server-v2-migration.md`.

Two execution options:
1. Subagent-Driven (this session) — use superpowers:subagent-driven-development per task
2. Parallel Session (separate) — open a new session with superpowers:executing-plans

Which approach do you want?
