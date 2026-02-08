# Compose File Map

This repository uses multiple Docker Compose files for different run modes. This page is the canonical map.

## Production

- `docker-compose.yml`
  - Source of truth for production runtime and Traefik labels.
  - Runs the published image (defaults to `ghcr.io/drjlabs/codex-app-server-proxy:latest`) and should be deployed with `--pull always`.
  - Optional `app-responses` service is behind the `responses` profile (disabled by default).
  - Used by:
    - `npm run prod:stack:*` (`scripts/prod-stack.sh`)
    - `docker compose up -d --pull always --force-recreate` on the production host

### Optional: Local Build Override

- `compose/prod.local-build.override.yml`
  - Adds `build:` to the production services so the stack can be built locally from the repo checkout.
  - Enabled via: `PROD_LOCAL_BUILD=1 npm run prod:stack:up`
  - Optional tag: `PROD_LOCAL_IMAGE=codex-app-server-proxy:local`

## Dev Stack (Traefik + ForwardAuth)

The dev stack is defined as an overlay: base + override.

- `compose/dev-stack.base.yml`
  - Core services and config (env, mounts, networks).
  - Avoids list fields that are easy to accidentally duplicate across overlays.
- `compose/dev-stack.override.yml`
  - Overlay containing list fields:
    - `ports` (loopback publish)
    - Traefik `labels` list

Used by:
- `npm run dev:stack:*` (`scripts/dev-stack.sh`)
- Render effective config with: `npm run dev:stack:config`

## Local Build Example (No Traefik)

- `compose/docker-compose.local.example.yml`
  - Example template for local “build + run” using the repo Dockerfile.
  - Copy to `docker-compose.local.yml` (ignored by git) and run:
    - `docker compose -f docker-compose.local.yml up --build`
