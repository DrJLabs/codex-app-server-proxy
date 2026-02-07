# Proto Deprecation Design

**Status:** Completed — proto backend and `/v1/completions` are removed; app-server JSON-RPC is the only backend.

## Summary
Removed the legacy `codex proto` backend and the `/v1/completions` endpoint. The proxy is JSON-RPC (app-server) only. `PROXY_USE_APP_SERVER=false` is a hard disable that returns 503 instead of falling back to proto. Proto-only shims, fixtures, and parity harnesses are removed. The deterministic JSON-RPC shim remains as the sole CI/test backend.

## Goals
- Eliminate proto runtime and test dependencies without changing app-server behavior.
- Reduce backend branching to a single supported transport (JSON-RPC).
- Remove `/v1/completions` to align with current client expectations and shrink surface area.
- Keep a safe explicit disable switch (`PROXY_USE_APP_SERVER=false`) that returns `app_server_disabled`.

## Non-goals
- No changes to `/v1/chat/completions` or `/v1/responses` schemas.
- No auth, rate limit, or tracing semantic changes beyond removing proto-only references.
- No replacement endpoint for `/v1/completions`.
- No renaming of proto log fields (legacy naming remains for now).

## Previous State (pre-deprecation)
- Proxy supported two backend modes: JSON-RPC app-server and legacy proto.
- Proto path spawned per-request `codex proto` processes with separate idle and debug flags.
- CI included proto shims and parity fixtures for legacy protocol behavior.
- Docs and runbooks referenced proto fallback as an available mode.
- `/v1/completions` was still routed and rate-limited, despite responses-first client usage.

## Implemented Changes
### 1) Backend mode reduction
- `PROXY_USE_APP_SERVER=true` selects JSON-RPC worker path.
- `PROXY_USE_APP_SERVER=false` returns `503 app_server_disabled` immediately.
- Remove proto-specific env flags (`PROXY_PROTO_IDLE_MS`, `PROXY_DEBUG_PROTO`).

### 2) Route surface cleanup
- Remove `/v1/completions` routes and associated tests.
- Preserve `/v1/chat/completions` and `/v1/responses` as-is.

### 3) Test and tooling cleanup
- Remove deterministic proto shims, parity fixtures, and proto transcript generation.
- Use `scripts/fake-codex-jsonrpc.js` for all test scenarios (stream hangs, token count only, tool calls).
- Keep JSON-RPC schema validation and e2e coverage unchanged.

### 4) Documentation updates
- Remove proto-mode references from docs/runbooks.
- Document `/v1/completions` removal and migration expectations.

## Architecture (App-Server Only)
Request → Express route → handler → JSON-RPC adapter → app-server worker → SSE/non-stream output. No alternate protocol path exists. When app-server is disabled, handlers respond with 503 immediately. Worker readiness gating and tracing remain unchanged.

## Compatibility Impact
- Clients calling `/v1/completions` will receive 404/route not found. Migration path is `/v1/chat/completions` or `/v1/responses`.
- Any configuration that depended on proto fallback now yields `app_server_disabled` (503) when app-server is off.

## Configuration Changes
- Remove proto-only env flags from docs and examples.
- Preserve `PROXY_USE_APP_SERVER` as the single backend switch.
- Keep `PROTO_LOG_PATH` naming for now (follow-up cleanup optional).

## Testing Strategy
- `npm run test:unit` and `npm run test:integration` using JSON-RPC shim only.
- Ensure multi-choice tool-call scenarios are covered with JSON-RPC shim variants.
- E2E and contract tests should remain green without proto fixtures.

## Rollout Notes
1) Landed code removal + doc updates in a single release.
2) Monitored access logs for `/v1/completions` traffic during rollout.
3) Communicated migration guidance where client traffic appeared.

## Risks & Mitigations
- **Client breakage on `/v1/completions`**: mitigate by monitoring logs and documenting migration.
- **Hidden proto-only behaviors**: mitigate with expanded JSON-RPC shim scenarios and existing integration tests.
- **Operational confusion with `PROTO_LOG_PATH`**: document it as legacy naming; consider a follow-up rename.

## Open Questions
- None for this phase.
