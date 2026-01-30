# 03 — Request Path: `turn/start` streaming (v2-only)

## Reasoning
- **Assumptions**
  - API v2 uses a single `turn/start` request for both streaming and non-streaming turns.
  - The proxy must not emit legacy `sendUserTurn` / `sendUserMessage` methods.
  - Tool manifests are accepted only at thread start via `thread/start.dynamicTools`.
- **Logic**
  - Keep request normalization in handlers; transport only forwards v2 shapes.
  - Ensure streaming behavior is driven by app-server notifications, not legacy `sendUserMessage(stream:true)` semantics.

---

## Objective

Align the request path with v2-only JSON-RPC:

- `createChatRequest(...)` ensures `thread/start` + listener, then issues `turn/start`
- no `sendUserTurn` / `sendUserMessage` code paths remain
- streaming and non-streaming both flow through `turn/start`
- tool manifests are forwarded only at `thread/start`

---

## Verified current state (repo)

- `src/services/transport/index.js` issues `thread/start` and `turn/start` only.
- `src/services/transport/child-adapter.js` builds a single `turn/start` payload.
- Handlers emit `outputSchema` for `turn/start` and do not forward legacy message-stage fields.

---

## Acceptance criteria

- `turn/start` is the only per-request JSON-RPC method sent by the proxy.
- Streaming and non-streaming requests produce the same `turn/start` envelope (streaming is driven by notifications).
- Dynamic tool manifests are forwarded once via `thread/start.dynamicTools`.
- No references to `sendUserTurn` / `sendUserMessage` remain in runtime paths or tests.

---

## Status checklist

- `turn/start` only: **DONE**
- `sendUserTurn` / `sendUserMessage` removed: **DONE**
- dynamicTools only on `thread/start`: **DONE**
