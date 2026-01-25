# Agent instructions (scope: this directory and subdirectories)

## Scope and layout

- **This AGENTS.md applies to:** `./` and below.
- **Key directories:**
  - `src/` core proxy logic (app wiring, routes, handlers, services) used by `server.js`.
  - `auth/` Traefik ForwardAuth microservice.
  - `scripts/` dev/ops helpers (dev.sh, smoke, stack snapshot/rollback, port sync).
  - `tests/` unit, integration, parity, and Playwright suites plus fixtures.
  - `docs/` schema exports and runbooks (read only when relevant to the task).
  - `external/` optional local reference clones (ignored by git; see `external/README.md`).
  - `.codev/` (dev Codex HOME) and `.codex-api/` (prod Codex HOME) are gitignored; never commit secrets inside.

## Modules / subprojects

| Module      | Type         | Path    | What it owns                              | How to run                                                             | Tests                                                                    | Docs                          | AGENTS           |
| ----------- | ------------ | ------- | ----------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------- | ---------------- |
| Proxy API   | node/express | `.`     | OpenAI-compatible proxy, workers, scripts | `npm run dev` (live reload + app-server supervisor) or `npm run start` | `npm run test:unit`, `npm run test:integration`, `npm test` (Playwright) | README.md                     | `src/AGENTS.md`  |
| ForwardAuth | node/http    | `auth/` | Traefik bearer auth gate                  | `PROXY_API_KEY=... node auth/server.mjs`                               | curl `/verify`                                                           | README.md (ForwardAuth notes) | `auth/AGENTS.md` |
| Docs        | docs         | `docs/` | Schema exports, runbooks                  | n/a (static)                                                           | `npm run lint:runbooks` if editing                                       | docs/                         | (none)           |

## Cross-domain workflows

- Proxy depends on Codex CLI app-server: dev uses `.codev/` as `CODEX_HOME` (mounted in dev stack), prod uses `.codex-api/`; keep bearer/auth.json in sync across both.
- ForwardAuth shares the same `PROXY_API_KEY` as the proxy; Traefik calls `/verify` on loopback (`127.0.0.1`) before routing to the app.
- Dev stack (`npm run dev:stack:up`) brings up Traefik + auth + proxy on the deterministic JSON-RPC shim unless you point `CODEX_BIN` at a real Codex CLI.
- CI/e2e rely on the deterministic shim (`scripts/fake-codex-jsonrpc.js`); changing stream shape or schema requires updating fixtures under `tests/`.

## Architecture style (why layered here)

- Default style is **layered**: HTTP surface + middleware → handlers → services → lib/utils. It matches the current code and keeps transport/runtime concerns isolated from routing.
- Hex/clean would require adapters/ports and domain layers that don’t exist today; adding them would add ceremony without new guarantees.
- Use module-scoped AGENTS for the specific boundaries (see `src/` and `auth/` for details).

## Verification (preferred commands)

- Default order: `npm run format:check`, `npm run lint`, `npm run test:unit`, `npm run test:integration`, `npm test` (Playwright e2e on shim).
- Full gate: `npm run verify:all` (format, lint, schema verify, unit, integration, Playwright).
- Edge/Traefik changes: run `npm run smoke:dev` (dev stack) or `npm run smoke:prod` on the host before/after deploy.
- Re-run narrow failures with verbose flags only when debugging; keep first run quiet.

## Git workflow

- Use standard branches in the main working tree; do not create or use isolated git worktrees for routine work.
- Do not create a new branch solely for docs-only changes (updates or new docs); use the current branch instead.
- After pushing any updates to a PR branch, immediately comment `@codex review` and `/gemini review` as separate PR comments (do not combine them), and mention in your chat response to the user that the review requests were posted (do not wait for a prompt).

## Docs usage

- Do not open `docs/` unless requested or the task requires it; keep detailed changes in `docs/` rather than this file.
- When behavior or setup changes, update `README.md` plus the affected doc pages and keep `docs/README.md` (index) and `docs/README-root.md` (content snapshot, doc-relative links) in sync.

## Docs layout (canonical entrypoints)

- `docs/README.md` — documentation index (update when adding/removing docs).
- `docs/getting-started.md` — first-run walkthroughs.
- `docs/local-development.md` — local workflows (Node vs shim vs compose).
- `docs/api/overview.md` — endpoint overview + runnable curl examples.
- `docs/api/responses.md` — `/v1/responses` usage notes.
- `docs/api/chat-completions.md` — `/v1/chat/completions` usage notes.
- `docs/configuration.md` — env vars and defaults (source of truth: `src/config/index.js`).
- `docs/deployment/production.md` — production compose + Traefik.
- `docs/ops/runbooks.md` — smoke/snapshot/rollback/backup workflows.
- `docs/observability.md` — logs, metrics, tracing.
- `docs/troubleshooting.md` — common issues and fixes.

