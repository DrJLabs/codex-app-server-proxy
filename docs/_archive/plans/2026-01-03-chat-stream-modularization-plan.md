# Chat Stream Modularization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Overview

- Goal: Reduce `src/handlers/chat/stream.js` to an orchestration layer while sharing tool and function-call normalization with nonstream, without changing externally visible behavior.

- Architecture: Add a small stream runtime and transport wiring layer, and centralize tool and function-call normalization into a shared module. Keep `stream-output.js` as the output coordinator and make `stream.js` orchestrate request validation, backend wiring, timers, and response close only.

- Tech Stack: Node.js (ESM), Express handlers, Vitest unit tests, Playwright E2E.

## Implementation Tasks

### Task 1: Introduce a stream runtime module

#### Files
- Create: `src/handlers/chat/stream-runtime.js`
- Test: `tests/unit/handlers/chat/stream-runtime.spec.js`

#### Step 1: Write the failing test

```javascript
import { describe, expect, it, vi } from "vitest";
import { createStreamRuntime } from "../../../../src/handlers/chat/stream-runtime.js";

const createOutputStub = () => ({
  emitDelta: vi.fn(),
  emitMessage: vi.fn(),
  emitUsage: vi.fn(),
  emitFinish: vi.fn(),
  emitError: vi.fn(),
});

const createToolNormalizerStub = () => ({
  ingestDelta: vi.fn((payload) => payload),
  ingestMessage: vi.fn((payload) => payload),
  finalize: vi.fn(() => null),
});

describe("stream runtime", () => {
  it("routes delta payloads into output emission", () => {
    const output = createOutputStub();
    const toolNormalizer = createToolNormalizerStub();
    const runtime = createStreamRuntime({
      output,
      toolNormalizer,
      finishTracker: { onDelta: vi.fn(), onMessage: vi.fn(), finalize: vi.fn() },
    });

    runtime.handleDelta({ choiceIndex: 0, delta: { content: "hi" } });

    expect(toolNormalizer.ingestDelta).toHaveBeenCalled();
    expect(output.emitDelta).toHaveBeenCalledWith(0, { content: "hi" });
  });
});
```

#### Step 2: Run test to verify it fails

Run: `npx vitest run tests/unit/handlers/chat/stream-runtime.spec.js`
Expected: FAIL (module not found or missing export)

#### Step 3: Write minimal implementation

```javascript
export const createStreamRuntime = ({ output, toolNormalizer, finishTracker }) => ({
  handleDelta({ choiceIndex, delta }) {
    const normalized = toolNormalizer.ingestDelta(delta);
    finishTracker?.onDelta?.(normalized);
    output.emitDelta(choiceIndex, normalized);
  },
  handleMessage({ choiceIndex, message }) {
    const normalized = toolNormalizer.ingestMessage(message);
    finishTracker?.onMessage?.(normalized);
    output.emitMessage(choiceIndex, normalized);
  },
  handleUsage({ choiceIndex, usage }) {
    output.emitUsage(choiceIndex, usage);
  },
  handleResult({ choiceIndex, finishReason }) {
    output.emitFinish(choiceIndex, finishReason);
  },
  handleError({ choiceIndex, error }) {
    output.emitError(choiceIndex, error);
  },
});
```

#### Step 4: Run test to verify it passes

Run: `npx vitest run tests/unit/handlers/chat/stream-runtime.spec.js`
Expected: PASS

#### Step 5: Commit

```bash
git add src/handlers/chat/stream-runtime.js tests/unit/handlers/chat/stream-runtime.spec.js
git commit -m "feat(chat): add stream runtime skeleton"
```

### Task 2: Centralize tool and function-call normalization

#### Files
- Create: `src/handlers/chat/tool-call-normalizer.js`
- Modify: `src/handlers/chat/tool-buffer.js`
- Modify: `src/handlers/chat/tool-output.js`
- Test: `tests/unit/handlers/chat/tool-call-normalizer.spec.js`

#### Step 1: Write the failing test

```javascript
import { describe, expect, it } from "vitest";
import { createToolCallNormalizer } from "../../../../src/handlers/chat/tool-call-normalizer.js";

const config = {
  maxBlocks: 0,
  stopAfterTools: false,
  suppressTail: false,
  outputMode: "text",
};

describe("tool-call-normalizer", () => {
  it("normalizes legacy function_call into tool_calls", () => {
    const normalizer = createToolCallNormalizer(config);
    const delta = { function_call: { name: "lookup", arguments: "{}" } };

    const normalized = normalizer.ingestDelta(delta);

    expect(normalized.tool_calls).toHaveLength(1);
    expect(normalized.function_call).toBeUndefined();
  });
});
```

#### Step 2: Run test to verify it fails

Run: `npx vitest run tests/unit/handlers/chat/tool-call-normalizer.spec.js`
Expected: FAIL (module not found or function not implemented)

