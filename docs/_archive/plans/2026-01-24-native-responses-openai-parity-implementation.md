# Native Responses OpenAI Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align `/v1/responses` native pipeline with always-flatten JSON-RPC input and update tests/docs to match OpenAI parity (no wrapper helpers, no `previous_response_id` echo).

**Architecture:** Keep the native normalizer that flattens `instructions`/`input` into a role-tagged transcript plus image items, keep capability gating before SSE, and update unit tests + docs to match the native pipeline semantics.

**Tech Stack:** Node.js 22, Express handlers, Vitest unit tests.

### Task 1: Update unit tests for native responses helpers

**Files:**
- Modify: `tests/unit/responses.shared.spec.js`
- Modify: `tests/unit/responses-output-mode.copilot.spec.js`
- Modify: `tests/unit/responses.copilot.capture.spec.js`
- Modify: `tests/unit/handlers/responses/default-max-tokens.spec.js`

**Step 1: Write the failing test updates**
```js
// responses.shared.spec.js: only test normalizeResponseId/normalizeMessageId/output mode header
// responses-output-mode.copilot.spec.js: remove Copilot detection, assert header/default
// responses.copilot.capture.spec.js: normalizeResponsesRequest flattens to transcript text
```

**Step 2: Run unit tests to verify failures**
```bash
npm run test:unit -- tests/unit/responses.shared.spec.js tests/unit/responses-output-mode.copilot.spec.js tests/unit/responses.copilot.capture.spec.js
```
Expected: FAIL (tests still expect removed helpers / old behavior).

**Step 3: Update tests to match native pipeline**
- Remove wrapper helper expectations.
- Validate role-tagged transcript flattening in fixtures.
- Validate output mode resolution = header or default only.

**Step 4: Re-run unit tests**
```bash
npm run test:unit -- tests/unit/responses.shared.spec.js tests/unit/responses-output-mode.copilot.spec.js tests/unit/responses.copilot.capture.spec.js
```
Expected: PASS.

**Step 5: Commit (if requested)**
```bash
git add tests/unit/responses.shared.spec.js tests/unit/responses-output-mode.copilot.spec.js tests/unit/responses.copilot.capture.spec.js
git add tests/unit/handlers/responses/default-max-tokens.spec.js
git commit -m "test: align responses unit coverage with native pipeline"
```

### Task 2: Update responses implementation docs

**Files:**
- Modify: `docs/responses-endpoint/overview.md`
- Modify: `docs/responses-endpoint/codex_ready_logging_spec_ingress_to_egress.md`

**Step 1: Update docs**
- Describe native `/v1/responses` pipeline (no chat wrapper).
- Note `previous_response_id` is accepted but not echoed.
- Remove Copilot output-mode auto-detection from responses docs.

**Step 2: Commit (if requested)**
```bash
git add docs/responses-endpoint/overview.md docs/responses-endpoint/codex_ready_logging_spec_ingress_to_egress.md
git commit -m "docs: align responses endpoint notes with native pipeline"
```

### Task 3: Verification (targeted)

**Step 1: Run focused unit tests**
```bash
npm run test:unit -- tests/unit/responses.shared.spec.js tests/unit/responses-output-mode.copilot.spec.js tests/unit/responses.copilot.capture.spec.js
```
Expected: PASS.

**Step 2: Commit (if requested)**
```bash
git add docs/responses-endpoint/overview.md docs/responses-endpoint/codex_ready_logging_spec_ingress_to_egress.md
git commit -m "chore: verify responses docs/test updates"
```