## Logging and tracing

- Structured JSON logs go to stdout (access, worker lifecycle, trace/usage summaries); schema in `docs/dev/logging-schema.md`.
- Dev stack streaming logs: `docker logs -f codex-dev-app-dev-1`.
- Proto trace NDJSON goes to `PROTO_LOG_PATH` (default `/tmp/codex-proto-events.ndjson`); in dev stack it maps to `.codev/proto-events.ndjson`. Controlled by `PROXY_LOG_PROTO` and `PROXY_ENV=dev`.
- Usage NDJSON goes to `TOKEN_LOG_PATH` (default `/tmp/codex-usage.ndjson`).
- Sanitizer telemetry goes to `SANITIZER_LOG_PATH` (default `/tmp/codex-sanitizer.ndjson`).
- Capture transcripts (full request/response bodies + stream frames) use `PROXY_CAPTURE_CHAT_TRANSCRIPTS` / `PROXY_CAPTURE_RESPONSES_TRANSCRIPTS`; raw bodies require `PROXY_CAPTURE_CHAT_RAW_TRANSCRIPTS` / `PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS`.
- Default capture locations (host): `test-results/chat-copilot/raw/`, `test-results/chat-copilot/raw-unredacted/`, `test-results/responses-copilot/raw/`, `test-results/responses-copilot/raw-unredacted/`.
- Raw capture files still redact secret headers; each capture includes `metadata.proxy_trace_id` for correlation.
- Access/worker log tail: `docker logs -f codex-dev-app-dev-1` (dev stack) or your process manager stdout for `server.js`.
- Trace event file ops: `PROTO_LOG_PATH` for protocol events (`backend_*`, `tool_block`, etc.); default `/tmp/codex-proto-events.ndjson`.
- Usage aggregation ops: `TOKEN_LOG_PATH` for request/latency/token summaries; `/usage` reads it.
- Sanitizer ops: `SANITIZER_LOG_PATH` stores sanitizer toggles and metadata scrub summaries.
- Capture ops: `PROXY_CAPTURE_CHAT_*` and `PROXY_CAPTURE_RESPONSES_*` write stream JSON to `test-results/*`; `x-proxy-capture-id` pins filenames.
- Exec output staging: `${PROXY_CODEX_WORKDIR}/exec-output/exec-*.txt` (ephemeral, deleted after read).
- Codex CLI home: `CODEX_HOME` (dev `.codev/`, prod `.codex-api/`) may include `proto-events.ndjson` and `http-request-debug.ndjson` when enabled.
- Dev/prod path quick map: dev containers use `/app/test-results/...` for captures (host `test-results/...`) and often set `PROTO_LOG_PATH` under `$CODEX_HOME` (e.g. `/home/node/.codex/proto-events.ndjson`); prod defaults to `/tmp/*.ndjson` unless overridden.
- Grep recipes: `docker logs --since 2h codex-dev-app-dev-1 | rg -n 'responses_title_summary_intercept|responses_title_summary_intercept_error|chat_title_summary_intercept'`; per request id: `docker logs --since 24h codex-dev-app-dev-1 | rg -n '<req_id>'`.

## Global conventions

- Node.js ≥ 22; use `npm` (pnpm/yarn/bun are not used here).
- `@openai/codex` is intentionally pinned; coordinate schema/regression updates before bumping.
- Keep PROXY bearer secrets out of Git; `.codev/` and `.codex-api/` must remain gitignored and writable at runtime.
- Preserve OpenAI-compatible response/stream formats (role-first SSE deltas ending with `[DONE]`); update tests/fixtures when behavior changes.

## Do not

- Do not commit contents of `.codev/` or `.codex-api/` (secrets, rollouts, CLI state).
- Do not change Traefik/ForwardAuth paths or ports without updating compose files and running smoke tests.
- Do not rely on the legacy proto shim for production; it exists only for CI/tests.

## Verifiable config

```codex-guidelines
{
  "version": 1,
  "format": {
    "autofix": true,
    "commands": ["npx prettier -c {files}"],
    "windows": [],
    "posix": []
  },
  "lint": {
    "commands": [
      "npx eslint --ext .js,.mjs,.ts --no-error-on-unmatched-pattern {files}"
    ],
    "windows": [],
    "posix": []
  },
  "test": {
    "commands": [],
    "optional": true,
    "windows": [],
    "posix": []
  },
  "rules": {
    "forbid_globs": [],
    "forbid_regex": []
  }
}
```

## Links to module instructions

- `src/AGENTS.md`
- `auth/AGENTS.md`
