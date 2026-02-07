# App-Server Auth Signal + Login/Logout (proxy plan)

## Goal
- Detect app-server auth expiry and return an explicit auth error instead of silent failures.
- Preserve OpenAI-compatible error shapes for both streaming and non-streaming routes.
- Provide a path to use the app-server login/logout RPCs when auth is required.

## Context
- The app-server emits JSON-RPC error notifications with `codexErrorInfo: "unauthorized"` when auth is required.
- The app-server exposes account RPCs: `account/read`, `account/login/start`,
  `account/login/completed`, `account/login/cancel`, `account/logout`, `account/updated`.
- The proxy currently logs JSON-RPC `error` notifications but does not convert them
  into client-facing auth errors.

## Constraints
- Maintain OpenAI-compatible responses (error shape and `[DONE]` handling).
- Do not leak secrets or raw auth details in logs or responses.
- Keep behavior feature-flagged where it could affect production clients.

## Options

### Option A (status quo + map existing errors)
- Only map transport errors that already bubble up as failures.
- Pros: minimal change.
- Cons: misses the explicit app-server `unauthorized` signal (still silent failures).

### Option B (selected) - treat app-server `unauthorized` as auth-required
- Detect JSON-RPC `error` notifications with `codexErrorInfo: "unauthorized"`
  and convert them to a proxy `auth_required` error.
- Pros: uses the explicit app-server signal, clear client behavior.
- Cons: requires careful stream handling to avoid partial responses.

### Option C (optional follow-on) - auto-login handshake
- On `auth_required`, call `account/login/start` to get a login URL and surface it
  in the error response for the client to open.
- Pros: one-step remediation path for clients.
- Cons: needs UI/flow decisions and tight response-shape control.

## Selected approach
Option B (detect and surface `unauthorized` as `auth_required`), with Option C
kept as a flagged extension.

## Implementation plan (Option B)

### 1) Transport error mapping
- Add an auth-specific mapping in `src/services/transport/index.js` so
  `TransportError("auth_required")` becomes a 401 using `authErrorBody()`
  from `src/lib/errors.js`.
- Ensure both chat and responses handlers use the same mapping.

### 2) Detect unauthorized error notifications
- In `src/services/transport/child-adapter.js`, when a JSON-RPC notification has:
  - `method: "error"`
  - `params.codexErrorInfo === "unauthorized"`
  - `params.willRetry === false` or missing/undefined
  then raise a `TransportError("auth_required")` so the request fails fast.
- For streaming responses, document the exact SSE sequence: emit a single
  error event with the OpenAI-compatible error body, then emit `[DONE]`.
  The HTTP status stays `200` because headers are already sent.

### 3) Tests and fixtures
- Unit test: `tests/unit/services/json-rpc-transport.spec.js` covering
  `auth_required` mapping to 401.
- Integration test: `tests/integration/json-rpc-transport.int.test.js` using a
  fake app-server signal.
- Extend `scripts/fake-codex-jsonrpc.js` with an env flag aligned to existing
  `FAKE_CODEX_*` naming (e.g. `FAKE_CODEX_UNAUTHORIZED=1`) to emit the
  `unauthorized` error notification.

### 4) Logging and observability
- Add a structured log field for auth-required detection
  (e.g. `auth_required: true` and `codex_error_info: "unauthorized"`).
- Keep logs metadata-only (no auth tokens or URLs); if a login URL is returned
  to the client, it must not appear in logs.

## Optional extension (Option C)
- Feature flag (example: `PROXY_AUTH_LOGIN_URL=true`).
- On `auth_required`, call `account/login/start` via the existing JSON-RPC
  worker channel (`#callWorkerRpc` in `src/services/transport/index.js`).
- If a login URL is returned, include it under a safe `error.details.auth_url`
  field in the response while keeping the OpenAI error shape intact.
- Decide how the client completes login:
  - Option C1 (preferred): client opens URL and retries; no additional proxy endpoint.
  - Option C2: add a small proxy endpoint to forward `account/login/completed`
    and `account/logout` for UI-driven flows if the client requires it.

## Definition of done
- Unauthorized app-server signals produce a stable OpenAI error shape.
- Non-streaming returns HTTP 401; streaming injects the error into the 200 OK SSE
  stream and then terminates with `[DONE]`.
- Tests cover the mapping and detection paths.
- Optional login URL is behind a feature flag and documented if implemented.

## Rollout
1. Ship Option B behind a short-lived flag and enable in dev.
2. Verify logs show `auth_required` on expired tokens with no spike in 5xx or
   client retries for valid sessions.
3. Enable in prod and monitor client error rates and auth refresh behavior.
4. Roll back the flag if auth errors spike unexpectedly or clients fail to recover.
5. Evaluate Option C after confirmation of client needs.
