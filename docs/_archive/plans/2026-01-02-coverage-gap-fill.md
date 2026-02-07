# Coverage Gap Fill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Raise branch coverage to >= 75% by expanding unit tests around JSON-RPC transport/adapter flows, tool-call aggregation, and responses/chat streaming edge cases.

**Architecture:** Focus on exercising branch-heavy helpers with small, isolated unit tests. Prefer stubbing worker I/O and transport internals to trigger specific branches without altering production code. Re-run unit coverage after each cluster and continue to the next task until branch coverage meets the threshold.

**Tech Stack:** Node.js, Vitest, v8 coverage (vitest run tests/unit --coverage)

---

### Task 1: JsonRpcChildAdapter edge-case coverage

**Files:**
- Modify: `tests/unit/services/json-rpc-child-adapter.spec.js`

**Step 1: Write the failing tests**

```js
it("ignores duplicate writes and falls back on invalid JSON", async () => {
  const { adapter, context } = await setupAdapter();

  adapter.stdin.write("{not json");
  adapter.stdin.write(JSON.stringify({ prompt: "ignored" }));
  await flushAsync();

  expect(transport.createChatRequest).toHaveBeenCalledTimes(1);
  expect(transport.sendUserMessage).toHaveBeenCalledWith(
    context,
    expect.objectContaining({
      items: [{ type: "text", data: { text: "" } }],
    })
  );
});

it("honors normalizedRequest and forwards unknown notifications", async () => {
  const normalizedRequest = {
    turn: { items: [], text: "turn text" },
    message: { items: [], text: "message text" },
  };
  const { adapter, emitter, context, stdout, resolvePromise } = await setupAdapter({
    normalizedRequest,
  });

  adapter.stdin.write(JSON.stringify({ prompt: "hello" }));
  await flushAsync();

  emitter.emit("notification", { method: "custom_event", params: { ok: true } });
  await flushAsync();

  expect(transport.sendUserMessage).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ items: [{ type: "text", data: { text: "hello" } }] })
  );
  expect(transport.sendUserMessage.mock.calls[0][1].text).toBeUndefined();
  expect(stdout).toContainEqual({ type: "custom_event", msg: { ok: true } });

  resolvePromise();
  await flushAsync();
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/services/json-rpc-child-adapter.spec.js -t "duplicate writes"`
Expected: FAIL if branch paths are not covered yet

**Step 3: Add any minimal test helpers needed**

```js
// If needed, add a helper in the test file to assert notifications without duplicating setup.
const collectStdout = (adapter) => {
  const items = [];
  adapter.stdout.on("data", (chunk) => {
    const trimmed = String(chunk || "").trim();
    if (trimmed) items.push(JSON.parse(trimmed));
  });
  return items;
};
```

**Step 4: Run the full adapter unit file**

Run: `npx vitest run tests/unit/services/json-rpc-child-adapter.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/services/json-rpc-child-adapter.spec.js
git commit -m "test: cover json-rpc child adapter edge cases"
```

---

### Task 2: JsonRpcTransport branch coverage for conversation setup

**Files:**
- Modify: `tests/unit/services/json-rpc-transport.spec.js`

**Step 1: Write the failing tests**

```js
it("skips newConversation when explicit conversation_id is provided", async () => {
  const child = createMockChild();
  const methods = [];
  wireJsonResponder(child, (message) => {
    methods.push(message.method);
    if (message.method === "initialize") {
      writeRpcResult(child, message.id, { result: {} });
    }
    if (message.method === "sendUserTurn") {
      writeRpcResult(child, message.id, { result: { conversation_id: "explicit" } });
    }
  });
  __setChild(child);

  const transport = getJsonRpcTransport();
  const context = await transport.createChatRequest({
    requestId: "req-explicit",
    turnParams: { conversation_id: "explicit" },
  });
  context.emitter.on("error", () => {});

  expect(methods).toContain("sendUserTurn");
  expect(methods).not.toContain("newConversation");
  transport.cancelContext(context, new TransportError("request aborted", { code: "request_aborted" }));
});

it("throws worker_invalid_response when newConversation lacks an id", async () => {
  const child = createMockChild();
  wireJsonResponder(child, (message) => {
    if (message.method === "initialize") {
      writeRpcResult(child, message.id, { result: {} });
    }
    if (message.method === "newConversation") {
      writeRpcResult(child, message.id, { result: {} });
    }
  });
  __setChild(child);

  const transport = getJsonRpcTransport();
  await expect(
    transport.createChatRequest({ requestId: "req-missing" })
  ).rejects.toMatchObject({ code: "worker_invalid_response" });
});

it("aborts immediately when signal is already aborted", async () => {
  const child = createMockChild();
  wireJsonResponder(child, (message) => {
    if (message.method === "initialize") {
      writeRpcResult(child, message.id, { result: {} });
    }
  });
  __setChild(child);

  const transport = getJsonRpcTransport();
  const controller = new AbortController();
  controller.abort();

  await expect(
    transport.createChatRequest({ requestId: "req-abort", signal: controller.signal })
  ).rejects.toMatchObject({ code: "request_aborted" });
});
```

**Step 2: Run the targeted tests**

Run: `npx vitest run tests/unit/services/json-rpc-transport.spec.js -t "explicit conversation"`
Expected: FAIL until branches are covered

**Step 3: Adjust mocks if needed**

```js
// Ensure wireJsonResponder collects method names and responds only to relevant RPCs.
```

**Step 4: Run the full transport unit file**

Run: `npx vitest run tests/unit/services/json-rpc-transport.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/services/json-rpc-transport.spec.js
git commit -m "test: cover json-rpc transport conversation branches"
```

---

