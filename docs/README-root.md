# Codex App-Server Proxy - OpenAI Responses-first proxy for Codex CLI

Goal: let any OpenAI Responses client (SDKs, IDEs, curl) talk to Codex CLI as if it were a standard model API. `/v1/responses` is the primary endpoint; `/v1/chat/completions` remains for compatibility (especially Obsidian Copilot). The proxy exposes `/v1/models`, `/v1/responses`, and `/v1/chat/completions`, streams with SSE, and keeps output shaping minimal so existing tools work without changes.

> Disclaimer: This project is an independent community effort and is not affiliated with or endorsed by OpenAI.

## Features

- OpenAI-compatible endpoints: `/v1/responses` (primary), `/v1/chat/completions` (compat), `/v1/models`.
- `/v1/responses` uses native Responses semantics: `input`/`instructions` only (no `messages`) and `function_call` output items (with `call_id`).
- Streaming SSE with role-first deltas and `[DONE]` termination.
- Output modes for different clients (`openai-json` for Responses, `obsidian-xml` for Copilot).
- Deterministic JSON-RPC shim for CI/offline dev (`scripts/fake-codex-jsonrpc.js`).
- Environment-specific model IDs (dev `codev-*`, prod `codex-*`) with automatic normalization.

## Quick start (local Node)

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local env file and set your bearer key:

   ```bash
   cp .env.example .env
   ```

   Update `PROXY_API_KEY` in `.env` to a value you will use for local auth.

3. Start the dev server (defaults to port 18000 in dev mode; `PORT` below applies to `node server.js` and compose):

   ```bash
   npm run dev
   ```

4. Verify:

   ```bash
   curl -s http://127.0.0.1:18000/healthz | jq .
   curl -s http://127.0.0.1:18000/v1/models | jq .
   ```

No Codex CLI installed? Run the deterministic shim instead:

```bash
npm run dev:shim
```

## Quick start (Docker Compose)

- Production-style (pulls GHCR image, requires `DOMAIN` and `PROXY_CORS_ALLOWED_ORIGINS`):

  ```bash
  DOMAIN=example.com \
  PROXY_CORS_ALLOWED_ORIGINS=https://example.com \
  PROXY_API_KEY=codex-local-secret \
  docker compose up -d
  ```

- Local build:

  ```bash
  cp infra/compose/docker-compose.local.example.yml docker-compose.local.yml
  PROXY_API_KEY=codex-local-secret docker compose -f docker-compose.local.yml up --build
  ```

For production requirements (Traefik, Codex HOME, auth), see [docs/deployment/production.md](deployment/production.md).

## Choose your client path

- Standard Responses clients: use `/v1/responses` and keep the default `openai-json` output mode. See [docs/api/responses.md](api/responses.md) and [docs/api/overview.md](api/overview.md).
- Obsidian Copilot: Copilot chooses the endpoint based on the selected model. With current ChatGPT-login Codex support (gpt-5*), it uses `/v1/responses`. If you select a chat-completions model, it uses `/v1/chat/completions` with streaming enabled and expects tool blocks as text (`obsidian-xml`). See [docs/api/chat-completions.md](api/chat-completions.md) and [docs/getting-started.md](getting-started.md).

## Minimal configuration

| Variable                      | Default              | Purpose                                                                 |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `PROXY_API_KEY`               | `codex-local-secret` | Bearer token for protected routes                                       |
| `PORT`                        | `11435`              | Listen port for `node server.js`/compose (dev script defaults to 18000) |
| `PROXY_ENV`                   | `_(empty)_`          | Model advertising mode (`dev` -> `codev-*`)                             |
| `PROXY_ENABLE_RESPONSES`      | `true`               | Enable `/v1/responses`                                                  |
| `PROXY_OUTPUT_MODE`           | `obsidian-xml`       | Default output mode for `/v1/chat/completions`                          |
| `PROXY_RESPONSES_OUTPUT_MODE` | `openai-json`        | Default output mode for `/v1/responses`                                 |

Full configuration and defaults: [docs/configuration.md](configuration.md).

## Optional external references

If you want local copies of upstream Codex or Obsidian Copilot for compatibility checks,
populate the ignored `external/` directory via (requires `jq`):

```bash
scripts/fetch-external.sh
```

See [external/README.md](../external/README.md) for details.

## Documentation map

- [docs/README.md](README.md) - doc index
- [docs/getting-started.md](getting-started.md) - first run walkthroughs
- [docs/local-development.md](local-development.md) - local workflows (Node vs shim vs compose)
- [docs/api/overview.md](api/overview.md) - endpoint overview + curl examples
- [docs/api/responses.md](api/responses.md) - `/v1/responses` usage notes
- [docs/api/chat-completions.md](api/chat-completions.md) - `/v1/chat/completions` usage notes
- [docs/configuration.md](configuration.md) - environment variables and defaults
- [docs/deployment/dev-stack.md](deployment/dev-stack.md) - dev stack compose
- [docs/deployment/production.md](deployment/production.md) - production compose + Traefik
- [docs/ops/runbooks.md](ops/runbooks.md) - smoke, snapshot, rollback, backup
- [docs/observability.md](observability.md) - logs, metrics, tracing
- [docs/reference/config-matrix.md](reference/config-matrix.md) - environment/mount matrix
- [docs/troubleshooting.md](troubleshooting.md) - common issues
- [docs/openai-endpoint-golden-parity.md](openai-endpoint-golden-parity.md) - parity contract
- [docs/responses-endpoint/overview.md](responses-endpoint/overview.md) - `/v1/responses` implementation notes
- [docs/responses-endpoint/app-server-tools.md](responses-endpoint/app-server-tools.md) - tool manifest limitations
- [docs/responses-endpoint/obsidian-tool-call-simulation.md](responses-endpoint/obsidian-tool-call-simulation.md) - OpenAI-parity tool-call simulation
- [docs/responses-endpoint/prompt-injection.md](responses-endpoint/prompt-injection.md) - responses tool-call prompt injection matrix
- [docs/reference/app-server-protocol.schema.json](reference/app-server-protocol.schema.json) - JSON-RPC schema bundle
- [docs/reference/app-server-schema-0.89-tools.md](reference/app-server-schema-0.89-tools.md) - app-server tools schema
- [docs/logging-gaps/README.md](logging-gaps/README.md) - observability gap tracker
- [docs/plans/2026-01-25-obsidian-tool-call-simulation-v2.md](plans/2026-01-25-obsidian-tool-call-simulation-v2.md) - tool-call simulation v2 plan

## Contributing

See `CONTRIBUTING.md` for local setup and workflow expectations.

## License

This project is released under the [MIT License](LICENSE).
