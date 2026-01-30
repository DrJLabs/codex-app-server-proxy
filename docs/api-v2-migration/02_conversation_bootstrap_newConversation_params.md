# Subtask 02 — Conversation Bootstrap: `thread/start` params for V2

## Reasoning
- **Assumptions**
  - The proxy creates a Codex App Server thread via JSON-RPC `thread/start` from the transport layer.
  - Conversation-scoped parameters must match the Codex JSON-RPC schema implemented in `src/lib/json-rpc/schema.ts` (pinned to Codex CLI protocol v0.92.0).
  - Transport should pass through only supported `ThreadStartParams` fields and rely on `buildThreadStartParams()` for normalization (string trimming, enum normalization, dropping invalid values).
- **Logic**
  - Keep schema ownership centralized in `schema.ts` and avoid duplicating validation logic in transport.
  - Forward all supported v2 conversation-scoped fields (`config`, `dynamicTools`, instruction fields) and drop legacy v1-only params (`compactPrompt`, `includeApplyPatchTool`).

---

## Objective

Ensure the proxy's conversation bootstrap (`thread/start`) payload is aligned with `ThreadStartParams` by:

- forwarding supported conversation-scoped fields from the transport layer
- preserving current normalization behavior (`sandbox`, `approvalPolicy`, instruction trimming)
- forwarding `dynamicTools` (thread-start tool manifest) when provided
- avoiding legacy v1 fields (`compactPrompt`, `includeApplyPatchTool`, snake_case aliases)

---

## Verified current state (repo)

### Schema support
`src/lib/json-rpc/schema.ts` supports these thread-start fields:

- `config?: Record<string, unknown> | null`
- `dynamicTools?: JsonValue[] | null`
- `baseInstructions?: string | null`
- `developerInstructions?: string | null`

### Transport mapping
`src/services/transport/index.js` builds `thread/start` params with `buildThreadStartParams()` and forwards:

- `config`
- `dynamicTools`
- instruction fields

Legacy v1 params are not forwarded.

### Tests
`tests/unit/json-rpc-schema.test.ts` already covers `buildThreadStartParams` behavior for config + dynamicTools passthrough.

---

## Acceptance criteria

- `thread/start` params include `config` and `dynamicTools` when provided by upstream handlers/clients.
- Normalization behavior remains unchanged:
  - sandbox mode normalization accepts string or `{ type | mode }` and drops invalid types.
  - instruction strings are trimmed; empty strings collapse to null/undefined per `schema.ts`.
- No legacy v1 params are emitted in `thread/start`.

---

## Status checklist

- `config` forwarded by transport: **DONE**
- `dynamicTools` forwarded by transport: **DONE**
- legacy params removed (`compactPrompt`, `includeApplyPatchTool`): **DONE**
- schema definition in `schema.ts`: **DONE**
