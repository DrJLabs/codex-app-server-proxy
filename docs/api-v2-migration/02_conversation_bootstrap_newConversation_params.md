# Subtask 02 — Conversation Bootstrap: `newConversation` params for V2

## Reasoning:
- **Assumptions**
  - The proxy creates a Codex App Server conversation via JSON-RPC `newConversation` from the transport layer.
  - Conversation-scoped parameters must match the Codex JSON-RPC schema implemented in `src/lib/json-rpc/schema.ts` (pinned to Codex CLI protocol v0.89.0).
  - The transport should pass through only supported `NewConversationParams` fields and rely on `buildNewConversationParams()` for normalization (string trimming, enum normalization, dropping invalid values).
- **Logic**
  - Keep schema ownership centralized in `schema.ts` and avoid duplicating validation logic in transport.
  - Ensure transport forwards *all* supported conversation-scoped fields that clients/handlers may provide (`config`, `compactPrompt`), since `schema.ts` already supports them.
  - Add unit tests for edge cases explicitly called out in the plan (invalid sandbox shapes, config passthrough, compactPrompt passthrough) to prevent regression.

---

## Objective

Ensure the proxy's conversation bootstrap (`newConversation`) payload is fully aligned with the current `NewConversationParams` schema by:

- forwarding *all supported* conversation-scoped fields from the transport layer
- preserving current normalization behavior (`sandbox`, `approvalPolicy`, instruction trimming)
- forwarding `dynamicTools` (thread-start tool manifest) when provided
- expanding unit tests to cover edge cases and optional fields

---

## Verified current state (repo)

### Schema support already exists
`src/lib/json-rpc/schema.ts` already supports these conversation-scoped fields:

- `config?: Record<string, unknown> | null`
- `compactPrompt?: string | null`
- `dynamicTools?: JsonValue[] | null` (v2 thread-start tool definitions)

…and normalizes sandbox modes from either strings or `{ type | mode }` objects while dropping invalid types.

### Transport is missing pass-through fields
`src/services/transport/index.js` builds `conversationParams` for `newConversation` but currently does **not** forward:
- `config`
- `compactPrompt`

Dynamic tool manifests **must** be forwarded via `dynamicTools` so they reach
`newConversation` at thread start (per app-server 0.92 tools schema).

So even though the schema supports these fields, they never reach the worker unless added at the call site.

### Tests cover happy-path only
`tests/unit/json-rpc-schema.test.ts` includes a basic `buildNewConversationParams` test, but does not cover:
- `config` passthrough
- `compactPrompt` passthrough
- invalid `sandbox` types (e.g., boolean)
- legacy sandbox policy objects (e.g., `{ type: "read-only" }`)

---

## Tasks

### 1) Update transport mapping to include missing fields
**File:** `src/services/transport/index.js`  
**Location:** `JsonRpcTransport.#ensureConversation()` conversation bootstrap section (where `conversationParams` is built)

Add `config` and `compactPrompt` (including snake_case alias for `compact_prompt`) to the `buildNewConversationParams()` call:

- `config: basePayload.config`
- `compactPrompt: basePayload.compactPrompt ?? basePayload.compact_prompt`
- `dynamicTools: basePayload.dynamicTools ?? basePayload.dynamic_tools`

Keep existing mapping for `sandbox` (`sandboxPolicy` or `sandbox`) and other fields.

#### Optional: legacy instruction aliasing (only if needed)
If you have any client path that can arrive at transport with legacy top-level instruction keys, you may also map:
- `baseInstructions: basePayload.baseInstructions ?? basePayload.instructions ?? basePayload.system_prompt`

**Note:** for `/v1/chat/completions` and `/v1/responses`, the repo already normalizes instructions earlier (in request normalizers). Do not add this aliasing unless you have evidence it is needed for a specific ingress path.

---

