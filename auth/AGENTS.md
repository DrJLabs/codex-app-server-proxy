# Agent instructions (scope: this directory and subdirectories)

## Scope and layout

- **This AGENTS.md applies to:** `auth/` and below.
- **Owner:** ForwardAuth.
- **Key files:**
  - `server.mjs` canonical Traefik ForwardAuth service (CORS + bearer verification).
  - `package.json` (type: module).

## Architecture (high-level)

- Style: **layered** (HTTP listener → auth check helper).
- Boundaries:
  - Keep bearer parsing/validation in helpers; server loop should stay thin and side-effect free beyond logging.
  - Maintain CORS handling in one place (`buildCors`); do not duplicate across routes.

## Commands

- Dev/prod-local run: `PROXY_API_KEY=<bearer> PORT=18080 node auth/server.mjs` (dev stack uses 18081).
- Health: `curl -s http://127.0.0.1:$PORT/healthz`.
- Verify: `curl -i -H "Authorization: Bearer $PROXY_API_KEY" http://127.0.0.1:$PORT/verify`.

## Conventions

- Always keep `/verify` on loopback and reuse the same `PROXY_API_KEY` as the proxy.
- Leave CORS preflight pass-through (`OPTIONS` 204) so Traefik can forward requests.
- Maintain `WWW-Authenticate` realm header; responses stay JSON with `error.message`.
- Avoid logging secrets; no request body parsing should be added here.

## Common pitfalls

- Do not add legacy entrypoints; keep `server.mjs` as the single canonical ForwardAuth service.
- Do not change path names or ports without updating compose/Traefik configs and running smoke tests.
- Ensure `PROXY_API_KEY` is set; missing secrets should fail closed (401).

## Do not

- Do not commit bearer keys or other secrets.
- Do not add new routes beyond `/healthz` and `/verify` without aligning Traefik configs and tests.

## Verifiable config

```codex-guidelines
{
  "version": 1,
  "format": {
    "autofix": true,
    "commands": ["cd .. && npx prettier -c auth/{files}"],
    "windows": [],
    "posix": []
  },
  "lint": {
    "commands": [
      "cd .. && npx eslint --ext .js,.mjs,.ts --no-error-on-unmatched-pattern auth/{files}"
    ],
    "windows": [],
    "posix": []
  },
  "test": {
    "commands": [],
    "optional": true,
    "windows": [],
    "posix": []
  },
  "rules": {
    "forbid_globs": [],
    "forbid_regex": []
  }
}
```
