# V2-Only App Server Protocol Design

**Date:** 2026-01-30

## Goal
Move the proxy to a v2-only JSON-RPC protocol implementation, fully aligned with Codex App Server v2 handshake requirements and parameter shapes.

## Scope
- Handshake uses `initialize` request and **always** follows with `initialized` notification.
- All conversation lifecycle and turn submission uses v2 RPC methods only:
  - `thread/start`
  - `turn/start`
- Remove all v1 RPC methods, parameter builders, and snake_case mirrors.
- Keep request normalization in handlers, but only emit v2 camelCase parameters.

## Out of Scope
- Post-handshake changes beyond v2 handshake completion.
- Any new v2 features beyond the minimum required by the current protocol schema.

## Behavior Changes
- Handshake completes only after sending `initialized` (best-effort, non-fatal on write failure).
- The proxy no longer attempts `newConversation`, `sendUserTurn`, or `sendUserMessage`.
- `RequestContext` is v2-only; protocol switching logic is removed.
- JSON-RPC schema helpers emit v2 camelCase only and drop all snake_case aliases.

## Compatibility Implications
- Older CLI versions that require v1 methods will no longer be supported.
- Clients relying on v1 snake_case fields from the proxy will need to update.

## Verification Plan
- Unit tests validate the `initialized` notification is emitted after successful initialize.
- Transport tests assert `thread/start` and `turn/start` are used for all turns.
- Schema tests validate v2-only params (no v1 builders or snake_case fields).
- Integration tests validate captured RPC payloads are v2-only.

## Rollout Notes
- Update documentation to reflect v2-only support and remove v1 references.
- Run unit + integration test suites for transport and schema validation.