### 2) Expand unit tests for edge cases and new fields
**File:** `tests/unit/json-rpc-schema.test.ts`  
**Location:** near the existing `"builds newConversation params with normalized optional fields"` test

Add tests to assert:

- `config` object is preserved
- `compactPrompt` is preserved
- boolean sandbox is dropped (undefined)
- legacy sandbox objects normalize to a valid mode string

This locks in the behavior already implemented by `normalizeSandboxModeOption()` and `buildNewConversationParams()`.

---

### 3) Quick sanity validation
Run unit tests and ensure no schema regression:

- `npm run test:unit -- tests/unit/json-rpc-schema.test.ts`

(If you rely on AJV schema validation integration tests, also run the integration suite that validates JSON-RPC payloads.)

---

## Suggested patch snippets

### A) Transport: forward `config` and `compactPrompt`

```js
// src/services/transport/index.js
// inside JsonRpcTransport.#ensureConversation()

const conversationParams = buildNewConversationParams({
  model: basePayload.model ?? undefined,
  modelProvider: basePayload.modelProvider ?? basePayload.model_provider ?? undefined,
  profile: basePayload.profile ?? undefined,
  cwd: basePayload.cwd ?? undefined,
  approvalPolicy: basePayload.approvalPolicy ?? basePayload.approval_policy ?? undefined,
  sandbox: basePayload.sandboxPolicy ?? basePayload.sandbox ?? undefined,

  // Added: supported by schema.ts but not forwarded previously
  config: basePayload.config ?? undefined,
  compactPrompt: basePayload.compactPrompt ?? basePayload.compact_prompt ?? undefined,

  baseInstructions: basePayload.baseInstructions ?? undefined,
  developerInstructions: basePayload.developerInstructions ?? undefined,
  includeApplyPatchTool:
    basePayload.includeApplyPatchTool ?? basePayload.include_apply_patch_tool ?? undefined,
});
```

---

### B) Unit tests: add edge cases

```ts
// tests/unit/json-rpc-schema.test.ts
// near the existing buildNewConversationParams test

it("passes through optional config object", () => {
  const config = { featureFlags: { experimental: true } };
  const params = buildNewConversationParams({ config });
  expect(params.config).toEqual(config);
});

it("passes through compactPrompt", () => {
  const params = buildNewConversationParams({ compactPrompt: "true" });
  expect(params.compactPrompt).toBe("true");
});

it("drops invalid sandbox types (e.g. boolean)", () => {
  const params = buildNewConversationParams({
    // @ts-expect-error testing runtime validation
    sandbox: true,
  });
  expect(params.sandbox).toBeUndefined();
});

it("extracts sandbox mode from legacy policy object", () => {
  const params = buildNewConversationParams({
    // @ts-expect-error testing legacy object shape support
    sandbox: { type: "read-only" },
  });
  expect(params.sandbox).toBe("read-only");
});
```

---

## Acceptance criteria

- `newConversation` params include `config` and `compactPrompt` when provided by upstream handlers/clients.
- No change in existing normalization behavior:
  - sandbox mode normalization still accepts string or `{ type | mode }` and drops invalid types.
  - instruction strings are trimmed; empty strings collapse to null/undefined per `schema.ts`.
- Unit tests cover the new passthrough fields and sandbox edge cases.

---

## Status checklist

- `config` forwarded by transport: **TODO**
- `compactPrompt` forwarded by transport: **TODO**
- `dynamicTools` forwarded by transport: **DONE**
- Unit tests for `config`/`compactPrompt`: **TODO**
- Unit tests for sandbox edge cases: **TODO**
- Schema definition in `schema.ts`: **DONE**
- Conversation ID normalization (`conversation_id` vs `conversationId`): **DONE** (existing transport behavior)

---

## Deliverable

A PR that:
- updates `src/services/transport/index.js` to forward `config` + `compactPrompt`
- adds the unit tests above to `tests/unit/json-rpc-schema.test.ts`
- passes unit/integration suites
