# Tool Thread Continuity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure tool-call continuity across subrequests by reusing app-server threads and the canonical tool manifest when tool outputs are returned, preventing “internal tools disabled” failures.

**Architecture:** Add a thread/tool registry in `JsonRpcTransport`, resolve thread identity from incoming tool outputs, and override per-request tool manifests/instructions to the thread’s canonical set before `thread/start`/`turn/start`. This keeps app-server state consistent across multi-request tool flows.

**Tech Stack:** Node.js 22, Express, Codex JSON-RPC transport, Vitest.

---

### Task 1: Create Worktree + Branch

**Files:**
- Create: _none_

**Step 1: Create a dedicated worktree**

Run:
```bash
git worktree add ../codex-completions-api-tool-thread-stability -b fix/tool-thread-stability
```
Expected: new worktree directory with branch `fix/tool-thread-stability`.

**Step 2: Enter worktree**

Run:
```bash
cd ../codex-completions-api-tool-thread-stability
```
Expected: working directory updated.

**Step 3: Verify clean status**

Run:
```bash
git status --porcelain
```
Expected: no output.

**Step 4: Commit placeholder (optional)**

Skip (no code changes yet).

---

### Task 2: Add Thread/Tool Registry + Resolver in Transport

**Files:**
- Modify: `src/services/transport/index.js`
- Test: `tests/unit/services/json-rpc-transport.spec.js`

**Step 1: Write failing test for resolving thread from tool outputs**

Add to `tests/unit/services/json-rpc-transport.spec.js`:
```js
it("resolves thread id from tool outputs using pending tool calls", async () => {
  const transport = getJsonRpcTransport();
  transport.pendingToolCalls.set("call_1", {
    callId: "call_1",
    threadId: "thread-123",
  });

  const result = transport.resolveThreadForToolOutputs([
    { callId: "call_1", output: "ok", success: true },
  ]);

  expect(result).toEqual({ threadId: "thread-123", toolset: null });
});
```
Expected: FAIL (method does not exist).

**Step 2: Run the test to confirm failure**

Run:
```bash
npx vitest run tests/unit/services/json-rpc-transport.spec.js -t "resolves thread id"
```
Expected: FAIL with `resolveThreadForToolOutputs is not a function`.

**Step 3: Implement thread tool registry + resolver**

In `src/services/transport/index.js`, add:
```js
// constructor
this.threadToolSets = new Map();

registerThreadTools(threadId, { dynamicTools, baseInstructions, developerInstructions } = {}) {
  if (!threadId) return false;
  this.threadToolSets.set(String(threadId), {
    dynamicTools: Array.isArray(dynamicTools) ? dynamicTools : null,
    baseInstructions: baseInstructions ?? null,
    developerInstructions: developerInstructions ?? null,
  });
  return true;
}

resolveThreadForToolOutputs(toolOutputs = []) {
  if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) return null;
  const threads = new Set();
  for (const output of toolOutputs) {
    const callId = output?.callId;
    if (!callId) continue;
    const pending = this.pendingToolCalls.get(String(callId));
    if (pending?.threadId) threads.add(String(pending.threadId));
  }
  if (threads.size === 0) return null;
  if (threads.size > 1) {
    throw new TransportError("tool outputs span multiple threads", {
      code: "tool_outputs_multi_thread",
      retryable: false,
    });
  }
  const threadId = Array.from(threads)[0];
  return { threadId, toolset: this.threadToolSets.get(threadId) ?? null };
}
```

Also register tools when a thread is started in `#ensureConversation`:
```js
this.registerThreadTools(threadId, {
  dynamicTools,
  baseInstructions: basePayload.baseInstructions ?? null,
  developerInstructions: basePayload.developerInstructions ?? null,
});
```

Clear map on shutdown:
```js
this.threadToolSets.clear();
```

**Step 4: Run the test to confirm pass**

Run:
```bash
npx vitest run tests/unit/services/json-rpc-transport.spec.js -t "resolves thread id"
```
Expected: PASS.

**Step 5: Commit**

Run:
```bash
git add src/services/transport/index.js tests/unit/services/json-rpc-transport.spec.js
git commit -m "fix: track thread tools for tool outputs"
```

---

### Task 3: Reuse Thread/Tools When Tool Outputs Arrive (stream)

**Files:**
- Modify: `src/handlers/responses/stream.js`
- Test: `tests/unit/handlers/responses/stream.spec.js`

**Step 1: Write failing test for thread reuse**

Add to `tests/unit/handlers/responses/stream.spec.js`:
```js
it("reuses threadId and tool manifest when tool outputs are present", async () => {
  const transport = getJsonRpcTransport();
  transport.pendingToolCalls.set("call_1", { callId: "call_1", threadId: "thread-123" });
  transport.threadToolSets.set("thread-123", {
    dynamicTools: [{ name: "webSearch", description: "", inputSchema: {} }],
  });

  // Build request with tool output
  const body = {
    model: "gpt-5.2-codev-L",
    input: [
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ],
    tools: [{ type: "function", function: { name: "getFileTree" } }],
  };

  const res = await runResponsesStream(body); // helper in test utils

  expect(res.debug.turnPayload.threadId).toBe("thread-123");
  expect(res.debug.turnPayload.dynamicTools).toEqual(
    transport.threadToolSets.get("thread-123").dynamicTools
  );
});
```
Expected: FAIL (no thread/tool override).

**Step 2: Run test to confirm failure**

Run:
```bash
npx vitest run tests/unit/handlers/responses/stream.spec.js -t "reuses threadId"
```
Expected: FAIL.

**Step 3: Implement thread/tool override in stream handler**

