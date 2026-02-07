# V2-Only App Server Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all v1 JSON-RPC paths and align the proxy exclusively with v2 app-server handshake and request shapes.

**Architecture:** The transport will always use v2 methods (`thread/start`, `turn/start`) and emit the `initialized` notification after `initialize`. Schema helpers will emit only v2 camelCase parameters and v1 builders will be removed.

**Tech Stack:** Node.js (ESM), Vitest, JSON-RPC transport.

### Task 1: Add failing handshake test for `initialized`

**Files:**
- Modify: `tests/unit/services/json-rpc-transport.spec.js`

**Step 1: Write the failing test**

```js
it("sends initialized notification after initialize", async () => {
  const child = createMockChild();
  const methods = [];
  child.stdin.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (!text) return;
    const message = JSON.parse(text);
    methods.push(message.method);
    if (message.method === "initialize") {
      child.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { advertised_models: ["codex-5"] },
        }) + "\n"
      );
    }
  });
  __setChild(child);

  const transport = getJsonRpcTransport();
  await transport.ensureHandshake();

  expect(methods).toContain("initialized");
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/services/json-rpc-transport.spec.js -t "sends initialized notification"`
Expected: FAIL (no `initialized` method emitted).

**Step 3: Commit**

```bash
git add tests/unit/services/json-rpc-transport.spec.js
git commit -m "test: add failing initialized handshake spec"
```

### Task 2: Add failing v2-only transport behavior tests

**Files:**
- Modify: `tests/unit/services/json-rpc-transport.spec.js`

**Step 1: Write failing tests**
- Update tests that expect `newConversation` to expect `thread/start`.
- Update tests that expect `sendUserTurn`/`sendUserMessage` to expect `turn/start`.

Example update:
```js
expect(methods).toContain("thread/start");
expect(methods).toContain("turn/start");
expect(methods).not.toContain("newConversation");
```

**Step 2: Run tests to verify failures**

Run: `npm run test:unit -- tests/unit/services/json-rpc-transport.spec.js`
Expected: FAIL (transport still emits v1 methods).

**Step 3: Commit**

```bash
git add tests/unit/services/json-rpc-transport.spec.js
git commit -m "test: assert v2-only transport methods"
```

### Task 3: Add failing schema tests for v2-only helpers

**Files:**
- Modify: `tests/unit/json-rpc-schema.test.ts`
- Modify: `tests/unit/json-rpc-schema.helpers.spec.ts`
- Modify: `tests/integration/json-rpc-schema-validation.int.test.js`

**Step 1: Write failing tests**
- Replace `buildNewConversationParams` usage with `buildThreadStartParams`.
- Replace `buildSendUserTurnParams`/`buildSendUserMessageParams` with `buildTurnStartParams`.
- Add assertions that snake_case fields are absent.

Example:
```ts
const params = buildInitializeParams({ clientInfo: { name: "tester", version: "1.2.3" }, protocolVersion: "v2" });
expect(params.client_info).toBeUndefined();
expect(params.protocol_version).toBeUndefined();
```

**Step 2: Run tests to verify failures**

Run: `npm run test:unit -- tests/unit/json-rpc-schema.test.ts tests/unit/json-rpc-schema.helpers.spec.ts`
Expected: FAIL (builders still emit v1 fields).

**Step 3: Commit**

```bash
git add tests/unit/json-rpc-schema.test.ts tests/unit/json-rpc-schema.helpers.spec.ts tests/integration/json-rpc-schema-validation.int.test.js
git commit -m "test: require v2-only schema helpers"
```

### Task 4: Implement v2-only transport

**Files:**
- Modify: `src/services/transport/index.js`
- Modify: `src/services/transport/child-adapter.js`

**Step 1: Implement minimal code**
- Send `initialized` notification immediately after successful `initialize` response.
- Remove `shouldUseThreadStart` and all `newConversation`/`sendUserMessage` code paths.
- Always use `thread/start` for conversation creation.
- Always use `turn/start` in `#sendUserTurn`.
- Remove `context.protocol` checks and v1 method names.

**Step 2: Run unit transport tests**

Run: `npm run test:unit -- tests/unit/services/json-rpc-transport.spec.js`
Expected: PASS.

**Step 3: Commit**

```bash
git add src/services/transport/index.js src/services/transport/child-adapter.js
git commit -m "fix: make json-rpc transport v2-only"
```

### Task 5: Remove v1 schema helpers and snake_case fields

**Files:**
- Modify: `src/lib/json-rpc/schema.ts`

**Step 1: Implement minimal code**
- Remove v1 method names and type definitions (NewConversation*, SendUser*).
- Remove v1 builders: `buildNewConversationParams`, `buildSendUserTurnParams`, `buildSendUserMessageParams`.
- Remove snake_case aliases in initialize and any remaining v1 helpers.
- Simplify `Build*` interfaces to v2-only inputs.

**Step 2: Run schema tests**

Run: `npm run test:unit -- tests/unit/json-rpc-schema.test.ts tests/unit/json-rpc-schema.helpers.spec.ts`
Expected: PASS.

**Step 3: Commit**

```bash
git add src/lib/json-rpc/schema.ts
git commit -m "refactor: drop v1 json-rpc schema helpers"
```

### Task 6: Update integration tests to expect v2-only RPC

**Files:**
- Modify: `tests/integration/chat-jsonrpc.int.test.js`
- Modify: `tests/integration/json-rpc-schema-validation.int.test.js`

**Step 1: Update expectations**
- Replace `newConversation` capture expectations with `thread/start`.
- Replace `sendUserTurn`/`sendUserMessage` with `turn/start`.

**Step 2: Run integration tests**

Run: `npm run test:integration -- tests/integration/chat-jsonrpc.int.test.js tests/integration/json-rpc-schema-validation.int.test.js`
Expected: PASS.

**Step 3: Commit**

```bash
git add tests/integration/chat-jsonrpc.int.test.js tests/integration/json-rpc-schema-validation.int.test.js
git commit -m "test: align integration captures with v2-only rpc"
```

### Task 7: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/app-server-migration/` or `docs/api-v2-migration/` (as needed)
- Modify: `docs/README.md`
- Modify: `docs/README-root.md`

**Step 1: Update docs**
- State v2-only protocol support and remove v1 references.
- Note handshake requires `initialized` notification.

**Step 2: Run relevant docs lint (if any)**

Run: `npm run lint:runbooks` (only if docs/runbooks changed)
Expected: PASS.

**Step 3: Commit**

```bash
git add README.md docs/README.md docs/README-root.md docs/app-server-migration docs/api-v2-migration
git commit -m "docs: document v2-only app server protocol"
```

### Task 8: Full verification

**Step 1: Run checks**

Run: `npm run format:check`
Run: `npm run lint`
Run: `npm run test:unit`
Run: `npm run test:integration`

**Step 2: Final commit (if needed)**

```bash
git status -sb
```