### Task 3: Tool-call aggregator branch coverage

**Files:**
- Modify: `tests/unit/tool-call-aggregator.test.ts`

**Step 1: Write the failing tests**

```ts
it("warns once when a custom matcher throws", () => {
  const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const unregister = registerTextPattern("badMatcher", () => {
    throw new Error("boom");
  });

  const result = extractUseToolBlocks("<use_tool><name>x</name></use_tool>", 0);
  expect(result.blocks.length).toBeGreaterThan(0);
  expect(warnSpy).toHaveBeenCalled();

  unregister();
  warnSpy.mockRestore();
});

it("handles malformed JSON inside use_tool blocks", () => {
  const aggregator = createToolCallAggregator({ idFactory: deterministicIdFactory });
  const payload = "<use_tool>{not-json}</use_tool>";
  const result = aggregator.ingestMessage(
    { message: { content: payload } },
    { emitIfMissing: true }
  );
  expect(result.updated).toBe(true);
  expect(result.deltas[0].function.arguments).toBe("{}");
});
```

**Step 2: Run the targeted tests**

Run: `npx vitest run tests/unit/tool-call-aggregator.test.ts -t "warns once"`
Expected: FAIL until branches are covered

**Step 3: Adjust test setup if needed**

```ts
// If process.emitWarning is undefined in the test runtime, fallback to console.warn spy.
```

**Step 4: Run the full aggregator unit file**

Run: `npx vitest run tests/unit/tool-call-aggregator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/tool-call-aggregator.test.ts
git commit -m "test: cover tool-call aggregator edge branches"
```

---

### Task 4: Responses nonstream handler branches

**Files:**
- Modify: `tests/unit/handlers/responses/nonstream.spec.js`

**Step 1: Write the failing tests**

```js
it("accepts numeric-string n and applies fallback max_tokens", async () => {
  const { postResponsesNonStream } = await import(
    "../../../../src/handlers/responses/nonstream.js"
  );
  const req = makeReq({ input: "hello", n: "2" });
  const res = makeRes();
  postChatNonStreamMock.mockImplementation(async (callReq) => {
    expect(callReq.body.n).toBe(2);
    expect(callReq.body.instructions).toBeUndefined();
    expect(callReq.body.input).toBeUndefined();
  });

  await postResponsesNonStream(req, res);

  expect(postChatNonStreamMock).toHaveBeenCalled();
});

it("skips error response when headers already sent", async () => {
  const { postResponsesNonStream } = await import(
    "../../../../src/handlers/responses/nonstream.js"
  );
  const req = makeReq({ input: "hello" });
  const res = makeRes();
  res.headersSent = true;
  postChatNonStreamMock.mockRejectedValueOnce(new Error("boom"));

  await postResponsesNonStream(req, res);

  expect(res.json).not.toHaveBeenCalled();
});

it("cleans up listeners when res.off is unavailable", async () => {
  const { postResponsesNonStream } = await import(
    "../../../../src/handlers/responses/nonstream.js"
  );
  const req = makeReq({ input: "hello" });
  const res = makeRes();
  delete res.off;
  const removeListenerSpy = vi.spyOn(res, "removeListener");

  await postResponsesNonStream(req, res);
  res.emit("finish");

  expect(removeListenerSpy).toHaveBeenCalled();
});
```

**Step 2: Run the targeted tests**

Run: `npx vitest run tests/unit/handlers/responses/nonstream.spec.js -t "numeric-string"`
Expected: FAIL until branches are covered

**Step 3: Adjust mocks if needed**

```js
// Ensure makeRes includes removeListener when res.off is deleted.
```

**Step 4: Run the full handler unit file**

Run: `npx vitest run tests/unit/handlers/responses/nonstream.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/handlers/responses/nonstream.spec.js
git commit -m "test: cover responses nonstream branch paths"
```

---

### Task 5: Chat stream invalid-choice branches

**Files:**
- Modify: `tests/unit/handlers/chat/stream.spec.js`

**Step 1: Write the failing test**

```js
it("returns 400 when n is out of bounds", async () => {
  const { postChatStream } = await import("../../../../src/handlers/chat/stream.js");
  const req = buildReq({ n: "999", stream: true, model: "gpt-test" });
  const res = buildRes();

  await postChatStream(req, res);

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalled();
});
```

**Step 2: Run the targeted test**

Run: `npx vitest run tests/unit/handlers/chat/stream.spec.js -t "out of bounds"`
Expected: FAIL until branches are covered

**Step 3: Adjust fixture helpers if needed**

```js
// Ensure buildReq/buildRes helpers handle stream=false defaults and res.json for error responses.
```

**Step 4: Run the full stream unit file**

Run: `npx vitest run tests/unit/handlers/chat/stream.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/handlers/chat/stream.spec.js
git commit -m "test: cover chat stream invalid choice branches"
```

---

### Task 6: Coverage checkpoint

**Files:**
- Read: `coverage/coverage-final.json`

**Step 1: Run unit coverage**

Run: `npm run coverage:unit`
Expected: Branch coverage >= 75%

**Step 2: If still below threshold**

- Add another focused test cluster in `tests/unit/services/json-rpc-transport.spec.js` or `tests/unit/tool-call-aggregator.test.ts` for any remaining uncovered branches.
- Re-run `npm run coverage:unit`.

**Step 3: Commit**

```bash
git add tests/unit/services/json-rpc-transport.spec.js \
  tests/unit/services/json-rpc-child-adapter.spec.js \
  tests/unit/tool-call-aggregator.test.ts \
  tests/unit/handlers/responses/nonstream.spec.js \
  tests/unit/handlers/chat/stream.spec.js

git commit -m "test: close remaining branch coverage gaps"
```
