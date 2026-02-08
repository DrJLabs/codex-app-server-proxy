# Compose Layout

This repository keeps production Compose at the repo root and dev/local Compose templates under `compose/`.

## Files

- `../docker-compose.yml`
  - Production compose source of truth (Traefik labels, external `traefik` network, `.codex-api` mount).
  - Optional `app-responses` service is behind the `responses` profile.
  - Used by: `npm run prod:stack:*`, `docker compose up ...` on the production host.
- `dev-stack.base.yml`
  - Dev stack base (services, env, mounts, networks). Does not contain list fields that are easy to accidentally duplicate.
- `dev-stack.override.yml`
  - Dev stack overlay (ports + Traefik `labels` list).
  - This file exists because Docker Compose merges lists by concatenation when multiple `-f` files are used.
  - Used by: `npm run dev:stack:*` (via `scripts/dev-stack.sh`).
- `docker-compose.local.example.yml`
  - Local build example (no Traefik required). Copy to `docker-compose.local.yml` and run with `docker compose -f docker-compose.local.yml ...`.

## Commands

- Dev stack:
  - `npm run dev:stack:up`
  - `npm run dev:stack:down`
  - `npm run dev:stack:logs`
  - `npm run dev:stack:config` (render merged config)
- Prod stack:
  - `npm run prod:stack:up`
  - `npm run prod:stack:down`
  - `npm run prod:stack:logs`
  - `npm run prod:stack:rebuild`
  - `npm run prod:stack:config` (render merged config)

## Where To Edit

- Dev Traefik routing/headers/ratelimit: `dev-stack.override.yml`
- Dev env/mounts/timeouts/worker knobs: `dev-stack.base.yml`
- Production routing/ports/profiles: `../docker-compose.yml`
