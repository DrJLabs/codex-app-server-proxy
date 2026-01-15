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

If you need a local build instead of GHCR, set `IMAGE` explicitly or use the local compose example ([`../../infra/compose/docker-compose.local.example.yml`](../../infra/compose/docker-compose.local.example.yml)).

## Verify

- Health (origin): `curl -s 127.0.0.1:11435/healthz | jq .`
- Smoke script (origin + edge): `DOMAIN=<your-domain> KEY=<your-key> npm run smoke:prod`
- Optional live E2E: `LIVE_BASE_URL=https://<your-domain> KEY=<your-key> npm run test:live`

## Notes

- Keep `PROXY_SANDBOX_MODE=read-only` by default; overriding to `danger-full-access` can surprise clients that attempt tool-driven writes.
- Use `PROXY_CODEX_WORKDIR` (default `/tmp/codex-work`) for child working files; do not rely on it to redirect Codex’s own rollout/session state away from `CODEX_HOME`.