#### Step 3: Write minimal implementation

```javascript
import { createToolCallAggregator } from "../../lib/tool-call-aggregator.js";
import { createToolBufferTracker } from "./tool-buffer.js";

export const createToolCallNormalizer = (config) => {
  const aggregator = createToolCallAggregator();
  const toolBuffer = createToolBufferTracker();
  return {
    ingestDelta(delta) {
      const normalized = { ...delta };
      if (normalized.function_call && !normalized.tool_calls) {
        normalized.tool_calls = [
          { id: "legacy", type: "function", function: normalized.function_call },
        ];
        delete normalized.function_call;
      }
      aggregator.ingestDelta(normalized);
      return normalized;
    },
    ingestMessage(message) {
      return message;
    },
    finalize() {
      return toolBuffer;
    },
  };
};
```

#### Step 4: Run test to verify it passes

Run: `npx vitest run tests/unit/handlers/chat/tool-call-normalizer.spec.js`
Expected: PASS

#### Step 5: Commit

```bash
git add src/handlers/chat/tool-call-normalizer.js tests/unit/handlers/chat/tool-call-normalizer.spec.js
git commit -m "feat(chat): add tool-call normalizer"
```

### Task 3: Add transport wiring for normalized events

#### Files
- Create: `src/handlers/chat/stream-transport.js`
- Test: `tests/unit/handlers/chat/stream-transport.spec.js`

#### Step 1: Write the failing test

```javascript
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { wireStreamTransport } from "../../../../src/handlers/chat/stream-transport.js";

describe("stream transport", () => {
  it("forwards delta events to runtime", () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const runtime = { handleDelta: vi.fn() };

    wireStreamTransport({ child, runtime });

    child.stdout.emit("data", JSON.stringify({ type: "agent_message_delta", msg: { delta: "hi" } }));

    expect(runtime.handleDelta).toHaveBeenCalled();
  });
});
```

#### Step 2: Run test to verify it fails

Run: `npx vitest run tests/unit/handlers/chat/stream-transport.spec.js`
Expected: FAIL

#### Step 3: Write minimal implementation

```javascript
import { parseStreamEventLine } from "./stream-event.js";

export const wireStreamTransport = ({ child, runtime }) => {
  child.stdout.on("data", (chunk) => {
    const parsed = parseStreamEventLine(String(chunk));
    if (!parsed) return;
    if (parsed.type === "agent_message_delta") {
      runtime.handleDelta({
        choiceIndex: parsed.baseChoiceIndex ?? 0,
        delta: parsed.messagePayload,
      });
    }
  });
};
```

#### Step 4: Run test to verify it passes

Run: `npx vitest run tests/unit/handlers/chat/stream-transport.spec.js`
Expected: PASS

#### Step 5: Commit

```bash
git add src/handlers/chat/stream-transport.js tests/unit/handlers/chat/stream-transport.spec.js
git commit -m "feat(chat): add stream transport wiring"
```

### Task 4: Extract stream timer management

#### Files
- Create: `src/handlers/chat/stream-timers.js`
- Test: `tests/unit/handlers/chat/stream-timers.spec.js`

#### Step 1: Write the failing test

```javascript
import { describe, expect, it, vi } from "vitest";
import { createStreamTimers } from "../../../../src/handlers/chat/stream-timers.js";

describe("stream timers", () => {
  it("invokes onIdle when idle timer fires", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const timers = createStreamTimers({ idleMs: 1, onIdle });

    timers.startIdleTimer();
    vi.runAllTimers();

    expect(onIdle).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

#### Step 2: Run test to verify it fails

Run: `npx vitest run tests/unit/handlers/chat/stream-timers.spec.js`
Expected: FAIL

#### Step 3: Write minimal implementation

```javascript
export const createStreamTimers = ({ idleMs, onIdle }) => {
  let idleTimer = null;
  return {
    startIdleTimer() {
      idleTimer = setTimeout(() => onIdle(), idleMs);
    },
    stopIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    },
  };
};
```

#### Step 4: Run test to verify it passes

Run: `npx vitest run tests/unit/handlers/chat/stream-timers.spec.js`
Expected: PASS

#### Step 5: Commit

```bash
git add src/handlers/chat/stream-timers.js tests/unit/handlers/chat/stream-timers.spec.js
git commit -m "feat(chat): add stream timer helpers"
```

### Task 5: Rewire stream handler to runtime modules

#### Files
- Modify: `src/handlers/chat/stream.js`
- Modify: `tests/unit/handlers/chat/stream.spec.js`

#### Step 1: Write the failing test

```javascript
import { describe, expect, it, vi } from "vitest";
import { postChatStream } from "../../../../src/handlers/chat/stream.js";
import { createStreamRuntime } from "../../../../src/handlers/chat/stream-runtime.js";

