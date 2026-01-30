# Configuration

This proxy is configured via environment variables. Defaults live in [`../src/config/index.js`](../src/config/index.js) (source of truth).

## Where config is loaded from

- Local Node dev (`npm run dev` / `npm run dev:shim`) loads `.env` via `scripts/dev.sh`.
- Dev stack (`infra/compose/compose.dev.stack.yml`) loads `.env.dev`.
- Prod compose (`docker-compose.yml`) loads `.env` on the host.

## Core settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_API_KEY` | `codex-local-secret` | Bearer token for protected routes |
| `PORT` | `11435` | Listen port |
| `PROXY_HOST` | `0.0.0.0` | Listen host |
| `PROXY_ENV` | *(empty)* | Model advertising mode (`dev` → `codev-5*`) |

## Backend selection

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_USE_APP_SERVER` | `true` | `true` uses app-server JSON-RPC; `false` disables the backend (returns `app_server_disabled`) |
| `CODEX_BIN` | `codex` | Codex CLI binary (or shim path) |
| `CODEX_HOME` | `$PROJECT/.codex-api` | Codex home/config directory |
| `CODEX_MODEL` | `gpt-5.2` | Default effective model (proxy also accepts `codex-5*` / `codev-5*`) |
| `CODEX_FORCE_PROVIDER` | *(empty)* | Force Codex provider (e.g., `chatgpt`) |
| `PROXY_ENABLE_WEB_SEARCH_REQUEST` | `false` | Force app-server `web_search_request=true` and disable legacy `tools.web_search` |

### `CODEX_HOME` and `AGENTS.md`

Codex CLI reads `config.toml` and `AGENTS.md` from `CODEX_HOME`.

- Dev workflows commonly use `.codev/` as `CODEX_HOME`.
- In this repo, `.codev/AGENTS.md` is the Obsidian Copilot prompt/instructions used by the Codex backend for tool-call output; it is intentionally not repository contributor guidance.

## Sandbox and workdir

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_SANDBOX_MODE` | `read-only` | Sandbox policy passed to Codex (`read-only`, `workspace-write`, `danger-full-access`) |
| `PROXY_CODEX_WORKDIR` | `/tmp/codex-work` | Child working directory (ephemeral writes) |
| `PROXY_DISABLE_INTERNAL_TOOLS` | `true` | Disable Codex internal tools (shell/apply_patch/etc); only dynamic tool calls are allowed |

## Endpoint toggles and auth gates

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_ENABLE_RESPONSES` | `true` | Enable `/v1/responses` |
| `PROXY_PROTECT_MODELS` | `false` | Require bearer for `/v1/models` |
| `PROXY_USAGE_ALLOW_UNAUTH` | `false` | Allow unauthenticated access to `/v1/usage*` |
| `PROXY_TEST_ENDPOINTS` | `false` | Enable `__test/*` endpoints (dev/CI only) |
| `PROXY_TEST_ALLOW_REMOTE` | `false` | Allow `__test/*` from non-loopback |

## CORS

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_ENABLE_CORS` | `true` | Enable app-level CORS headers |
| `PROXY_CORS_ALLOWED_ORIGINS` | `*` | Allowed origins (comma-separated) |

## Metrics and tracing

- Metrics: set `PROXY_ENABLE_METRICS=true` to expose `/metrics` (access is restricted by default; see [`../src/routes/metrics.js`](../src/routes/metrics.js)).
- Tracing: set `PROXY_ENABLE_OTEL=true` and `PROXY_OTEL_EXPORTER_URL` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) to emit spans (see [`../src/services/tracing.js`](../src/services/tracing.js)).

## Dev-only raw capture (responses)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_CAPTURE_APP_SERVER_RAW` | `false` | Capture app-server JSON-RPC payloads (dev-only) |
| `PROXY_CAPTURE_APP_SERVER_RAW_DIR` | `test-results/app-server/raw` | Directory for app-server raw NDJSON |
| `PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES` | `262144` | Per-record size guard for raw payloads |
| `PROXY_CAPTURE_THINKING_RAW` | `false` | Capture pre-sanitized response deltas (dev-only) |
| `PROXY_CAPTURE_THINKING_RAW_DIR` | `test-results/responses-copilot/raw-thinking` | Directory for raw thinking NDJSON |
| `PROXY_CAPTURE_THINKING_RAW_MAX_BYTES` | `262144` | Per-record size guard for thinking capture |

These captures are only active when `PROXY_ENV=dev`.

## Further reference

- Config/mount matrix by environment: [`reference/config-matrix.md`](reference/config-matrix.md)
- API contract: [`openai-endpoint-golden-parity.md`](openai-endpoint-golden-parity.md)