In `src/handlers/responses/stream.js` before `createJsonRpcChildAdapter`:
```js
const transport = getJsonRpcTransport();
let resolvedThread = null;
try {
  resolvedThread = transport.resolveThreadForToolOutputs(normalized.toolOutputs);
} catch (err) {
  throw mapTransportError(err);
}
if (resolvedThread?.threadId) {
  turn.threadId = resolvedThread.threadId;
  if (resolvedThread.toolset?.dynamicTools) {
    turn.dynamicTools = resolvedThread.toolset.dynamicTools;
    message.dynamicTools = resolvedThread.toolset.dynamicTools;
  }
  if (resolvedThread.toolset?.baseInstructions) {
    turn.baseInstructions = resolvedThread.toolset.baseInstructions;
  }
  if (resolvedThread.toolset?.developerInstructions) {
    turn.developerInstructions = resolvedThread.toolset.developerInstructions;
  }
}
```

Also update `adapterBody.tools` to prefer the resolved toolset when present:
```js
const effectiveTools = resolvedThread?.toolset?.dynamicTools ?? normalized.tools ?? originalBody.tools;
const adapterBody = { ...originalBody, tools: effectiveTools, tool_choice: normalized.toolChoice ?? originalBody.tool_choice };
```

**Step 4: Run test to confirm pass**

Run:
```bash
npx vitest run tests/unit/handlers/responses/stream.spec.js -t "reuses threadId"
```
Expected: PASS.

**Step 5: Commit**

Run:
```bash
git add src/handlers/responses/stream.js tests/unit/handlers/responses/stream.spec.js
git commit -m "fix: reuse thread tools when tool outputs arrive"
```

---

### Task 4: Mirror Thread/Tools Reuse in nonstream handler

**Files:**
- Modify: `src/handlers/responses/nonstream.js`
- Test: `tests/unit/handlers/responses/nonstream.spec.js`

**Step 1: Write failing test**

Add to `tests/unit/handlers/responses/nonstream.spec.js`:
```js
it("reuses threadId and tool manifest for nonstream tool outputs", async () => {
  const transport = getJsonRpcTransport();
  transport.pendingToolCalls.set("call_1", { callId: "call_1", threadId: "thread-123" });
  transport.threadToolSets.set("thread-123", {
    dynamicTools: [{ name: "webSearch", description: "", inputSchema: {} }],
  });

  const body = {
    model: "gpt-5.2-codev-L",
    input: [
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ],
    tools: [{ type: "function", function: { name: "getFileTree" } }],
  };

  const res = await runResponsesNonstream(body);
  expect(res.debug.turnPayload.threadId).toBe("thread-123");
});
```
Expected: FAIL.

**Step 2: Implement same override logic in nonstream handler**

Mirror Task 3 logic in `src/handlers/responses/nonstream.js` before calling child adapter.

**Step 3: Run test to confirm pass**

Run:
```bash
npx vitest run tests/unit/handlers/responses/nonstream.spec.js -t "reuses threadId"
```
Expected: PASS.

**Step 4: Commit**

Run:
```bash
git add src/handlers/responses/nonstream.js tests/unit/handlers/responses/nonstream.spec.js
git commit -m "fix: reuse thread tools for nonstream tool outputs"
```

---

### Task 5: Add Guardrail When Tool Outputs Lack Thread Mapping

**Files:**
- Modify: `src/handlers/responses/stream.js`, `src/handlers/responses/nonstream.js`
- Test: `tests/unit/handlers/responses/stream.spec.js`

**Step 1: Add failing test for missing tool call mapping**

```js
it("returns 400 when tool outputs arrive without a known thread", async () => {
  const body = {
    model: "gpt-5.2-codev-L",
    input: [{ type: "function_call_output", call_id: "unknown", output: "ok" }],
  };
  const res = await runResponsesStream(body);
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("tool_outputs_unmatched");
});
```
Expected: FAIL.

**Step 2: Implement guard**

In stream/nonstream handlers, when `normalized.toolOutputs.length > 0` and `resolveThreadForToolOutputs` returns null:
```js
throw invalidRequestBody("input", "tool outputs do not match any active tool call", "tool_outputs_unmatched");
```

**Step 3: Run tests**

Run:
```bash
npx vitest run tests/unit/handlers/responses/stream.spec.js -t "tool outputs arrive without"
```
Expected: PASS.

**Step 4: Commit**

Run:
```bash
git add src/handlers/responses/stream.js src/handlers/responses/nonstream.js tests/unit/handlers/responses/stream.spec.js
git commit -m "fix: reject unmatched tool outputs"
```

---

### Task 6: Update Docs

**Files:**
- Modify: `docs/api/responses.md`
- Modify: `docs/responses-endpoint/obsidian-tool-call-simulation.md`

**Step 1: Document thread reuse requirement**

Add a short section:
```md
### Tool Outputs and Thread Continuity
When a client submits `function_call_output` items, the proxy resolves the originating app-server thread and reuses its tool manifest and instructions. Tool outputs that do not map to an active tool call are rejected with `tool_outputs_unmatched`.
```

**Step 2: Run doc lint (if needed)**

Run:
```bash
npm run lint:runbooks
```
Expected: PASS (or no changes needed).

**Step 3: Commit**

Run:
```bash
git add docs/api/responses.md docs/responses-endpoint/obsidian-tool-call-simulation.md
git commit -m "docs: clarify tool output thread continuity"
```

---

## Validation Checklist
- `npx vitest run tests/unit/services/json-rpc-transport.spec.js -t "resolves thread id"`
- `npx vitest run tests/unit/handlers/responses/stream.spec.js -t "reuses threadId"`
- `npx vitest run tests/unit/handlers/responses/nonstream.spec.js -t "reuses threadId"`
- `npx vitest run tests/unit/handlers/responses/stream.spec.js -t "tool outputs arrive without"`

