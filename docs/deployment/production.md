# Production Deployment (docker-compose.yml)

[`../../docker-compose.yml`](../../docker-compose.yml) in this repository is the source of truth for production routing labels and runtime expectations.

## Assumptions

- Traefik runs as a host/system service (not containerized) and uses ForwardAuth at `http://127.0.0.1:18080/verify`.
- The app container is attached to the external `traefik` Docker network.
- The production Codex home directory (`.codex-api/`) is bind-mounted and **must be writable**.

## Configure

1. Create `.env` on the production host and set `PROXY_API_KEY` (and any overrides).
2. Provision `./.codex-api/` on the production host with at least:
   - `config.toml`
   - `auth.json` (and any other Codex credentials needed at runtime)
3. Worker concurrency:
   - `WORKER_MAX_CONCURRENCY` controls how many in-flight app-server requests a single proxy instance will allow.
   - In production, `docker-compose.yml` defaults this to `8` to avoid tripping `app-server worker at capacity` (the code default is `4`).
   - You can override it via `.env` if needed.

## Optional: Copilot trace header injection

For better Copilot request correlation, you can inject `x-copilot-trace-id` at the edge (e.g. Traefik middleware)
when the `User-Agent` indicates Obsidian Copilot. If your edge cannot generate per-request IDs, skip this and rely
on the proxy-generated `copilot_trace_id` in logs.

Example Traefik snippet:

```yaml
# /etc/traefik/dynamic/codex-api.yml
http:
  middlewares:
    copilot-trace:
      headers:
        customRequestHeaders:
          x-copilot-trace-id: "${COPILOT_TRACE_ID:-}" # placeholder; replace with per-request ID from your edge
```

## Deploy

```bash
docker compose up -d --pull always --force-recreate
```

### Optional: Use Repo Scripts

If you are deploying from a checkout of this repository on the production host, you can use:

```bash
npm run prod:stack:up
npm run prod:stack:down
npm run prod:stack:logs
npm run prod:stack:config
npm run prod:stack:rebuild
```

By default, this does not start the optional `app-responses` compose profile. To include it:

```bash
PROD_ENABLE_RESPONSES=1 npm run prod:stack:up
```

### Optional: Local Build on the Production Host

By default, production pulls a published image from GHCR. If you need to build locally from this repo checkout
(for example, to test an un-pushed Dockerfile change), you can enable the local-build override:

```bash
PROD_LOCAL_BUILD=1 npm run prod:stack:up
```

Optionally tag the built image:

```bash
PROD_LOCAL_BUILD=1 PROD_LOCAL_IMAGE=codex-app-server-proxy:local-test npm run prod:stack:up
```

### Optional: Dedicated Responses Host (compose profile)

`docker-compose.yml` contains an optional `app-responses` service that can host `/v1/responses` on a dedicated
domain (separate Traefik routers) and with a separate Codex home directory (`.codex-responses-api/`).

This service is disabled by default and is only started when the `responses` profile is enabled:

```bash
docker compose --profile responses up -d --pull always --force-recreate
```

If you enable it, set `RESPONSES_DOMAIN` (and optionally `RESPONSES_CORS_ALLOWED_ORIGINS`, `RESPONSES_HOST_PORT`,
and `RESPONSES_PORT`) and provision `./.codex-responses-api/` with Codex credentials (mirrors `.codex-api/`).

If you need a local build instead of GHCR, set `IMAGE` explicitly or use the local compose example ([`../../compose/docker-compose.local.example.yml`](../../compose/docker-compose.local.example.yml)).

## Verify

- Health (origin): `curl -s 127.0.0.1:11435/healthz | jq .`
- Smoke script (origin + edge): `DOMAIN=<your-domain> KEY=<your-key> npm run smoke:prod`
- Optional tool smoke (only if tool calling is enabled): `SMOKE_TOOL_CALLS=1 DOMAIN=<your-domain> KEY=<your-key> npm run smoke:prod`
- Optional live E2E: `LIVE_BASE_URL=https://<your-domain> KEY=<your-key> npm run test:live`

## Notes

- Keep `PROXY_SANDBOX_MODE=read-only` by default; overriding to `danger-full-access` can surprise clients that attempt tool-driven writes.
- Use `PROXY_CODEX_WORKDIR` (default `/tmp/codex-work`) for child working files; do not rely on it to redirect Codex’s own rollout/session state away from `CODEX_HOME`.
