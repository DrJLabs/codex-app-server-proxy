# Coverage Gap Fillers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand unit coverage for chat handlers, responses nonstream, and transport guardrails without changing production behavior.

**Architecture:** Add focused unit tests that exercise existing branches and error paths using mocks to avoid external dependencies. Keep tests deterministic and scoped to handler behavior.

**Tech Stack:** Node.js, Vitest, existing handler test harness/mocks.

### Task 1: Chat handlers (stream + nonstream)

**Files:**
- Modify: `tests/unit/handlers/chat/stream.spec.js`
- Modify: `tests/unit/handlers/chat/nonstream.test.js`

**Step 1: Add stream coverage tests**

```js
it("returns 400 when choice count exceeds max", async () => {
  configMock.PROXY_MAX_CHAT_CHOICES = 1;
  const postChatStream = await loadHandler();
  const req = buildReq({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], n: 2 });
  const res = buildRes();

  await postChatStream(req, res);

  expect(res.statusCode).toBe(400);
  expect(res.payload?.error?.param).toBe("n");
});

it("sets output mode headers and locals before normalization error", async () => {
  const { ChatJsonRpcNormalizationError } = await import(
    "../../../../src/handlers/chat/request.js"
  );
  resolveOutputModeMock.mockReturnValue("obsidian-xml");
  normalizeChatJsonRpcRequestMock.mockImplementation(() => {
    throw new ChatJsonRpcNormalizationError({ error: { code: "bad" } }, 422);
  });
  const postChatStream = await loadHandler();
  const req = buildReq({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
  const res = buildRes();

  await postChatStream(req, res);

  expect(res.headers.get("x-proxy-output-mode")).toBe("obsidian-xml");
  expect(res.locals.output_mode_effective).toBe("obsidian-xml");
});
```

**Step 2: Run stream spec**

Run: `npx vitest run tests/unit/handlers/chat/stream.spec.js`
Expected: PASS (coverage-only additions).

**Step 3: Add nonstream assistant message coverage**

```js
test("content_filter forces null assistant content", () => {
  const { message } = buildAssistantMessage({
    snapshot: [],
    choiceContent: "blocked",
    normalizedContent: "blocked",
    canonicalReason: "content_filter",
    isObsidianOutput: true,
  });

  expect(message.content).toBeNull();
});

test("function_call payload sets function_call and null content", () => {
  const { message } = buildAssistantMessage({
    snapshot: [],
    choiceContent: "ignored",
    normalizedContent: "",
    canonicalReason: "stop",
    isObsidianOutput: true,
    functionCallPayload: { name: "lookup", arguments: "{}" },
  });

  expect(message.function_call).toMatchObject({ name: "lookup" });
  expect(message.content).toBeNull();
});
```

**Step 4: Run nonstream spec**

Run: `npx vitest run tests/unit/handlers/chat/nonstream.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add tests/unit/handlers/chat/stream.spec.js tests/unit/handlers/chat/nonstream.test.js
git commit -m "test: expand chat handler coverage"
```

### Task 2: Responses nonstream handler

**Files:**
- Create: `tests/unit/handlers/responses/nonstream.spec.js`

**Step 1: Add nonstream handler tests**

```js
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const postChatNonStreamMock = vi.fn();

vi.mock("../../../../src/handlers/chat/nonstream.js", () => ({
  postChatNonStream: (...args) => postChatNonStreamMock(...args),
}));

vi.mock("../../../../src/handlers/responses/ingress-logging.js", () => ({
  logResponsesIngressRaw: vi.fn(),
  summarizeResponsesIngress: () => ({}),
}));

vi.mock("../../../../src/lib/copilot-detect.js", () => ({
  detectCopilotRequest: () => ({ copilot_detected: false, copilot_detect_tier: null }),
}));

const makeReq = (body) => ({ body, headers: {}, method: "POST" });
const makeRes = () => {
  const res = new EventEmitter();
  res.locals = {};
  res.headersSent = false;
  res.status = vi.fn(() => res);
  res.json = vi.fn();
  res.once = vi.fn((event, handler) => res.on(event, handler));
  res.off = vi.fn((event, handler) => res.removeListener(event, handler));
  return res;
};

it("returns 400 when n is out of range", async () => {
  const { postResponsesNonStream } = await import(
    "../../../../src/handlers/responses/nonstream.js"
  );
  const res = makeRes();
  await postResponsesNonStream(makeReq({ input: "hi", n: 9999 }), res);
  expect(res.status).toHaveBeenCalledWith(400);
});

it("propagates errors from postChatNonStream with status", async () => {
  const { postResponsesNonStream } = await import(
    "../../../../src/handlers/responses/nonstream.js"
  );
  const res = makeRes();
  postChatNonStreamMock.mockRejectedValueOnce({ message: "bad", statusCode: 418 });
  await postResponsesNonStream(makeReq({ input: "hi" }), res);
  expect(res.status).toHaveBeenCalledWith(418);
});
```

**Step 2: Run nonstream handler spec**

Run: `npx vitest run tests/unit/handlers/responses/nonstream.spec.js`
Expected: PASS.

**Step 3: Commit**

```bash
git add tests/unit/handlers/responses/nonstream.spec.js
git commit -m "test: add responses nonstream coverage"
```

### Task 3: Transport guardrails (app-server disabled)

**Files:**
- Create: `tests/unit/services/transport.disabled.spec.js`

**Step 1: Add app-server disabled test**

```js
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/services/backend-mode.js", () => ({
  isAppServerMode: vi.fn(() => false),
}));

vi.mock("../../../src/services/worker/supervisor.js", () => ({
  ensureWorkerSupervisor: vi.fn(),
  getWorkerSupervisor: vi.fn(),
  getWorkerChildProcess: vi.fn(),
  onWorkerSupervisorEvent: vi.fn(() => () => {}),
}));

it("throws when app-server mode is disabled", async () => {
  const { getJsonRpcTransport, TransportError } = await import(
    "../../../src/services/transport/index.js"
  );
  expect(() => getJsonRpcTransport()).toThrow(TransportError);
});
```

**Step 2: Run transport spec**

Run: `npx vitest run tests/unit/services/transport.disabled.spec.js`
Expected: PASS.

**Step 3: Commit**

```bash
git add tests/unit/services/transport.disabled.spec.js
git commit -m "test: cover transport disabled guard"
```

