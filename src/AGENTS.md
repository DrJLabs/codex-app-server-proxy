# Agent instructions (scope: this directory and subdirectories)

## Scope and layout

- **This AGENTS.md applies to:** `src/` and below.
- **Owner:** Proxy API.
- **Key directories:**
  - `config/` env parsing and defaults (`index.js` consumed by `server.js`).
  - `routes/` Express route modules (chat, models, responses, usage, metrics, health).
  - `handlers/` per-route handlers; keep streaming shape aligned with tests.
  - `services/` backend mode selection, JSON-RPC transport, worker supervisor, SSE/tracing/metrics/security checks.
  - `middleware/` request middleware (auth, validation, logging, rate limits).
  - `lib/` helpers (net, tokens, etc.).
  - `dev-trace/`, `dev-logging.js` dev-only tracing/log helpers.
  - `workers/` worker utilities (e.g., CORS preflight logger).

## Architecture (high-level)

- Style: **layered** (HTTP surface + middleware → handlers → services → lib/utils).
- Boundaries:
  - Keep env/config parsing in `config/`; handlers/services consume it via imports, not ad-hoc `process.env`.
  - Handlers should call services and streaming helpers, not reach directly into transport internals.
  - Worker supervisor/transport changes belong under `services/worker` or `services/transport`; routes/handlers stay unaware of process management details.

## Commands (from repo root)

- Dev: `npm run dev` (live reload + app-server supervisor).
- Prod-local: `npm run start` (uses env from `src/config` defaults).
- Tests: `npm run test:unit`, `npm run test:integration`, `npm test` (Playwright shim). Target a single unit file with `npm run test:unit -- <pattern>`.
- Schema check: `npm run jsonrpc:verify` after transport/schema changes.

## Conventions

- Preserve OpenAI-compatible streaming: role-first SSE deltas, terminate with `[DONE]`; update fixtures under `tests/` when behavior changes.
- Backend mode and JSON-RPC transport must gate on `CODEX_HOME`/app-server availability; keep `assertSecureConfig` early in bootstrap.
- Keep environment handling centralized in `src/config`; avoid scattering new env reads.
- Model alias mapping lives in `src/config/models.js`; `/v1/responses` now infers `reasoning.effort`
  from model suffixes when the request omits it. If you change that behavior, update
  `docs/api/responses.md` and `docs/responses-endpoint/overview.md`.
- If changing response/JSON-RPC schemas, also refresh `docs/reference/app-server-protocol.schema.json` via `npm run jsonrpc:bundle` and re-run `npm run jsonrpc:verify`.
- Prefer existing helpers in `services/sse`, `services/metrics`, and `services/tracing` instead of ad-hoc implementations.

## Common pitfalls

- Do not log bearer tokens or Codex CLI secrets; sanitize transport logs.
- Tests rely on the deterministic JSON-RPC shim; update fixtures when altering message/metadata shapes.
- Ensure worker supervisor shutdown hooks stay intact (see `services/worker/supervisor.js`).

## Do not

- Do not bypass `assertSecureConfig` or weaken CORS/auth middleware.
- Do not change route paths/contracts without updating tests and README.

## Verifiable config

```codex-guidelines
{
  "version": 1,
  "format": {
    "autofix": true,
    "commands": ["cd .. && npx prettier -c src/{files}"],
    "windows": [],
    "posix": []
  },
  "lint": {
    "commands": [
      "cd .. && npx eslint --ext .js,.mjs,.ts --no-error-on-unmatched-pattern src/{files}"
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
