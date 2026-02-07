# Logging Gaps Full Tracing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add dev-only full-fidelity logging for `/v1/responses` app-server I/O, raw thinking deltas, tool output logging, and trace id propagation.

**Architecture:** Add new capture writer(s) for app-server raw JSON-RPC and raw thinking deltas, extend JSON-RPC trace context with `trace_id`/`copilot_trace_id`, and emit structured tool-output logs while keeping prod behavior unchanged.

**Tech Stack:** Node.js 22, Express, JSON-RPC transport, Vitest unit tests.

## Pre-flight (do before Task 1)
- Ensure you are on a branch: `git checkout -b fix/logging-gaps`
- Note: repo instructions say do not use git worktrees for routine work.

---

### Task 1: Add config flags for dev-only captures

**Files:**
- Modify: `src/config/index.js`
- Test: `tests/unit/config/proxy-env-overrides.spec.js` or new `tests/unit/config/logging-capture.spec.js`

**Step 1: Write the failing test**
Add a unit test for defaults and overrides:
```js
it("exposes app-server raw capture defaults", async () => {
  const { config } = await import("../../../src/config/index.js");
  expect(config.PROXY_CAPTURE_APP_SERVER_RAW).toBe(false);
  expect(config.PROXY_CAPTURE_APP_SERVER_RAW_DIR).toContain("test-results/app-server/raw");
  expect(config.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES).toBeGreaterThan(0);
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/config/logging-capture.spec.js`
Expected: FAIL (new fields undefined).

