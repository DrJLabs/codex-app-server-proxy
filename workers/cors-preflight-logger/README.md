# CORS Preflight Logger Worker

This worker logs incoming requests (especially CORS preflights) and mirrors
server-side CORS headers before proxying down to the existing tunnel/Traefik stack.

## Deploy with a dedicated API token

To avoid interfering with other tooling that relies on your primary
`CLOUDFLARE_API_TOKEN`, create a separate token with the following permissions:

- **Account → Workers Scripts:** Edit
- **Zone → Workers Routes:** Edit (for `example.com`)
- Optional but helpful: Workers Tail (Read) so you can stream logs.

Then export it under a different environment variable, e.g.:

```bash
export WORKER_CLOUDFLARE_API_TOKEN=cf_api_token_for_workers
```

## Render the Wrangler config

This repo tracks `wrangler.example.toml`. Generate the real `wrangler.toml`
before deploy so routes and allowed origins are set from your env:

```bash
DOMAIN=codex-api.example.com DEV_DOMAIN=codex-dev.example.com ZONE_NAME=example.com \
  bash ../../scripts/render-infra.sh
```

`ALLOWED_ORIGINS` is set in `wrangler.toml` and read by the worker at runtime.

Deploy using the helper script:

```bash
cd workers/cors-preflight-logger
./deploy.sh
```

The script injects the `WORKER_CLOUDFLARE_API_TOKEN` value into `wrangler deploy`
without touching your existing global `CLOUDFLARE_API_TOKEN`.

## Tail logs

Once deployed, you can tail the worker logs with the same token:

```bash
CLOUDFLARE_API_TOKEN="$WORKER_CLOUDFLARE_API_TOKEN" wrangler tail
```

This will stream JSON entries containing the Origin, user-agent, and CORS header
requests sent by the mobile app.
