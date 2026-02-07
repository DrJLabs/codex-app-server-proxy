# Responses Stream Adapter + Require Model Coverage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deterministic unit coverage for the responses stream adapter and require-model guard, while exercising adjacent SSE helper paths.

**Architecture:** Use a lightweight fake Express response to capture SSE output, keep tool-call aggregation mocked for deterministic deltas, and run SSE writes through the real helper to cover formatting. Keep tests isolated to unit scope and avoid real timers or network access.

**Tech Stack:** Node.js, Vitest, existing test helpers, Express-style response stubs.

## Task 1: Add stream adapter test harness

**Files:**
- Create: `tests/unit/handlers/responses/stream-adapter.spec.js`

**Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/services/metrics/index.js", () => ({
  recordResponsesSseEvent: vi.fn(),
}));

vi.mock("../../../src/lib/tool-call-aggregator.js", () => ({
  createToolCallAggregator: () => ({
    ingestDelta: vi.fn(() => ({ updated: false, deltas: [] })),
    ingestMessage: vi.fn(() => ({ updated: false, deltas: [] })),
    snapshot: vi.fn(() => []),
  }),
}));

vi.mock("../../../src/handlers/responses/capture.js", () => ({
  createResponsesStreamCapture: () => ({ record: vi.fn(), finalize: vi.fn() }),
}));

vi.mock("../../../src/services/logging/schema.js", () => ({
  logStructured: vi.fn(),
  sha256: vi.fn(() => "hash"),
  shouldLogVerbose: vi.fn(() => false),
  preview: vi.fn(() => ({ preview: "", truncated: false })),
}));

vi.mock("../../../src/dev-logging.js", () => ({
  appendProtoEvent: vi.fn(),
  LOG_PROTO: false,
}));

const buildRes = () => {
  const chunks = [];
  const res = {
    locals: {},
    writableEnded: false,
    write: (chunk) => {
      chunks.push(String(chunk));
      return true;
    },
    end: () => {
      res.writableEnded = true;
    },
    getChunks: () => chunks.join(""),
  };
  return res;
};

describe("responses stream adapter", () => {
  it("emits response.created and output deltas", async () => {
    const { createResponsesStreamAdapter } = await import(
      "../../../src/handlers/responses/stream-adapter.js"
    );
    const res = buildRes();
    const adapter = createResponsesStreamAdapter(res, { model: "gpt-test" });

    adapter.onChunk({
      id: "chatcmpl-1",
      model: "gpt-test",
      choices: [{ index: 0, delta: { content: "Hello" } }],
    });
    await adapter.onDone();

    expect(res.getChunks()).toContain("event: response.created");
    expect(res.getChunks()).toContain("event: response.output_text.delta");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/handlers/responses/stream-adapter.spec.js`
Expected: FAIL because test file does not exist or imports are missing.

**Step 3: Write minimal implementation**

Create `tests/unit/handlers/responses/stream-adapter.spec.js` with:
- a helper to parse SSE events (`event:` / `data:` pairs)
- a `buildRes()` stub that records output from `writeSseChunk`
- minimal mocks for tool-call aggregation, logging, capture, and metrics

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/handlers/responses/stream-adapter.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/handlers/responses/stream-adapter.spec.js

git commit -m "test: add responses stream adapter coverage"
```

## Task 2: Cover tool-call delta and completion branches

**Files:**
- Modify: `tests/unit/handlers/responses/stream-adapter.spec.js`

**Step 1: Write the failing test**

```javascript
it("emits tool call delta and done events", async () => {
  // set tool-call aggregator mocks to return deltas + snapshot
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/handlers/responses/stream-adapter.spec.js`
Expected: FAIL because expected SSE events are missing.

**Step 3: Write minimal implementation**

- Mock `createToolCallAggregator()` to return:
  - `ingestDelta` that returns `{ updated: true, deltas: [...] }`
  - `snapshot` that returns a completed tool call
- Feed a chunk with `choices[0].delta.tool_calls` to trigger deltas.
- Call `onDone()` to finalize and emit `response.function_call_arguments.done`
  and `response.output_item.done`.
- Assert SSE event order includes `response.output_item.added`,
  `response.function_call_arguments.delta`, and `response.function_call_arguments.done`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/handlers/responses/stream-adapter.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/handlers/responses/stream-adapter.spec.js

git commit -m "test: cover responses stream tool-call events"
```

## Task 3: Cover failure handling and finish status mapping

**Files:**
- Modify: `tests/unit/handlers/responses/stream-adapter.spec.js`

**Step 1: Write the failing test**

```javascript
it("emits response.failed on onChunk error", async () => {
  // send an invalid chunk to trigger error and verify response.failed + done
});

it("marks incomplete when finish_reason length", async () => {
  // send finish_reason: "length" and verify response.completed.status
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/handlers/responses/stream-adapter.spec.js`
Expected: FAIL because events/status not asserted yet.

**Step 3: Write minimal implementation**

- For failure: pass a malformed chunk (e.g., `choices: [{ index: 0, delta: null }]`)
  and assert `response.failed` + `done` are in the SSE stream.
- For finish status: emit a chunk with `finish_reason: "length"` and ensure
  `response.completed` contains `status: "incomplete"`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/handlers/responses/stream-adapter.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/handlers/responses/stream-adapter.spec.js

git commit -m "test: cover responses stream failure and finish status"
```

## Task 4: Add require-model coverage

**Files:**
- Create: `tests/unit/handlers/chat/require-model.spec.js`

**Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi } from "vitest";
import { requireModel } from "../../../src/handlers/chat/require-model.js";

it("returns model when present", () => {
  const model = requireModel({ body: { model: "gpt-test" } });
  expect(model).toBe("gpt-test");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/handlers/chat/require-model.spec.js`
Expected: FAIL because missing behaviors not implemented in test file.

**Step 3: Write minimal implementation**

Add tests for:
- trimmed model returned when provided
- missing model triggers `logUsageFailure` with `statusCode=400` and `errorCode=model_required`
- `applyCors` invoked
- `sendJson` branch and `res.status().json` branch

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/handlers/chat/require-model.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/handlers/chat/require-model.spec.js

git commit -m "test: add require-model coverage"
```

## Task 5: Update coverage tracking

**Files:**
- Modify: `docs/coverage-gaps.md`

**Step 1: Run coverage**

Run: `npm run coverage:unit`
Expected: Coverage report generated (thresholds may still fail).

**Step 2: Update totals + priority list**

- Update `Current totals` with new totals from the run.
- Refresh `Priority targets` with new lowest-coverage entries.

**Step 3: Commit**

```bash
git add docs/coverage-gaps.md

git commit -m "docs: refresh coverage totals"
```
