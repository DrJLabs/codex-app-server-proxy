# Configuration & Deployment Matrix

Canonicalizes the ForwardAuth entrypoint, environment layout, and infra artifacts so deployment docs stay consistent across local, dev stack, and prod.

## Deployment matrix

| Mode | Entrypoint & auth | CODEX_HOME mount | Workdir | API key source | Bind/ports | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Local Node | `npm run start` / `npm run dev`; in-app bearer auth (ForwardAuth optional) | `.codev/` (recommended for dev) or your `$HOME/.codex-api` | `PROXY_CODEX_WORKDIR` (default `/tmp/codex-work`) | `PROXY_API_KEY` from env/.env | `0.0.0.0:11435` (override with `PORT`/`PROXY_HOST`) | Defaults to `PROXY_SANDBOX_MODE=read-only`; `/v1/models` public unless `PROXY_PROTECT_MODELS=true`. |
| Dev stack (infra/compose/compose.dev.stack.yml) | `npm run dev:stack:up`; Traefik ForwardAuth -> `http://127.0.0.1:18081/verify` served by `auth/server.mjs` | `./.codev` -> `/home/node/.codex` (rw) | `/tmp/codex-work` inside container | `PROXY_API_KEY` from `.env.dev` (also used by ForwardAuth) | App: `127.0.0.1:${DEV_PORT:-18010}` -> 11435; Auth: `127.0.0.1:18081` | Edge routers/middlewares live in Traefik host config; app still enforces bearer defensively. |
| Prod compose (docker-compose.yml) | `docker compose up -d --pull always --force-recreate` (or `npm run prod:stack:up`); Traefik ForwardAuth -> `http://127.0.0.1:18080/verify` served by `auth/server.mjs` | `./.codex-api` -> `/app/.codex-api` (rw) | `/tmp/codex-work` inside container | `PROXY_API_KEY` from `.env` (shared with ForwardAuth) | App: `127.0.0.1:11435`; Auth: `127.0.0.1:18080`; Traefik network `traefik` | Container binds `PROXY_HOST=0.0.0.0` for Traefik reachability; sandbox default stays `read-only`. |

## ForwardAuth canonicalization

- Canonical entrypoint: `auth/server.mjs` (ESM). Compose/dev stack already call this file.
- Legacy CJS entrypoint removed 2025-12-18 after confirming no manifest references.

## Environment knobs to keep consistent

- Required everywhere: `PROXY_API_KEY` (shared between ForwardAuth and the app).
- Auth surface toggles: `PROXY_PROTECT_MODELS`, `PROXY_USAGE_ALLOW_UNAUTH`, `PROXY_TEST_ENDPOINTS`, `PROXY_TEST_ALLOW_REMOTE` (defaults keep models public, usage/test protected and loopback-only).
- Sandbox and workdir: `PROXY_SANDBOX_MODE=read-only` by default; `PROXY_CODEX_WORKDIR` defaults to `/tmp/codex-work` and should stay writable in containers.
- Bind addresses: local Node defaults to `0.0.0.0` (set `PROXY_HOST=127.0.0.1` for loopback-only); containers set `PROXY_HOST=0.0.0.0` for Traefik while Traefik itself calls the app over the external `traefik` network.

## Infra artifacts & external bundles

- `infra/cloudflare/rht*.json` - Cloudflare Response Header Transform exports (CORS/security headers). Keep them in sync with the deployed edge policy; regenerate via Cloudflare exports rather than hand-editing.
- `web-bundles/` - reserved for packaged worker bundles (e.g., from `workers/**`). Currently empty; drop built artifacts here when publishing to the edge.
- `external/` - vendored sources:
  - `external/codex` (git submodule pinned to Codex CLI; update intentionally).
  - `external/codex-cli` (empty staging area for CLI packaging/builds).
  - `external/obsidian-copilot` (vendor copy; not part of the runtime image unless explicitly mounted).