vi.mock("../../../../src/handlers/chat/stream-runtime.js", () => ({
  createStreamRuntime: vi.fn(() => ({
    handleDelta: vi.fn(),
    handleMessage: vi.fn(),
    handleUsage: vi.fn(),
    handleResult: vi.fn(),
    handleError: vi.fn(),
  })),
}));

describe("postChatStream wiring", () => {
  it("creates a stream runtime for orchestration", async () => {
    const req = { method: "POST", body: { stream: true, messages: [] }, headers: {} };
    const res = { locals: {}, status: vi.fn(() => res), json: vi.fn(), set: vi.fn() };

    await postChatStream(req, res);

    expect(createStreamRuntime).toHaveBeenCalled();
  });
});
```

#### Step 2: Run test to verify it fails

Run: `npx vitest run tests/unit/handlers/chat/stream.spec.js -t "creates a stream runtime"`
Expected: FAIL (createStreamRuntime not called)

#### Step 3: Implement the wiring
- Instantiate `createStreamRuntime` and `createToolCallNormalizer` once per request.
- Replace inline delta/message handling with runtime calls.
- Use `wireStreamTransport` to bridge child adapter events to runtime.
- Keep existing error mapping, keepalive, and response close behavior intact.

#### Step 4: Run the focused test

Run: `npx vitest run tests/unit/handlers/chat/stream.spec.js -t "creates a stream runtime"`
Expected: PASS

#### Step 5: Commit

```bash
git add src/handlers/chat/stream.js tests/unit/handlers/chat/stream.spec.js
git commit -m "refactor(chat): rewire stream handler to runtime"
```

### Task 6: Share tool normalization with nonstream

#### Files
- Modify: `src/handlers/chat/nonstream.js`
- Test: `tests/unit/handlers/chat/nonstream.helpers.spec.js`

#### Step 1: Write the failing test

```javascript
import { describe, expect, it } from "vitest";
import { normalizeToolCalls } from "../../../../src/handlers/chat/tool-call-normalizer.js";

describe("nonstream tool normalization", () => {
  it("normalizes function_call into tool_calls", () => {
    const result = normalizeToolCalls({ function_call: { name: "x", arguments: "{}" } });
    expect(result.tool_calls).toHaveLength(1);
    expect(result.function_call).toBeUndefined();
  });
});
```

#### Step 2: Run test to verify it fails

Run: `npx vitest run tests/unit/handlers/chat/nonstream.helpers.spec.js -t "normalizes function_call"`
Expected: FAIL

#### Step 3: Implement shared helper usage
- Add a small helper in `tool-call-normalizer.js` that nonstream can call.
- Replace nonstream inline function_call handling with the shared helper.

#### Step 4: Run the focused test

Run: `npx vitest run tests/unit/handlers/chat/nonstream.helpers.spec.js -t "normalizes function_call"`
Expected: PASS

#### Step 5: Commit

```bash
git add src/handlers/chat/nonstream.js tests/unit/handlers/chat/nonstream.helpers.spec.js
git commit -m "refactor(chat): share tool normalization with nonstream"
```

### Task 7: Remove dead logic and tighten module boundaries

#### Files
- Modify: `src/handlers/chat/stream.js`
- Modify: `src/handlers/chat/stream-output.js`
- Modify: `src/handlers/chat/tool-output.js`

#### Step 1: Write the failing test
- Add or extend a unit test that asserts output ordering (finish before usage when `include_usage=true`) using existing `stream-output` tests.

#### Step 2: Run test to verify it fails

Run: `npx vitest run tests/unit/handlers/chat/stream-output.spec.js -t "finish before usage"`
Expected: FAIL (if new assertion not yet satisfied)

#### Step 3: Remove unused code paths
- Delete now-unneeded inline helpers in `stream.js` that duplicate runtime or tool-call-normalizer logic.
- Ensure `stream-output.js` and `tool-output.js` only receive normalized payloads.

#### Step 4: Run the focused test

Run: `npx vitest run tests/unit/handlers/chat/stream-output.spec.js -t "finish before usage"`
Expected: PASS

#### Step 5: Commit

```bash
git add src/handlers/chat/stream.js src/handlers/chat/stream-output.js src/handlers/chat/tool-output.js tests/unit/handlers/chat/stream-output.spec.js
git commit -m "refactor(chat): tighten stream module boundaries"
```

### Task 8: Full verification

#### Files
- Test: `tests/unit/**`, `tests/integration/**`, `tests/**` (Playwright)

#### Step 1: Run unit tests

Run: `npm run test:unit`
Expected: PASS

#### Step 2: Run integration tests

Run: `npm run test:integration`
Expected: PASS

#### Step 3: Run Playwright suite

Run: `npm test`
Expected: PASS

#### Step 4: Commit verification note

```bash
git status -sb
```
Expected: clean working tree
