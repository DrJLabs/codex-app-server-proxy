# Local Development

This document focuses on running the proxy locally for development and debugging.

## Run modes

| Mode | Command | Default port | Requires Codex install | Notes |
| --- | --- | ---:| --- | --- |
| Dev (recommended) | `npm run dev` | 18000 | Yes | Loads `.env`, seeds `.codev` config into `CODEX_HOME` |
| Dev shim | `npm run dev:shim` | 18000 | No | Uses [`../scripts/fake-codex-jsonrpc.js`](../scripts/fake-codex-jsonrpc.js) |
| Minimal start | `node server.js` | 11435 | Yes | Uses `.codex-api/` as default `CODEX_HOME` |
| Start with `.codev` | `npm run start:codev` | 18000 | Yes | Sets `CODEX_HOME=.codev` |
| Start `.codev` shim | `npm run start:codev:shim` | 18000 | No | Uses [`../scripts/fake-codex-jsonrpc.js`](../scripts/fake-codex-jsonrpc.js) |

## Environment and model IDs

- The server advertises environment-specific model IDs from `GET /v1/models`.
- Set `PROXY_ENV=dev` to advertise `codev-5*` (recommended for local/dev stacks).
- When `PROXY_ENV` is unset, the server advertises `codex-5*`.
- Both prefixes are accepted for requests, but some clients validate strictly against advertised IDs.

## Docker workflows

- Local compose example: [`../infra/compose/docker-compose.local.example.yml`](../infra/compose/docker-compose.local.example.yml) (copy to `docker-compose.local.yml`)
- Dev stack: [`../infra/compose/compose.dev.stack.yml`](../infra/compose/compose.dev.stack.yml) via:

  ```bash
  npm run dev:stack:up
  npm run dev:stack:logs
  npm run dev:stack:down
  ```

## External references (optional)

Compatibility checks sometimes refer to upstream Codex or Obsidian Copilot behavior. If you want
local reference copies, populate `external/` (ignored by git) via:

```bash
scripts/fetch-external.sh
```

See [`../external/README.md`](../external/README.md) for details.

## Useful checks

```bash
curl -s http://127.0.0.1:18000/healthz | jq .
curl -s http://127.0.0.1:18000/v1/models | jq .
```

For authenticated routes:

```bash
KEY="<your-dev-key>"
curl -s http://127.0.0.1:18000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"codev-5","stream":false,"messages":[{"role":"user","content":"Say hello."}]}' | jq .
```

## Where to look

- Routing/middleware: [`../src/app.js`](../src/app.js)
- Env defaults: [`../src/config/index.js`](../src/config/index.js)
- Health probes: [`../src/routes/health.js`](../src/routes/health.js)
- Streaming/non-stream handlers: [`../src/handlers/`](../src/handlers/)
