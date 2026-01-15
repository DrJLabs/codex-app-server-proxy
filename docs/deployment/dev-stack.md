# Dev Stack ([../../infra/compose/compose.dev.stack.yml](../../infra/compose/compose.dev.stack.yml))

The dev stack mirrors production behind Traefik and a ForwardAuth service, but runs as a local compose project.

## Configure

1. Copy the example env file:

   ```bash
   cp .env.dev.example .env.dev
   ```

2. Set `PROXY_API_KEY` and (optionally) `DEV_DOMAIN` in `.env.dev`.

## Run

```bash
npm run dev:stack:up
npm run dev:stack:logs
```

The stack defaults to `http://127.0.0.1:18010/v1`.

## Verify

```bash
KEY="<your-dev-key>"
curl -s http://127.0.0.1:18010/healthz | jq .
curl -s http://127.0.0.1:18010/v1/models | jq .
```

## Notes

- ForwardAuth in the dev stack uses `http://127.0.0.1:18081/verify`.
- By default the stack uses the real Codex CLI if mounted; you can point `CODEX_BIN` at a shim for offline testing.
