# ForwardAuth service

This directory contains the Traefik ForwardAuth verifier used to gate the proxy at the edge. It is **not** imported by the proxy runtime; it runs as a standalone HTTP service and is called by Traefik on `/verify`.

## What it does

- Validates `Authorization: Bearer <PROXY_API_KEY>` on `/verify`.
- Exposes `/healthz` for readiness checks.
- Mirrors CORS behavior for preflight requests.

## Running locally

```bash
PROXY_API_KEY=your-key PORT=18080 node auth/server.mjs
```

Then verify:

```bash
curl -i -H "Authorization: Bearer $PROXY_API_KEY" http://127.0.0.1:18080/verify
```

## Deployment notes

- Compose stacks run this on loopback: `127.0.0.1:18080` (prod) or `127.0.0.1:18081` (dev).
- Keep `server.mjs` canonical; do not add legacy entrypoints.