**Step 3: Write minimal implementation**
Add new config keys:
```js
PROXY_CAPTURE_APP_SERVER_RAW: bool("PROXY_CAPTURE_APP_SERVER_RAW", "false"),
PROXY_CAPTURE_APP_SERVER_RAW_DIR: str("PROXY_CAPTURE_APP_SERVER_RAW_DIR", path.join(process.cwd(), "test-results", "app-server", "raw")),
PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES: num("PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES", 262144),
PROXY_CAPTURE_THINKING_RAW: bool("PROXY_CAPTURE_THINKING_RAW", "false"),
PROXY_CAPTURE_THINKING_RAW_DIR: str("PROXY_CAPTURE_THINKING_RAW_DIR", path.join(process.cwd(), "test-results", "responses-copilot", "raw-thinking")),
PROXY_CAPTURE_THINKING_RAW_MAX_BYTES: num("PROXY_CAPTURE_THINKING_RAW_MAX_BYTES", 262144),
```

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/config/logging-capture.spec.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/config/index.js tests/unit/config/logging-capture.spec.js
git commit -m "feat: add dev-only capture config flags"
```

---

### Task 2: Add NDJSON raw capture writer

**Files:**
- Create: `src/dev-trace/raw-capture.js`
- Test: `tests/unit/dev-trace-raw-capture.spec.js`

**Step 1: Write the failing tests**
```js
it("writes app-server raw capture in dev", async () => {
  const { appendAppServerRawCapture, __whenRawCaptureIdle } = await import("../../src/dev-trace/raw-capture.js");
  appendAppServerRawCapture({ req_id: "req", payload: { ok: true } });
  await __whenRawCaptureIdle();
  // assert NDJSON file contains payload
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/dev-trace-raw-capture.spec.js`
Expected: FAIL (module missing).

**Step 3: Write minimal implementation**
Implement dev-only gating, size guard, and NDJSON append queue:
```js
export const appendAppServerRawCapture = (entry) => { /* dev-only, append NDJSON */ };
export const appendThinkingRawCapture = (entry) => { /* dev-only, append NDJSON */ };
```

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/dev-trace-raw-capture.spec.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/dev-trace/raw-capture.js tests/unit/dev-trace-raw-capture.spec.js
git commit -m "feat: add dev-only raw capture writer"
```

---

### Task 3: Wire raw capture + trace ids into backend trace events

**Files:**
- Modify: `src/dev-trace/backend.js`
- Test: `tests/unit/dev-trace-backend.spec.js`

**Step 1: Write the failing tests**
```js
it("adds trace ids to backend events", async () => {
  const { logBackendSubmission } = await import("../../src/dev-trace/backend.js");
  logBackendSubmission({ reqId: "req", trace_id: "t", copilot_trace_id: "c" }, { rpcId: 1, method: "m", params: {} });
  expect(appendProtoEventMock.mock.calls[0][0].trace_id).toBe("t");
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/dev-trace-backend.spec.js`
Expected: FAIL (fields missing).

**Step 3: Write minimal implementation**
- Extend `base()` to include `trace_id` and `copilot_trace_id`.
- Call `appendAppServerRawCapture()` for JSON-RPC payloads when `trace.route === "/v1/responses"`.
- Extend `traceFromResponse()` to include trace ids from `res.locals`.

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/dev-trace-backend.spec.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/dev-trace/backend.js tests/unit/dev-trace-backend.spec.js
git commit -m "feat: propagate trace ids in backend events"
```

---

### Task 4: Emit tool output logs (stream + nonstream)

**Files:**
- Modify: `src/handlers/responses/stream.js`
- Modify: `src/handlers/responses/nonstream.js`
- Modify: `src/handlers/responses/native/request.js` (optional tool name passthrough)
- Test: `tests/unit/handlers/responses/stream.spec.js`
- Test: `tests/unit/handlers/responses/nonstream.spec.js`

**Step 1: Write the failing tests**
Add assertions that `logStructured` receives `event: "tool_call_output"` when tool outputs are provided.

**Step 2: Run test to verify it fails**
Run:
- `npm run test:unit -- tests/unit/handlers/responses/stream.spec.js`
- `npm run test:unit -- tests/unit/handlers/responses/nonstream.spec.js`
Expected: FAIL (no tool output log).

**Step 3: Write minimal implementation**
Add logging in `respondToToolOutputs()`:
```js
logStructured({ component: "responses", event: "tool_call_output", level: "debug", req_id: reqId, route, mode }, {
  tool_call_id: callId,
  tool_name: toolOutput.toolName ?? null,
  tool_output_bytes: Buffer.byteLength(toolOutput.output ?? "", "utf8"),
  tool_output_hash: sha256(toolOutput.output ?? ""),
});
```
(Optional) capture tool name in `normalizeResponsesRequest()`.

**Step 4: Run test to verify it passes**
Run the same unit tests as Step 2.

**Step 5: Commit**
```bash
git add src/handlers/responses/stream.js src/handlers/responses/nonstream.js src/handlers/responses/native/request.js \
  tests/unit/handlers/responses/stream.spec.js tests/unit/handlers/responses/nonstream.spec.js
git commit -m "feat: log tool output summaries for responses"
```

---

### Task 5: Raw thinking capture in responses stream

**Files:**
- Modify: `src/handlers/responses/stream.js`
- Test: `tests/unit/handlers/responses/stream.spec.js`

**Step 1: Write the failing test**
Add a stream test that fires a `text_delta` event and asserts `appendThinkingRawCapture()` is called when dev-only flag is enabled.

**Step 2: Run test to verify it fails**
Run: `npm run test:unit -- tests/unit/handlers/responses/stream.spec.js`
Expected: FAIL (capture not invoked).

**Step 3: Write minimal implementation**
Call `appendThinkingRawCapture()` in `handleEvent()` before sanitization for `text_delta` and `text` events.

**Step 4: Run test to verify it passes**
Run: `npm run test:unit -- tests/unit/handlers/responses/stream.spec.js`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/handlers/responses/stream.js tests/unit/handlers/responses/stream.spec.js
git commit -m "feat: add dev-only raw thinking capture"
```

---

### Task 6: Document new capture streams

**Files:**
- Modify: `docs/dev/logging-schema.md`
- (Optional) Modify: `docs/api-v2-migration/logging-gaps.md`

**Step 1: Update documentation**
Document new env flags and capture locations.

**Step 2: Commit**
```bash
git add docs/dev/logging-schema.md docs/api-v2-migration/logging-gaps.md
git commit -m "docs: document dev-only raw capture streams"
```
