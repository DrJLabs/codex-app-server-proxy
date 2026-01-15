# Codex App-Server Proxy - OpenAI Responses-first proxy for Codex CLI

Goal: let any OpenAI Responses client (SDKs, IDEs, curl) talk to Codex CLI as if it were a standard model API. `/v1/responses` is the primary endpoint; `/v1/chat/completions` remains for compatibility (especially Obsidian Copilot). The proxy exposes `/v1/models`, `/v1/responses`, and `/v1/chat/completions`, streams with SSE, and keeps output shaping minimal so existing tools work without changes.

> Disclaimer: This project is an independent community effort and is not affiliated with or endorsed by OpenAI.

## Features

- OpenAI-compatible endpoints: `/v1/responses` (primary), `/v1/chat/completions` (compat), `/v1/models`.
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

3. Start the dev server (port 18000 by default):

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

- Production-style (pulls GHCR image):

  ```bash
  PROXY_API_KEY=codex-local-secret docker compose up -d
  ```

- Local build:

  ```bash
  cp infra/compose/docker-compose.local.example.yml docker-compose.local.yml
  PROXY_API_KEY=codex-local-secret docker compose -f docker-compose.local.yml up --build
  ```

For production requirements (Traefik, Codex HOME, auth), see [docs/deployment/production.md](docs/deployment/production.md).

## Choose your client path

- Standard Responses clients: use `/v1/responses` and keep the default `openai-json` output mode. See [docs/api/responses.md](docs/api/responses.md) and [docs/api/overview.md](docs/api/overview.md).
- Obsidian Copilot: Copilot chooses the endpoint based on the selected model. With current ChatGPT-login Codex support (gpt-5*), it uses `/v1/responses`. If you select a chat-completions model, it uses `/v1/chat/completions` with streaming enabled and expects tool blocks as text (`obsidian-xml`). See [docs/api/chat-completions.md](docs/api/chat-completions.md) and [docs/getting-started.md](docs/getting-started.md).

## Minimal configuration

| Variable                      | Default              | Purpose                                        |
| ----------------------------- | -------------------- | ---------------------------------------------- |
| `PROXY_API_KEY`               | `codex-local-secret` | Bearer token for protected routes              |
| `PORT`                        | `11435`              | Listen port                                    |
| `PROXY_ENV`                   | _(empty)_            | Model advertising mode (`dev` -> `codev-*`)    |
| `PROXY_ENABLE_RESPONSES`      | `true`               | Enable `/v1/responses`                         |
| `PROXY_OUTPUT_MODE`           | `obsidian-xml`       | Default output mode for `/v1/chat/completions` |
| `PROXY_RESPONSES_OUTPUT_MODE` | `openai-json`        | Default output mode for `/v1/responses`        |

Full configuration and defaults: [docs/configuration.md](docs/configuration.md).

## Documentation map

- [docs/README.md](docs/README.md) - doc index
- [docs/getting-started.md](docs/getting-started.md) - first run walkthroughs
- [docs/local-development.md](docs/local-development.md) - local workflows (Node vs shim vs compose)
- [docs/api/overview.md](docs/api/overview.md) - endpoint overview + curl examples
- [docs/configuration.md](docs/configuration.md) - environment variables and defaults
- [docs/deployment/production.md](docs/deployment/production.md) - production compose + Traefik
- [docs/ops/runbooks.md](docs/ops/runbooks.md) - smoke, snapshot, rollback, backup
- [docs/observability.md](docs/observability.md) - logs, metrics, tracing
- [docs/troubleshooting.md](docs/troubleshooting.md) - common issues

## Contributing

See `CONTRIBUTING.md` for local setup and workflow expectations.

## License

This project is released under the [MIT License](LICENSE).
