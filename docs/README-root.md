# Codex App-Server Proxy — OpenAI Responses-first proxy for Codex CLI

Goal: let any OpenAI Responses client (SDKs, IDEs, curl) talk to Codex CLI as if it were a standard model API. `/v1/responses` is the primary endpoint; `/v1/chat/completions` remains for compatibility. The proxy exposes `/v1/models`, `/v1/responses`, and `/v1/chat/completions`, streams with SSE (role-first delta, `[DONE]`), and keeps output shaping minimal so existing tools work without changes.

> **Disclaimer:** This project is an independent community effort and is not affiliated with or endorsed by OpenAI.

## Table of Contents

1. [Features](#features)
2. [Getting Started](#getting-started)
3. [Usage](#usage)
4. [Project Structure](#project-structure-high-level)
5. [Environments](#environments-prod-vs-dev)
6. [Backend Modes](#backend-modes)
7. [Production Smoke](#production-smoke)
8. [Documentation](#documentation)
9. [License](#license)
10. [Contributing](#contributing)
11. [Testing](#testing)
12. [Deployment](#deployment-traefik--cloudflare-docker-compose)

## Features

- OpenAI-compatible routes: `/v1/responses` (primary), `/v1/chat/completions` (legacy/compat), `/v1/models`.
- SSE streaming: role-first delta, then deltas or a final message; always ends with `[DONE]`. Periodic `: keepalive` comments prevent intermediary timeouts.
- App-server JSON-RPC parity: request normalization (`initialize`, `sendUserTurn`, `sendUserMessage`) mirrors the exported Codex schema and is covered by schema and integration tests.
- Minimal shaping: strips ANSI; optional tool-block helpers for clients that parse `<use_tool>` blocks.
- Dev vs Prod model IDs: dev advertises `codev-5*` plus `codev-5.1-{L,M,H}` and `codev-5.2-{L,M,H,XH}` (map to `gpt-5.1` / `gpt-5.2` low/medium/high/xhigh); prod advertises `codex-5*` plus `gpt-5.2-codex-{L,M,H,XH}`. Both prefixes are accepted everywhere.
- Reasoning effort mapping: `reasoning.effort` → `--config model_reasoning_effort="<low|medium|high|xhigh>"` (also passes the legacy `--config reasoning.effort=...` for older CLIs).
- Token usage tracking (approximate): logs estimated prompt/completion tokens per request and exposes query endpoints under `/v1/usage`.
- Connection hygiene: graceful SSE cleanup on disconnect; keepalive/timers cleared; optional child termination on client close.
- Worker supervisor: production and dev run long-lived `codex app-server` workers gated by handshake/readiness timers (see [Backend Modes](#backend-modes)). A deterministic JSON-RPC shim exists for CI and tests.

## Getting Started

### Prerequisites

- Node.js ≥ 22 and npm 10+
- Codex CLI ≥ 0.77.0 for the default app-server workflow (install under `.codev/` for dev or `.codex-api/` for prod)
- `@openai/codex` is intentionally pinned to an exact version (currently 0.77.0) so JSON-RPC schemas and CLI behavior stay deterministic across dev/prod; bump only after coordinating schema/regression updates.
- Docker + Docker Compose v2 (optional but recommended for parity with production)
- `curl`/`jq` for quick health checks

### Quick Start (Production, local Obsidian Copilot)

Use this when you want to run the proxy on the same machine as Obsidian Copilot (default port `11435`).

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Prepare the production Codex HOME:

   ```bash
   mkdir -p .codex-api
   cp .codev/config.toml .codex-api/config.toml
   # Optional fallback if Codex is already installed and logged in:
   cp ~/.codex/auth.json .codex-api/auth.json
   ```

   If auth is missing, the first unauthenticated request returns a login URL; complete it to populate
   `.codex-api/auth.json`. Do **not** copy `~/.codex/config.toml` — use the repo-managed config.

3. Option A — run with Docker (pulls the prebuilt GHCR image):

   ```bash
   PROXY_API_KEY=codex-local-secret docker compose up -d
   ```

   Pin a specific release tag by setting `IMAGE=ghcr.io/drjlabs/codex-app-server-proxy:<tag>`.

4. Option B — run with Node (binds to `0.0.0.0:11435` by default; set `PROXY_HOST=127.0.0.1` for loopback-only):

   ```bash
   PORT=11435 PROXY_API_KEY=codex-local-secret PROXY_HOST=127.0.0.1 npm run start
   ```

5. Configure Obsidian Copilot:
   - Base URL: `http://127.0.0.1:11435`
   - API key: `codex-local-secret`
   - Model: `codex-5` (or `codex-5-low` / `codex-5-medium` / `codex-5-high`)
   - Streaming: enabled

6. Verify:

   ```bash
   curl -s http://127.0.0.1:11435/healthz | jq .
   curl -s http://127.0.0.1:11435/v1/models | jq .
   ```

**Windows (recommended):** Use Docker Desktop (WSL2 backend) with the local compose example:

```bash
cp infra/compose/docker-compose.local.example.yml docker-compose.local.yml
# ensure ./.codex-api has config.toml (from .codev) and optional auth.json
PROXY_API_KEY=codex-local-secret docker compose -f docker-compose.local.yml up --build
```

If the proxy returns a login URL, Codex uses a local callback on port `1435` — make sure it is open.

### Run locally with Node

1. Install dependencies:

   ```bash
   npm install
   ```

2. Use the repo-managed `.codev/config.toml` (already tracked). If you already have Codex auth,
   copy `~/.codex/auth.json` into `.codev/auth.json` as a fallback; otherwise the first
   unauthenticated request returns a login URL that will populate `.codev/auth.json`.
3. Start the proxy (defaults to port `11435` and binds to `0.0.0.0` unless overridden). Set `PROXY_HOST=127.0.0.1` for loopback-only:

   ```bash
   PORT=11435 PROXY_API_KEY=codex-local-secret npm run start
   ```

4. Smoke-test the API:

   ```bash
   # health
   curl -s http://127.0.0.1:11435/healthz | jq .
   # models
   curl -s http://127.0.0.1:11435/v1/models | jq .
   ```

5. Issue a sample response (non-stream):

   ```bash
   curl -s http://127.0.0.1:11435/v1/responses \
     -H "Authorization: Bearer codex-local-secret" -H 'Content-Type: application/json' \
     -d '{"model":"codex-5","input":"Say hello.","stream":false}' | jq .
   ```

### Run with Docker Compose

1. For production-style usage, the root `docker-compose.yml` pulls the GHCR image by default:

   ```bash
   PROXY_API_KEY=codex-local-secret docker compose up -d
   ```

2. For local builds, copy the example compose file and adjust environment variables:

   ```bash
   cp infra/compose/docker-compose.local.example.yml docker-compose.local.yml
   # edit docker-compose.local.yml to set PROXY_API_KEY or other overrides
   ```

3. Populate `.codex-api/` with the repo-managed config (`.codev/config.toml`) and optional auth fallback.
4. Launch the stack:

   ```bash
   docker compose -f docker-compose.local.yml up --build
   ```

5. Query the API on `http://127.0.0.1:11435`:

   ```bash
   curl -s http://127.0.0.1:11435/v1/models | jq .
   ```

> Note: `docker-compose.yml` sets `PROXY_HOST=0.0.0.0` inside the container so Traefik can reach the app over the bridge network. Local Node runs also default to `0.0.0.0`; set `PROXY_HOST=127.0.0.1` if you want loopback-only.

### Dev helpers

- `npm run dev` — start the proxy with live reload and the default app-server worker supervisor.
- `npm run dev:stack:up` — full dev stack (Traefik, auth, proxy) on `http://127.0.0.1:18010/v1` using the baked-in Codex CLI by default. To use a host-mounted CLI, set `CODEX_BIN=codex` and add the host mount described under [Development](#development). Traefik now sources the `codex-dev` routers/middlewares from `/etc/traefik/dynamic/codex-dev.yml` (file provider) instead of Docker labels, so make sure that file exists on the host when bringing the stack up.
- `npm run dev:shim` — starts the proxy against the deterministic app-server JSON-RPC shim (`scripts/fake-codex-jsonrpc.js`), so you can run without installing Codex CLI.

## Usage

### Authentication

- All `/v1/chat/completions` **and `/v1/responses`** requests require `Authorization: Bearer $PROXY_API_KEY`.
- Codex app-server uses ChatGPT login by default (`preferred_auth_method=chatgpt`). If auth is missing or expired,
  the proxy returns a login URL in the error message; completing it writes `auth.json` under `CODEX_HOME`.
- If Codex is already installed and logged in, you can copy `~/.codex/auth.json` into `.codex-api/auth.json`
  (prod) or `.codev/auth.json` (dev) as a fallback. Do **not** copy `~/.codex/config.toml`; use the repo-managed config.
- `/v1/models` is public in dev but can be protected by setting `PROXY_PROTECT_MODELS=true`.
- Usage telemetry (`/v1/usage`, `/v1/usage/raw`) requires the bearer key unless you explicitly set `PROXY_USAGE_ALLOW_UNAUTH=true` for local diagnostics.
- Test-only routes (`/__test/*`) are gated by `PROXY_TEST_ENDPOINTS=true`, always require the bearer key, and default to loopback-only unless `PROXY_TEST_ALLOW_REMOTE=true`.
- ForwardAuth (Traefik) also checks the same key to keep edge and origin consistent.

### System prompts → base instructions

- By default (`PROXY_IGNORE_CLIENT_SYSTEM_PROMPT=true`), client-supplied `system` messages are **not** forwarded to the app-server `baseInstructions` field. This avoids malformed/hostile prompts crashing the worker or triggering “Instructions are not valid.”
- Only set `PROXY_IGNORE_CLIENT_SYSTEM_PROMPT=false` if you explicitly need client system prompts to become `baseInstructions` and you trust the caller. Coordinate with app-server contracts before changing this flag.

### Model selection

- Production advertises `codex-5{,-low,-medium,-high}` plus `gpt-5.2-codex-{L,M,H,XH}`; development advertises `codev-5{,-low,-medium,-high}` to avoid client confusion.
- Dev also exposes `codev-5.1-{L,M,H}` and `codev-5.2-{L,M,H,XH}` which map directly to `gpt-5.1` / `gpt-5.2` with implied low/medium/high/xhigh reasoning effort (uppercase suffix is optional; IDs are case-insensitive). Prod exposes the `gpt-5.2-codex-*` aliases for the same `gpt-5.2` target/effort mapping.
- Both prefixes are accepted. The proxy normalizes model IDs to the effective Codex target (default `gpt-5.2`,
  `gpt-5.1` for `codev-5.1-*`, and `gpt-5.2` for `codev-5.2-*` / `gpt-5.2-codex-*`) and applies the implied
  reasoning effort automatically.
- Do not override `CODEX_MODEL` unless you are purposely testing unsupported combinations; let the proxy map inputs.

### Requests

- `/v1/responses` is the primary endpoint for new integrations; `/v1/chat/completions` remains for legacy clients.
- Non-stream requests respond with OpenAI-compatible JSON (see the [Run locally with Node](#run-locally-with-node) example).
- Streaming uses server-sent events with role-first deltas followed by incremental content chunks and a terminating `[DONE]` marker.
- `/v1/responses` can be disabled for chat-only deployments via `PROXY_ENABLE_RESPONSES=false`; default is on for parity with OpenAI.

### Streaming controls for tool-heavy clients

- `PROXY_SUPPRESS_TAIL_AFTER_TOOLS=true` — hide assistant narrative after the final `<use_tool>` block while keeping the stream open.
- `PROXY_STOP_AFTER_TOOLS=true` — cut the stream immediately after the final `<use_tool>` block.
- `PROXY_STOP_AFTER_TOOLS_MODE=burst|first` — allow a small burst of tool blocks before cutting or stop after the first one.
- `PROXY_STOP_AFTER_TOOLS_GRACE_MS=300` — grace window for burst mode.
- `PROXY_TOOL_BLOCK_MAX=10` — optional cap on tool blocks to prevent client overload.

### Usage metrics

- The proxy logs estimated prompt/completion token usage for each request and exposes the aggregates via `/v1/usage`.
- Metrics are approximate because Codex CLI does not expose raw token counts for every release; treat them as guidance rather than billable totals.

### Observability

- `/metrics` (enable via `PROXY_ENABLE_METRICS=true`) exposes Prometheus series including stream TTFB/duration/end (`codex_stream_ttfb_ms`, `codex_stream_duration_ms`, `codex_stream_end_total`) and worker readiness/restart gauges/counter; loopback/bearer gating applies.
- Optional OTLP tracing: set `PROXY_ENABLE_OTEL=true` plus `PROXY_OTEL_EXPORTER_URL` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) to emit `http.server` and backend spans; defaults keep tracing off.

## Project Structure (high‑level)

```
docker-compose.yml              # PRODUCTION compose and Traefik labels (source of truth)
Dockerfile                      # App image (production build)
server.js                       # Express API (OpenAI‑compatible routes)
src/utils.js                    # Utilities (tokens, join/normalize, CORS helpers)
auth/server.mjs                 # Traefik ForwardAuth microservice
tests/                          # Unit, integration, Playwright E2E
vitest.config.ts                # Unit test config + coverage thresholds (V8)
playwright.config.ts            # E2E config (spawns server with the deterministic JSON-RPC shim for CI)
scripts/                        # Dev + CI helpers (dev.sh, prod-smoke.sh)
scripts/setup-testing-ci.sh     # Idempotent test/CI scaffolder (useful for forks)
.codev/                         # Project‑local Codex HOME for dev (config.toml, AGENTS.md)
 .codex-api/                     # Production Codex HOME (secrets; writable mount in compose)
docs/app-server-migration/      # Schema exports and runbooks
.github/workflows/ci.yml        # CI: lint, format, unit, integration, e2e
AGENTS.md                       # Agent directives (project‑specific rules included)
```

## Environments: PROD vs DEV

See docs/README.md for documentation pointers. Keep public docs under `docs/` and keep local-only notes out of the public repo.

### Production

- This repo’s `docker-compose.yml` is the production deployment spec.
- Traefik runs as a host/system service (not a container).
- ForwardAuth MUST use host loopback:
  - `traefik.http.middlewares.codex-forwardauth.forwardauth.address=http://127.0.0.1:18080/verify`
- App attaches to Docker network `traefik` and is discovered via labels.
- Edge is Cloudflare for `codex-api.example.com`.
- Backend mode: production sets `PROXY_USE_APP_SERVER=true` and keeps a long-lived app-server worker alive. Ensure `.codex-api/auth.json` is present; if Codex is already logged in on the host, copy `~/.codex/auth.json` as a fallback.

#### Rendered infra config

Some infra config is generated from templates and gitignored. Render these files before deploying Cloudflare/Wrangler changes:

```bash
DOMAIN=your-prod-domain.com DEV_DOMAIN=your-dev-domain.com ZONE_NAME=your-zone.com \
  bash scripts/render-infra.sh
```

Generated files:
- `infra/cloudflare/rht.json`
- `infra/cloudflare/rht_update.json`
- `workers/cors-preflight-logger/wrangler.toml`

Template usage flow:

1. Set your real domains in `.env` and `.env.dev` (use `.env.example` / `.env.dev.example` as a starting point).
2. Run `scripts/render-infra.sh` with `DOMAIN`, `DEV_DOMAIN`, and `ZONE_NAME` to generate the rendered files. The script does not source `.env` files, so export or prefix the variables.
3. Apply the rendered Cloudflare JSON and deploy the worker using `wrangler.toml`.
4. Keep the rendered files out of Git (they are gitignored).

Codex HOME (production):

- The proxy sets `CODEX_HOME` to `/app/.codex-api` in the container.
- `docker-compose.yml` bind-mounts the project’s `./.codex-api` into the container: `./.codex-api:/app/.codex-api` (writable).
- Do not commit secrets. Only a placeholder `README.md` and optional `.gitkeep` are tracked; everything else under `.codex-api/` is ignored by Git and is also excluded from Docker build context via `.dockerignore`.
- `.codex-api` MUST be writable in production because Codex CLI persists rollout/session artifacts under its home on some versions. Mounting read-only has caused streaming/tool communication to fail in production.
  - Note: The proxy also sets `PROXY_CODEX_WORKDIR` (default `/tmp/codex-work`) as the child process working directory to isolate ephemeral writes. However, do not rely on this to redirect Codex’s own rollout/session files away from `CODEX_HOME` unless your Codex CLI version explicitly supports that.
- On the production host, provision the following files under the project’s `.codex-api/` before `docker compose up`:
  - `config.toml` (repo-managed proxy config; copy from `.codev/config.toml`)
  - `AGENTS.md` (optional)
  - `auth.json` and any other credentials required by Codex (if applicable)
  - The canonical bearer credential lives at `~/.codex/auth.json`; after each rotation copy that file into `.codex-api/auth.json` (prod) and `.codev/auth.json` (dev) before starting stacks.

#### Sync Dev Config → Prod (`.codev` → `.codex-api`)

To port your dev Codex HOME config and agents into the production Codex HOME safely (without copying secrets):

- Quick sync on the host running production:

  ```bash
  npm run port:sync-config
  ```

  This copies `.codev/{config.toml,AGENTS.md}` → `.codex-api/`. It will not overwrite existing files that differ; use the `--force` flag to overwrite and create a timestamped backup.

- Explicit path override (e.g., remote home path):

  ```bash
  SOURCE_HOME=.codev DEST_HOME=/srv/codex/.codex-api bash scripts/sync-codex-config.sh --force
  ```

Notes:

- The sync intentionally skips secrets like `auth.json` — manage credentials out‑of‑band.
  - For this project the source of truth is `~/.codex/auth.json`; refreshes should be propagated into `.codev/` and `.codex-api/` manually.
- Detailed Dev → Prod procedures are available in internal documentation (not published).
  - Public deployment/runbooks live under `docs/deployment/` and `docs/ops/`.

### Release & Backup shortcuts

- `npm run snapshot:dry-run` → preview the release tarball + lock that `scripts/stack-snapshot.sh` would create in `releases/`.
- `bash scripts/stack-snapshot.sh --keep 3 --prune` → generate a release bundle (tarball + lock) and prune older bundles.
- Tagging `v*` triggers `.github/workflows/release.yml`, which verifies the SHA256 and uploads tarball + lock + `SHA256SUMS` to the GitHub Release.
- `npm run backup:data` → run `scripts/codex-data-backup.sh --mount-check --prune` to copy `.codex-api` into `/mnt/gdrive/codex-backups/YYYY/MM-DD/` with matching `.sha256` files.
- Optional encryption: export `CODEX_BACKUP_GPG_KEY` and append `--encrypt` when running the backup script.

### Development

- Node dev: `npm run dev` (port 18000) or `npm run dev:shim` (no Codex CLI required), using `.codev` as Codex HOME.
- Dev stack: `npm run dev:stack:up` (port 18010 by default). By default the dev stack uses the baked-in Codex CLI (`CODEX_BIN=/usr/local/lib/codex-cli/bin/codex.js`). To use your host Codex CLI instead, set `CODEX_BIN=codex` in `.env.dev` and add a volume mount that maps `~/.cargo/bin/codex` to `/usr/local/bin/codex` in `infra/compose/compose.dev.stack.yml`. To use the deterministic JSON-RPC shim, set `CODEX_BIN=/app/scripts/fake-codex-jsonrpc.js` in `.env.dev` and re‑up the stack.

#### Model IDs and client compatibility

- Prod advertises: `codex-5`, `codex-5-{low,medium,high}`, plus `gpt-5.2-codex-{L,M,H,XH}` which route to `gpt-5.2` automatically.
- Dev advertises: `codev-5`, `codev-5-{low,medium,high}`, plus `codev-5.1-{L,M,H}` and `codev-5.2-{L,M,H,XH}` which route to `gpt-5.1` / `gpt-5.2` automatically.
- The server accepts both prefixes everywhere, but many SDKs/tools validate against `GET /v1/models` and will reject an ID that isn’t advertised by that environment. Use the environment‑appropriate prefix, or specify `model: "gpt-5.2"` and set `reasoning.effort`.

Examples

```bash
# Prod (non-stream)
curl -s https://codex-api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROD_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"codex-5-low","stream":false,"messages":[{"role":"user","content":"Say hello."}]}' | jq '.choices[0].message.content'

# Dev (non-stream)
curl -s https://codex-dev.example.com/v1/chat/completions \
  -H "Authorization: Bearer $DEV_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"codev-5-low","stream":false,"messages":[{"role":"user","content":"Say hello."}]}' | jq '.choices[0].message.content'

# Prefix-agnostic alternative (works in both, set BASE and KEY first)
# e.g. BASE=codex-dev.example.com KEY=$DEV_KEY
curl -s https://$BASE/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.2","reasoning":{"effort":"low"},"stream":false,"messages":[{"role":"user","content":"Say hello."}]}' | jq '.choices[0].message.content'
```

Note: `GET /v1/models` is unauthenticated in both envs for discovery unless `PROXY_PROTECT_MODELS=true`.

Dev stack (public behind Traefik):

- Purpose: exercise the proxy with a real Codex CLI behind Traefik and ForwardAuth, mirroring prod, without touching prod.
- Bring up: `npm run dev:stack:up`
  - Uses a single file: `infra/compose/compose.dev.stack.yml` (self-contained dev app + dev auth)
  - Project name: `codex-dev` (ensures it doesn’t collide with prod services)
  - If local port 18010 is in use, override:
    - `DEV_PORT=19010 docker compose -p codex-dev -f infra/compose/compose.dev.stack.yml --env-file .env.dev up -d --build`
  - Uses the baked-in Codex CLI by default (`CODEX_BIN=/usr/local/lib/codex-cli/bin/codex.js`). To use the host CLI instead, set `CODEX_BIN=codex` and add a volume mount for `~/.cargo/bin/codex` to `/usr/local/bin/codex`.
- Domain: create a DNS record for `codex-dev.example.com` to your Traefik host (Cloudflare). The dev host now loads its routers/middlewares from `/etc/traefik/dynamic/codex-dev.yml`, so keep that file in sync with the compose labels if you tweak origins/CORS.
- ForwardAuth (dev) uses a dedicated dev auth service at `http://127.0.0.1:18081/verify`, backed by `auth-dev` in `infra/compose/compose.dev.stack.yml` and the dev key from `.env.dev`. Prod continues to use `http://127.0.0.1:18080/verify`.
- Dev key: set in `.env.dev` (see `.env.dev.example`) and pass to smoke/tests via `KEY`.
- Smoke: `DEV_DOMAIN=codex-dev.example.com KEY=$DEV_KEY npm run smoke:dev`
- Live tests (real Codex): `DEV_DOMAIN=codex-dev.example.com KEY=$DEV_KEY npm run test:live:dev`

Model IDs in dev vs prod:

- Prod (advertised): `codex-5`, `codex-5-low`, `codex-5-medium`, `codex-5-high`, plus `gpt-5.2-codex-{L,M,H,XH}` which normalize to `gpt-5.2` at low/medium/high/xhigh reasoning effort.
- Dev (advertised): `codev-5`, `codev-5-low`, `codev-5-medium`, `codev-5-high`, plus `codev-5.1-{L,M,H}` and `codev-5.2-{L,M,H,XH}` which normalize to `gpt-5.1` / `gpt-5.2` at low/medium/high/xhigh reasoning effort.
- Both environments accept either prefix; dev advertises `codev-*` to avoid client confusion. All map to the effective model (`gpt-5.2` for the `codex/codev-5*` aliases, `gpt-5.1` for `codev-5.1-*`, and `gpt-5.2` for `codev-5.2-*` / `gpt-5.2-codex-*`) with the implied reasoning effort.
- Do **not** override `CODEX_MODEL` in dev to force a specific reasoning tier. Leave it unset so the proxy maps
  `codev-5-*` requests to `gpt-5.2` and `codev-5.1-*` / `codev-5.2-*` requests to `gpt-5.1` / `gpt-5.2` internally; avoid using a `minimal` effort tier because the upstream `gpt-5.2` backend rejects it.

Notes:

- Dev config stays in `.codev/` (writable). Runtime writes are isolated under `PROXY_CODEX_WORKDIR`.
- Prod config stays in `.codex-api/` (writable mount). Prod compose unchanged until you promote changes.

### Dev → Prod Promotion Flow (authoritative)

- Change only dev inputs first: `.codev/*`, `infra/compose/compose.dev.stack.yml`.
- Validate locally (Node or container) and behind Traefik on `codex-dev…`:
  - Smoke: `DEV_DOMAIN=codex-dev.example.com KEY=$DEV_KEY npm run smoke:dev`
  - Live E2E (real Codex): `DEV_DOMAIN=codex-dev.example.com KEY=$DEV_KEY npm run test:live:dev`
- When green, open a PR with the minimal prod diffs (e.g., `docker-compose.yml`).
- After merge, rebuild prod and validate:
  - `docker compose up -d --build --force-recreate`
  - `DOMAIN=codex-api.example.com KEY=$PROXY_API_KEY npm run smoke:prod`
  - Optional live E2E: `LIVE_BASE_URL=https://codex-api.example.com KEY=$PROXY_API_KEY npm run test:live`

Operational guarantees:

- CODEX_HOME: dev `.codev/`, prod `.codex-api/` (both writable).
- Runtime writes: use `PROXY_CODEX_WORKDIR` in both environments; do not rely on it to redirect Codex rollouts unless your CLI version supports it.
- Traefik ForwardAuth: always host loopback `http://127.0.0.1:18080/verify` (prod and dev).

Codex HOME (development):

- Dev instances use the project-local `.codev/` as Codex HOME.
- Scripts (`npm run dev`, `npm run dev:shim`) and dev compose map `.codev` appropriately; the dev launcher seeds `config.toml` and `AGENTS.md` into the runtime `CODEX_HOME` if missing.

Build context hygiene:

- `.dockerignore` excludes `.codex-api/**`, `.codev/**`, `.env*`, logs, and other local artifacts so secrets are never sent to the Docker daemon.

## Backend Modes

### App-server (default)

- `PROXY_USE_APP_SERVER=true` boots a worker supervisor that keeps one or more `codex app-server` processes alive.
- Readiness hinges on the JSON-RPC `initialize` handshake; `/healthz` only reports ready once the worker has completed it.
- Use this mode everywhere (dev, CI, prod). Ensure Codex CLI ≥ 0.77.0 and keep `.codex-api/auth.json` synced from `~/.codex/auth.json` before restarting.
- Tune worker lifecycle with `WORKER_*_TIMEOUT_MS`, `PROXY_KILL_ON_DISCONNECT`, and `PROXY_WORKER_COUNT` when running on slower hardware or when you need multiple concurrent workers.

### Disabled (no backend)

- `PROXY_USE_APP_SERVER=false` disables the app-server worker supervisor and returns `503 app_server_disabled`.
- Use this only as a safety switch or during maintenance; there is no legacy fallback.
- Deterministic shim: `scripts/fake-codex-jsonrpc.js` (used by `npm run dev:shim` and Playwright E2E by default).

## Production Smoke

Run a minimal end‑to‑end check of origin (Traefik) and edge (Cloudflare):

```
DOMAIN=codex-api.example.com KEY=$PROXY_API_KEY npm run smoke:prod
```

Behavior:

- Origin (host only): checks `https://127.0.0.1/healthz` and `/v1/models` with `Host: $DOMAIN`.
- Edge (Cloudflare): checks `/healthz`, `/v1/models`, and an optional authenticated non‑stream chat.

## Documentation

Treat `docs/README.md` as the canonical documentation index. Start with `docs/getting-started.md` (first run), then `docs/configuration.md` (env vars) and `docs/api/overview.md` (runnable curl examples). Configuration/mount matrices live in `docs/reference/config-matrix.md`. Keep local-only notes out of the public repo and keep public runbooks under `docs/deployment/` and `docs/ops/`. Run `npm run lint:runbooks` before committing doc changes to keep runbooks formatted.

## License

This project is released under the [MIT License](LICENSE).

## Contributing

See `CONTRIBUTING.md` for local setup, workflows, and the test selection policy.

## Testing

This repo uses a three-layer testing setup optimized for fast inner-loop feedback while coding:

- Run `npm run verify:all` before opening a PR to execute formatting, linting, unit, integration, and Playwright suites in one step.
- Env smokes: `npm run smoke:dev` (requires `DEV_DOMAIN`/`KEY`) and `npm run smoke:prod` (requires `DOMAIN`/`KEY`) hit `/v1/models` and both streaming and non-stream chat endpoints against the respective stacks.
- CI artifacts: the workflow uploads `playwright-report`/`blob-report` plus `.smoke-tool-call.log`. Download artifacts from the run and open the HTML report locally via `npx playwright show-report playwright-report`.
- CI enforces a clean workspace after tests to catch regenerated fixtures; keep tracked assets updated locally before pushing.

1. Unit (Vitest, fast, watchable)

- Scope: pure helpers in `src/utils.js` (model normalization, token heuristics, message joining, time/usage math, CORS header logic, text filtering).
- Commands:
  - `npm run test:unit` — run once
  - `npm run test:unit:watch` — watch mode during development
  - `npm run coverage:unit` — unit test coverage (v8)

2. Integration (Vitest, real server, no external deps)

- Scope: Express endpoints exercised against the deterministic JSON-RPC shim so suites can run without a Codex install.
- Notes: spawns `node server.js` on a random port and sets `CODEX_BIN`/`PROXY_USE_APP_SERVER` per test.
- Command: `npm run test:integration`

3. End‑to‑End API/SSE (Playwright Test)

- Scope: verifies `/v1/models`, non‑stream chat, and streaming SSE (`role` delta and `[DONE]`).
- Command: `npm test`
- Tip: set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` if you are only running API/SSE tests and do not want browsers downloaded.

Live E2E (real Codex)

- Purpose: run E2E against a live proxy (local compose or edge) using your `.env` key to catch issues that the legacy shim cannot (e.g., writable `.codex-api` rollouts).
- Command: `npm run test:live`
- Env:
- `KEY` or `PROXY_API_KEY` (loaded from `.env` or environment)
  - `LIVE_BASE_URL` (default `http://127.0.0.1:11435`)
- What it checks:
  - `/healthz`, `/v1/models` (200 or 401 when models are protected)
  - Non‑stream chat returns content (no fallback message)
  - Streaming emits role delta, at least one content delta, and `[DONE]`

All together

- `npm run test:all` — unit → integration → e2e in sequence. Useful before pushing.
- `npm run test:report` — open the Playwright HTML report (after e2e has run).

Scaffolding (for forks)

- This repo already includes `vitest.config.ts` and the test suites. If you need to scaffold the same setup in a fork that lacks them, use the idempotent helper: `bash scripts/setup-testing-ci.sh`.

Suggested dev loop

- Working on pure helpers? Start `npm run test:unit:watch` and code in `src/utils.js`.
- Changing route logic or request/response shapes? Run `npm run test:integration` frequently.
- Touching streaming behavior? Validate with `npm test` (Playwright SSE) or the curl snippet in “Manual checks (SSE)”.

## Codex Cloud Setup

To prepare a fresh Codex Cloud (or any CI) environment with everything required to run this repo’s tests locally:

```bash
./scripts/setup-codex-cloud.sh           # installs deps, Playwright, prepares writable dirs
./scripts/setup-codex-cloud.sh --verify  # does the above and runs unit→integration→e2e
```

Notes

- Requires Node ≥ 22 and npm; does not touch your `.env` or secrets.
- Ensures `.codex-api/` and `.codev/` exist and are writable.
- Installs Playwright Chromium and OS deps when supported; falls back gracefully if not.
- Tests use the deterministic JSON-RPC shim and do not require a real Codex binary.

### Environment variables (Codex Cloud)

These are optional for CI/Codex Cloud. The default test configs work without secrets.

- PROXY_API_KEY: Only needed when you run the server yourself or for live tests; not required for unit/integration/local E2E.
- LIVE_BASE_URL: Override base URL for `npm run test:live` (default `http://127.0.0.1:11435`).
- KEY: Alternative to `PROXY_API_KEY` for `test:live` bearer.
- PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: Set to `1` to skip downloading browsers if preinstalled.
- HTTP_PROXY / HTTPS_PROXY: Use standard proxy env vars if your environment requires outbound proxying. The setup script normalizes legacy npm proxy keys to avoid warnings.

### Which tests to run when

- Before running the full verification chain (`npm run verify:all`), execute the smoke script (`npm run smoke:dev` locally or `npm run smoke:prod` on hosts). The smoke workflow now fails fast by running `codex app-server --help`; failures surface immediately if the CLI is missing the app-server entrypoint.
- Changed `src/utils.js` only → run unit: `npm run test:unit`.
- Changed `server.js` routing/handlers/streaming → run integration: `npm run test:integration`, then E2E: `npm test`.
- Changed `docker-compose.yml` (labels/ports/ForwardAuth) or Traefik‑related behavior → run production smoke: `npm run smoke:prod` (on the origin host) and E2E.
- Changed `Dockerfile` → build and run dev stack (`npm run dev:stack:up`), then E2E.

Environment variables:

- `PORT` (default: `11435`)
- `PROXY_API_KEY` (default: `codex-local-secret`)
- `CODEX_MODEL` (default: `gpt-5.2`)
- `CODEX_BIN` (default: `codex`) — override to `scripts/fake-codex-jsonrpc.js` for the deterministic app-server shim.
- `CODEX_HOME` (default: `$PROJECT/.codex-api`) — path passed to Codex CLI for configuration. The repo uses a project‑local Codex HOME under `.codex-api/` (`config.toml`, `AGENTS.md`, etc.).
- `PROXY_SANDBOX_MODE` (default: `read-only`) — runtime sandbox passed to the Codex CLI via `--config sandbox_mode=...`. Read-only keeps the app-server from invoking file-writing tools (Codex will stop before `apply_patch` or shell edits). Override to `danger-full-access` only if you explicitly need write-capable tool calls and can tolerate clients that attempt to modify the workspace.
- `PROXY_ENABLE_RESPONSES` (default: `true`) — disable to hide `/v1/responses` in chat-only environments.
- `PROXY_OUTPUT_MODE` (default: `obsidian-xml`) — default output envelope (`obsidian-xml` emits `<use_tool>` blocks as text; `openai-json` emits structured tool calls). Override per request via `x-proxy-output-mode`.
- `PROXY_RESPONSES_OUTPUT_MODE` (default: `openai-json`) — default output mode applied for `/v1/responses` when no `x-proxy-output-mode` header is present.
- `PROXY_RESPONSES_DEFAULT_MAX_TOKENS` (default: `0`) — fallback `max_tokens` for `/v1/responses` when no max token field is supplied; `0` disables the fallback.
- Built-in Codex tools (shell, apply_patch, web_search, view_image) are disabled via `.codex-api/config.toml` / `.codev/config.toml`. Assistants must respond in plain text and must not emit `<use_tool>` blocks or request tool calls. Sections that describe tool-tail streaming (e.g., stop-after-tools) are therefore inactive unless you explicitly re-enable tools for a workflow.
- `PROXY_CODEX_WORKDIR` (default: `/tmp/codex-work`) — working directory for the Codex child process. This isolates any file writes from the app code and remains ephemeral in containers.
- `CODEX_FORCE_PROVIDER` (optional) — if set (e.g., `chatgpt`), the proxy passes `--config model_provider="<value>"` to Codex to force a provider instead of letting Codex auto-select (which may fall back to OpenAI API otherwise).
- `PROXY_ENABLE_CORS` (default: `true`) — when `true`, Express emits CORS headers. Set to `false` if the edge fully manages CORS.
- `PROXY_CORS_ALLOWED_ORIGINS` (default: `*`) — comma-separated allowlist used when app CORS is enabled. Include each trusted origin (e.g., `https://codex-api.example.com,https://obsidian.md,app://obsidian.md,capacitor://localhost,http://localhost,https://localhost`).
- `PROXY_PROTECT_MODELS` (default: `false`) — set to `true` to require auth on `/v1/models`.
- `PROXY_TIMEOUT_MS` (default: `300000`) — overall request timeout (5 minutes).
- `PROXY_IDLE_TIMEOUT_MS` (default: `15000`) — non‑stream idle timeout while waiting for backend output.
- `PROXY_STREAM_IDLE_TIMEOUT_MS` (default: `300000`) — stream idle timeout between chunks (5 minutes).
- `PROXY_MAX_PROMPT_TOKENS` (default: `0`) — when >0, rejects overlong prompts with `403 tokens_exceeded_error` based on the proxy’s rough token estimator (≈1 token per 4 chars).
- `PROXY_KILL_ON_DISCONNECT` (default: `false`) — if true, terminate Codex when client disconnects.
- `PROXY_SSE_KEEPALIVE_MS` (default: `15000`) — periodic `: keepalive` comment cadence for intermediaries.
- `TOKEN_LOG_PATH` (default: OS tmpdir `codex-usage.ndjson`) — where usage events are appended (NDJSON).
- `RATE_LIMIT_AVG` / `RATE_LIMIT_BURST` — Traefik rate limit average/burst (defaults: 200/400).
- `PROXY_ENABLE_OTEL` (default: `false`) — when true and an exporter URL is provided, emit OTLP HTTP spans for HTTP ingress and backend invocation.
- `PROXY_OTEL_EXPORTER_URL` (optional) — OTLP/HTTP traces endpoint; falls back to `OTEL_EXPORTER_OTLP_ENDPOINT` if set.
- `PROXY_OTEL_SERVICE_NAME` (optional) — override service name for emitted spans.

## Roo Code configuration

Use OpenAI-Compatible provider:

- Any OpenAI‑style Chat Completions client can talk to this proxy by setting the base URL and API key. Example: `http://127.0.0.1:11435/v1`
- API Key: `codex-local-secret`
- Model: `gpt-5.2`
- Reasoning effort: `High`

An example file is in `config/roo-openai-compatible.json`.

## API mapping

- `model`: normalized to the effective Codex model before invoking the JSON-RPC transport. Aliases such as `codex/gpt-5.2` are accepted but rewritten to the underlying `gpt-5.2` call.
- `messages[]`: transformed into the Codex schema (`system_prompt`, `messages`, `metadata`) and passed to `sendUserTurn`. System and assistant messages remain in the transcript; tool calls are flattened into text so existing Codex releases can parse them.
- `stream: true`: emits SSE with a role-first chunk, incremental content deltas, and `[DONE]`.
- `reasoning.effort ∈ {low,medium,high,xhigh}`: forwarded via `--config model_reasoning_effort=...` (and the older `--config reasoning.effort=...` for backwards compatibility) in addition to the JSON payload.
- Sampling knobs (`temperature`, `top_p`, penalties, `max_tokens`) are ignored because Codex CLI does not expose them for app-server mode.

## How it works (main‑p)

- A supervisor launches one or more `codex app-server` workers with `--config sandbox_mode=<...>`, `--config project_doc_max_bytes=0`, `--config tools.web_search=false`, and the normalized effective model (`gpt-5.2` unless overridden).
- On boot the worker completes `initialize` against the exported schema bundle (`docs/app-server-migration/*`). Health endpoints stay unhealthy until this handshake succeeds.
- Each `/v1/chat/completions` request acquires a worker channel, builds a JSON-RPC payload for `sendUserTurn`, and injects the OpenAI-style transcript (system → `system_prompt`, rest → `messages`). Optional `reasoning.effort` becomes both JSON metadata and `--config model_reasoning_effort`.
- Streaming requests attach an event listener that forwards `agent_message_delta` notifications as SSE chunks (role-first, then deltas, then `[DONE]`). Keepalives (`: keepalive`) go out every `PROXY_SSE_KEEPALIVE_MS`.
- Non-stream requests buffer deltas until `task_complete` arrives, then respond with a single OpenAI-compatible JSON body.
- Disconnects or idle timers trigger `cancelTask` and optionally `PROXY_KILL_ON_DISCONNECT`, ensuring app-server state does not leak across clients.

### Usage/Token tracking (approximate)

The proxy estimates tokens using a simple heuristic (~1 token per 4 characters) and logs each `/v1/chat/completions` call to an NDJSON file. For most operational trending this is sufficient; it does not reflect provider billing.

Endpoints (protected by the same edge auth as other `/v1/*` routes):

- `GET /v1/usage?start=<iso|epoch>&end=<iso|epoch>&group=<hour|day>` → aggregated counts
- `GET /v1/usage/raw?limit=100` → last N raw events

Event fields:

- `ts` (ms since epoch), `route`, `method`, `requested_model`, `effective_model`, `stream`, `prompt_tokens_est`, `completion_tokens_est`, `total_tokens_est`, `duration_ms`, `status`, `user_agent`.

### Reasoning variants

The proxy advertises additional model ids that all map to GPT‑5 but set the reasoning effort automatically unless explicitly provided in the request:

- `codex-5-low`
- `codex-5-medium`
- `codex-5-high`

Behavior:

- Selection sets `--config model_reasoning_effort="<level>"` (and a legacy `--config reasoning.effort="<level>"` for older CLIs).
- If `body.reasoning.effort` is present in the incoming request, it takes precedence over the implied level.
- The underlying `-m` remains the effective model (default: `gpt-5.2`).

## Behavior summary

- `GET /healthz` returns `{ ok, sandbox_mode, backend_mode, ... }` (health snapshots included).
- `GET /v1/models` lists only `codex-5` (no slashes) so clients like Cursor won’t confuse it with OpenAI built-ins. Requests that specify `gpt-5.2` directly still work.
- `POST /v1/chat/completions` with `stream:true` yields SSE with a role-first chunk and a `[DONE]` terminator (content chunk may arrive aggregated before `[DONE]`).
- App-server workers launch via `codex app-server` with flags such as `--config sandbox_mode=read-only`, `--config project_doc_max_bytes=0`, `--config tools.web_search=false`, and `--config model_reasoning_effort="<level>"`. Additional JSON payloads supply transcripts and metadata per request.

### Local dev with `.codev`

For an isolated dev setup that doesn’t touch your global Codex state, this repo supports a project-local config under `.codev/` (checked in with `AGENTS.md` and `config.toml`). Run the server on a separate port (e.g., 18000) using that config by pointing `CODEX_HOME` to `.codev`:

```
PROXY_API_KEY=<your-dev-key> npm run start:codev
```

If you don’t have the Codex CLI installed, you can use the built-in deterministic JSON-RPC shim (no Codex install required):

```
PROXY_API_KEY=<your-dev-key> npm run start:codev:shim
```

Both commands serve at `http://127.0.0.1:18000/v1`.

### Prod Smoke

Use the production smoke script to verify the edge (Cloudflare) and the origin (Traefik) without relying on any IDE:

```
DOMAIN=codex-api.example.com KEY=$PROXY_API_KEY npm run smoke:prod
```

Behavior:

- Checks origin via `https://127.0.0.1` with `Host: $DOMAIN` for `/healthz` and `/v1/models` (skippable with `SKIP_ORIGIN=1`).
- Checks Cloudflare for the same endpoints.
- If `KEY` is provided, issues a non‑stream chat completion and validates a text response.

### Simplest dev start (loads `.env` automatically)

Use the helper launcher which sources `.env` and runs on port 18000 by default:

```
npm run dev
```

Options:

- `npm run dev -- -p 19000` — change port
- `npm run dev:shim` — run without Codex CLI, using the deterministic app-server JSON-RPC shim

The launcher never prints secrets and prefers project-local `.codev` config via `CODEX_HOME=.codev`.

### Dev stack (Compose)

Convenience scripts manage a self-contained dev stack that mirrors production behind Traefik:

- `npm run dev:stack:up` — build and start on `http://127.0.0.1:18010/v1` using the baked-in app-server workers by default
- `npm run dev:stack:logs` — follow logs
- `npm run dev:stack:down` — stop and remove (prunes volumes)

Notes:

- Compose reads `PROXY_API_KEY` from `.env.dev`.
- Override port: `DEV_PORT=19010 npm run dev:stack:up`
- Set `CODEX_BIN=codex` to use your host Codex CLI and add a volume mount for `~/.cargo/bin/codex` to `/usr/local/bin/codex`.
- File: `infra/compose/compose.dev.stack.yml` — single-file dev stack (`app-dev` + `auth-dev`), maps `./.codev` to `/home/node/.codex`, uses the baked-in Codex CLI by default, and configures ForwardAuth dev at `127.0.0.1:18081`. Set `CODEX_BIN=/app/scripts/fake-codex-jsonrpc.js` to use the deterministic shim for CI/offline tests.

## Notes and troubleshooting

- Port already in use: If `11435` is busy, launch with `PORT=18000 npm run start` and run acceptance with `BASE_URL=http://127.0.0.1:18000/v1`.
- Streaming shape: First SSE chunk sets the role; subsequent chunks are deltas as the backend emits them; `[DONE]` terminates the stream.
- Auth: If Codex is installed and logged in, you can copy `~/.codex/auth.json` into `.codev/auth.json` or `.codex-api/auth.json` as needed; otherwise rely on the login URL response.
- Sandboxing: On some containerized Linux setups, sandboxing may be limited; read-only intent remains.
- Project docs are disabled for proxy runs: the proxy passes `--config project_doc_max_bytes=0` so the Codex backend behaves like a pure model API and does not ingest the app repo. The global `AGENTS.md` under `CODEX_HOME` still applies.

### Writable state and rollouts

The Codex CLI persists lightweight session artifacts ("rollouts"). Use `PROXY_CODEX_WORKDIR` (default `/tmp/codex-work`) to isolate runtime writes from configuration. Rollouts are small JSONL traces that include timestamps, minimal configuration, and high‑level event records from each Codex session. They enable:

- Debugging and reproducibility of agent behavior
- Auditability/telemetry for long‑running sessions
- Optional offline analysis or redaction pipelines

If the working area is read‑only, Codex may fail at startup or fall back to placeholder responses. Symptoms:

- App logs show: `failed to initialize rollout recorder: Read-only file system (os error 30)`
- Client sees minimal placeholder output despite a 200 status, or stream closes early.

Fix: ensure `PROXY_CODEX_WORKDIR` is present and writable (default `/tmp/codex-work`). The repo‑local `.codev` holds configuration; runtime writes should target the workdir, not configuration.

### Long-running tasks and stable streaming

For long/complex tasks or slow backends, tune these environment variables:

- `PROXY_TIMEOUT_MS` (default 300000): overall request timeout (non‑stream).
- `PROXY_STREAM_IDLE_TIMEOUT_MS` (default 300000): idle window for streaming before the backend is terminated.
- `PROXY_SSE_KEEPALIVE_MS` (default 15000): interval for SSE comment pings to keep connections alive across proxies.

The proxy sends periodic `: keepalive` SSE comments to prevent intermediaries from closing idle connections. Prefer `stream:true` for long tasks.

## Security and .gitignore

Sensitive files such as `.env`, `.npmrc`, and any Codex cache directory (`.codex/`) are ignored by `.gitignore`. The proxy never reads or writes your project files; it runs Codex with `--sandbox read-only`.

## Manual checks (SSE)

Validate streaming with curl:

```bash
curl -sN http://127.0.0.1:11435/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"codex-5","stream":true,"messages":[{"role":"user","content":"Say hello."}]}' | sed -n '1,30p'
```

Expect an initial role delta, one or more `data: {"..."}` chunks, then `data: [DONE]`.

## Client compatibility quickstart

- Any OpenAI‑style Chat Completions client can talk to this proxy by setting the base URL and API key. Example: `https://your-public-host/v1` (must be reachable by Cursor’s cloud; `http://127.0.0.1` will not work).
- API Key: same value as `PROXY_API_KEY`.
- Model: select `codex-5` (proxy normalizes to effective `gpt-5.2`).
- Streaming: supported (role-first delta + `[DONE]`). See `docs/openai-endpoint-golden-parity.md` for the canonical contract.
- Optional: set `PROXY_PROTECT_MODELS=true` to force auth on `/v1/models` during verification.
- Hangs: if Codex is missing or stalls, responses will fail fast per `PROXY_TIMEOUT_MS` instead of hanging.

## Deployment: Traefik + Cloudflare (Docker Compose)

This section deploys the API behind Traefik with HTTPS handled by cloudflared and Bearer auth enforced at the edge via Traefik ForwardAuth. The service itself already checks Bearer tokens internally in [app.post()](server.js:46). Public health probe is served at [app.get()](server.js:39).

Prerequisites

- Traefik v3 running as a host service with Docker provider enabled and an external Docker network named `traefik`.
- Entrypoint `websecure` is active in Traefik. Certificates are handled by your cloudflared tunnel + Traefik; no ACME changes required.
- Domain: `codex-api.example.com` is routed via cloudflared to Traefik.
- Docker Compose v2.

Files in this repo

- Build image: [Dockerfile](Dockerfile)
- Compose stack: [docker-compose.yml](docker-compose.yml)
- ForwardAuth microservice: [auth/server.mjs](auth/server.mjs)
- Main API server: [server.js](server.js)
- Legacy systemd installer is archived internally; `scripts/install.sh` now exits early and compose is the canonical deployment path.

Edge authentication model

- Traefik calls `http://127.0.0.1:18080/verify` via ForwardAuth (canonical entrypoint: [auth/server.mjs](auth/server.mjs:1)).
- The auth service validates the `Authorization: Bearer &lt;token&gt;` header equals the shared secret `PROXY_API_KEY`. On mismatch it returns 401 with a `WWW-Authenticate: Bearer realm=api` header.
- On success, Traefik forwards the request to the app container service port 11435, preserving the original `Authorization` header so the in-app check still applies (defense in depth).

Containerization

- The app image is defined in [Dockerfile](Dockerfile) and launches the proxy with `node server.js`.
- Codex CLI availability inside the container:
  - Option A (mount from host, recommended initially): By default the app runs Codex with `HOME=/home/node` and expects config under `/home/node/.codex/config.toml`. The Compose file mounts your host `~/.codex-api` into the container at `/home/node/.codex` and binds the `codex` binary:
    - Host → Container: `~/.codex-api` → `/home/node/.codex:ro`
    - Host → Container: `~/.cargo/bin/codex` → `/usr/local/bin/codex:ro`
    - Create your config at `~/.codex-api/config.toml` on the host.
  - Option B (bake into image): Extend the Dockerfile to install `codex` and copy credentials during build (ensure no secrets end up in the image layers).

Configuration

- Create an environment file from the example:
  - `cp .env.example .env`
  - Set `PROXY_API_KEY` to the shared secret (used by both the auth service and the app).
- Ensure external Docker network:
  - `docker network create traefik` (no-op if it already exists)
- Bring up the stack:
  - `docker compose up -d --build`

Traefik labels overview (see [docker-compose.yml](docker-compose.yml))

- Protected API:
  - Router: `Host('codex-api.example.com') && PathPrefix('/v1')`
  - EntryPoints: `websecure`, `tls=true`
  - Middleware: `codex-forwardauth` pointing to `http://127.0.0.1:18080/verify`
  - Service port: `11435`
- Public health:
  - Router: `Host('codex-api.example.com') && Path('/healthz')`
  - EntryPoints: `websecure`, `tls=true`
  - Service: same as API service

Smoke tests

- Health (public):
  - `curl -i https://codex-api.example.com/healthz`
- Protected route (no token → 401):
  - `curl -i https://codex-api.example.com/v1/models`
- Wrong token → 401:
  - `curl -i -H 'Authorization: Bearer wrong' https://codex-api.example.com/v1/models`
- Correct token → 200 (replace VALUE):
  - `curl -i -H 'Authorization: Bearer VALUE' https://codex-api.example.com/v1/models`
- SSE streaming sanity:
  - `curl -N -H 'Authorization: Bearer VALUE' -H 'Content-Type: application/json' \\`
  - `  -d '{"model":"gpt-5.2","stream":true,"messages":[{"role":"user","content":"ping"}]}' \\`
  - `  https://codex-api.example.com/v1/chat/completions`

Notes

- The app already sets headers for SSE in [streaming branch](server.js:120) and disables buffering with `X-Accel-Buffering: no`. Traefik streams by default.
- Do not expose the app’s container port on the host. Traefik connects via the Docker network `traefik`.
- Keep `PROXY_API_KEY` out of images and source control. Provide via environment or a Docker secret.

## Security Hardening

This repository ships an edge-first security posture when deployed via Traefik and Cloudflare. Key elements:

- Layered CORS: Traefik enforces an allowlist via `accessControlAllowOriginList`, and the app reflects only the origins present in `PROXY_CORS_ALLOWED_ORIGINS`. Disable app CORS (`PROXY_ENABLE_CORS=false`) if you prefer the edge to be the single enforcement point.
- Preflight router: Host-scoped `OPTIONS` router uses `noop@internal` so the origin is never hit, with middlewares `codex-cors,codex-headers,codex-ratelimit`.
- Security headers: HSTS, frame deny, nosniff, referrer policy, and a restrictive `Permissions-Policy` (includes `interest-cohort=()`).
- Rate limiting: `codex-ratelimit` applied before ForwardAuth to shield the auth service.

Cloudflare CORS Worker

- Worker name: `codex-preflight-logger`. Lives under `workers/cors-preflight-logger` and reflects the incoming Origin plus _all_ requested preflight headers for trusted origins (`app://obsidian.md`, `capacitor://localhost`, `http://localhost`, `https://localhost`, and the hosted domains).
- Deploy with `./workers/cors-preflight-logger/deploy.sh` (requires `WORKER_CLOUDFLARE_API_TOKEN` granting Workers Scripts + Routes). The `wrangler.toml` attaches the worker to both `codex-dev` and `codex-api` hostnames.
- The worker logs every OPTIONS/POST via `console.log`, making `wrangler tail codex-preflight-logger --format json --sampling-rate 0.5` ideal for on-call investigations.
- Keep Traefik’s `codex-cors` middleware and `PROXY_CORS_ALLOWED_ORIGINS` in sync with the worker allowlist. Traefik still guards preflights with `noop@internal` so the origin only sees vetted requests.

Optional Transform Rule (only if Workers unavailable)

- Rules → Transform Rules → Response Header Modification → Create
  - When: Host equals your domain + Path starts with `/v1/` + Method in OPTIONS, GET, POST, HEAD
  - Set headers:
    - Access-Control-Allow-Origin: explicit origin string or `$http_origin` (if supported)
    - Access-Control-Allow-Methods: `GET, POST, HEAD, OPTIONS`
    - Access-Control-Allow-Headers: include all headers sent by your clients (Stainless adds `X-Stainless-*`, Obsidian iOS sends `user-agent`)
    - Access-Control-Max-Age: `600`

Preflight smoke test

```bash
curl -i -X OPTIONS 'https://codex-api.example.com/v1/chat/completions' \
  -H 'Origin: app://obsidian.md' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, content-type, x-stainless-os'
# Expect: ACAO echoes the Origin, Allow-Methods present, Allow-Headers includes union (e.g., X-Stainless-* + user-agent).
# Mobile smoke: swap the Origin header to `capacitor://localhost` (or `capacitor://localhost/`) to emulate Obsidian iOS; use `http://localhost:1313` to mimic Android.
```

Tightening origins

- Default is `Access-Control-Allow-Origin: *` (safe with bearer tokens; no cookies). To restrict:
- Set a Traefik allowlist via `accessControlAllowOriginList[...]` and regex entries (include `app://obsidian.md`, `capacitor://localhost`, `http://localhost`, `https://localhost`, and trusted web origins).
  - Update the Cloudflare transform rule to either reflect the request `Origin` (Worker) or set an explicit allowlist value.
- Streaming usage event (in-band): Include `"stream_options": { "include_usage": true }` to receive a final SSE usage event: `data: {"event":"usage","usage":{"prompt_tokens":N,"completion_tokens":M,"total_tokens":N+M}}`.
- Ask the model directly: Send a user message like `usage today`, `usage yesterday`, `usage last 7d`, or `usage start=2025-09-01 end=2025-09-02 group=hour`. The proxy detects these simple queries and responds with a usage summary without invoking the backend model.

## Branch status

This branch (`main-p`) runs the app-server worker supervisor (stateless per request, but workers stay warm between calls). Feature branches exist but are not merged:

- `feat/playwright-tests`: Playwright API/SSE tests with a deterministic shim.
- `feat/prompt-cache-resume`: experimental, feature-gated caching hooks.

They remain idle; refer to their commit messages for details.
