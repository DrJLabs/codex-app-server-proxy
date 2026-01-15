# Domain Scrub + Template Generation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all example.com literals from tracked files while keeping infra functional by using env-driven Compose/scripts and generated templates for Cloudflare/Wrangler artifacts.

**Architecture:** Use native Docker Compose variable substitution (from `.env` / `.env.dev`) for Traefik labels and CORS allowlists. Use `.example` templates plus a render script for Cloudflare JSON and Wrangler config; generated outputs are gitignored and created from required env vars. Update the CORS worker to read allowed origins from env (plus fixed local origins).

**Tech Stack:** Docker Compose v2, bash, Cloudflare Workers + Wrangler, Node/JS.

## Goal
- Remove literal example.com references from tracked files without breaking runtime behavior when envs are set.

## Assumptions / constraints
- Compose runs with `.env` / `.env.dev` available.
- Cloudflare rules and Wrangler routes are environment-specific and should be generated, not tracked.
- Generated files must be gitignored; templates remain tracked.
- Fail fast if required envs are missing instead of using real-domain defaults.

## Research (current state)
- Hardcoded domain values exist in:
  - `docker-compose.yml`, `infra/compose/compose.dev.stack.yml` (Traefik labels, CORS allowlists)
  - `infra/cloudflare/rht.json`, `infra/cloudflare/rht_update.json` (host expressions)
  - `workers/cors-preflight-logger/wrangler.toml` (routes)
  - `workers/cors-preflight-logger/src/index.js` (ALLOWED list)
  - `package.json`, `scripts/*.sh` (defaults/comments)

## Analysis
### Options
1) Native env substitution for Compose/scripts + templates for Cloudflare/Wrangler + env-driven worker allowlist.
2) Keep files tracked with example.com placeholders.
3) Gitignore infra files and require manual edits only.

### Decision
- Chosen: Option 1 (env substitution + templates + generator).
- Why: Scrubs real domain while keeping infra reproducible; minimizes accidental drift and keeps deployments functional when envs are set.

### Risks / edge cases
- Missing envs could render empty Traefik rules or invalid Cloudflare expressions.
- Compose substitution inside label strings must be carefully quoted.
- Worker allowlist should include local origins to avoid regressions.

### Open questions
- None (direction confirmed: env substitution + templates + gitignore generated files).

## Q&A (answer before implementation)
- Q: Use native .env substitution for Compose/scripts and templates + generator for Cloudflare/Wrangler? A: Yes.
- Q: Gitignore generated outputs? A: Yes.

## Implementation plan

### Task 1: Add template generation + gitignore generated files

**Files:**
- Create: `infra/cloudflare/rht.example.json`
- Create: `infra/cloudflare/rht_update.example.json`
- Create: `workers/cors-preflight-logger/wrangler.example.toml`
- Create: `scripts/render-infra.sh`
- Modify: `.gitignore`
- Remove from git index: `infra/cloudflare/rht.json`, `infra/cloudflare/rht_update.json`, `workers/cors-preflight-logger/wrangler.toml`

**Step 1: Write minimal implementation**

- Add `.example` templates with `${DOMAIN}` / `${DEV_DOMAIN}` placeholders in expressions and routes.
- Add `scripts/render-infra.sh` that requires env vars and uses `envsubst` to render templates, e.g.:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

: "${DOMAIN:?set DOMAIN}"
: "${DEV_DOMAIN:?set DEV_DOMAIN}"
: "${ZONE_NAME:?set ZONE_NAME}"

export DOMAIN DEV_DOMAIN ZONE_NAME

envsubst '$DOMAIN $DEV_DOMAIN $ZONE_NAME' < infra/cloudflare/rht.example.json > infra/cloudflare/rht.json
envsubst '$DOMAIN $DEV_DOMAIN $ZONE_NAME' < infra/cloudflare/rht_update.example.json > infra/cloudflare/rht_update.json
envsubst '$DOMAIN $DEV_DOMAIN $ZONE_NAME' < workers/cors-preflight-logger/wrangler.example.toml > workers/cors-preflight-logger/wrangler.toml
```

- Add generated outputs to `.gitignore` and remove them from the index:
  - `git rm --cached infra/cloudflare/rht.json infra/cloudflare/rht_update.json workers/cors-preflight-logger/wrangler.toml`

**Step 2: Render and verify outputs**

Run:
- `DOMAIN=codex-api.example.com DEV_DOMAIN=codex-dev.example.com ZONE_NAME=example.com bash scripts/render-infra.sh`
Expected: generated files exist at the target paths and match the templates with substituted values.

**Step 3: Commit**

```bash
git add .gitignore infra/cloudflare/*.example.json workers/cors-preflight-logger/wrangler.example.toml scripts/render-infra.sh
git rm --cached infra/cloudflare/rht.json infra/cloudflare/rht_update.json workers/cors-preflight-logger/wrangler.toml
git commit -m "chore(infra): template cloudflare and wrangler config"
```

### Task 2: Parameterize Compose + scripts with `.env` variables

**Files:**
- Modify: `docker-compose.yml`
- Modify: `infra/compose/compose.dev.stack.yml`
- Modify: `package.json`
- Modify: `scripts/dev-smoke.sh`
- Modify: `scripts/prod-smoke.sh`
- Modify: `scripts/port-dev-to-prod.sh`
- Modify: `scripts/cloudflare-cors-playbook.sh`
- Modify: `.env.example`
- Modify: `.env.dev.example`

**Step 1: Write minimal implementation**

- Replace hardcoded hostnames in compose labels with `${DOMAIN}` / `${DEV_DOMAIN}`.
- Replace hardcoded CORS allowlists with `${PROXY_CORS_ALLOWED_ORIGINS}` / `${DEV_PROXY_CORS_ALLOWED_ORIGINS}` set in `.env` / `.env.dev`.
- Update `.env.example` with a placeholder:
  - `DOMAIN=codex-api.example.com`
  - `PROXY_CORS_ALLOWED_ORIGINS=https://codex-api.example.com,https://obsidian.md,app://obsidian.md,capacitor://localhost,http://localhost,https://localhost`
- Update `.env.dev.example` with:
  - `DEV_DOMAIN=codex-dev.example.com`
  - `PROXY_CORS_ALLOWED_ORIGINS=https://codex-dev.example.com,https://obsidian.md,app://obsidian.md,capacitor://localhost,http://localhost,https://localhost`
- Update `package.json` scripts to remove real-domain defaults, e.g.:
  - `DEV_DOMAIN=${DEV_DOMAIN:?set DEV_DOMAIN} ...`
  - `DOMAIN=${DOMAIN:?set DOMAIN} ...`
- Update smoke/playbook comments to reference env variables instead of real domains.

**Step 2: Verify**

- Confirm hardcoded domains are removed outside templates, example envs, and docs.

**Step 3: Commit**

```bash
git add docker-compose.yml infra/compose/compose.dev.stack.yml package.json scripts/*.sh .env.example .env.dev.example
git commit -m "chore(config): parameterize domains"
```

### Task 3: Parameterize the CORS worker allowlist

**Files:**
- Modify: `workers/cors-preflight-logger/src/index.js`
- Modify: `workers/cors-preflight-logger/README.md`
- Modify: `workers/cors-preflight-logger/wrangler.example.toml`

**Step 1: Write minimal implementation**

- Update worker code to read `ALLOWED_ORIGINS` from env and merge with local defaults:

```js
const STATIC_ALLOWED = ["app://obsidian.md", "capacitor://localhost", "http://localhost", "https://localhost"];

const parseEnvList = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const buildAllowed = (env) => [...parseEnvList(env.ALLOWED_ORIGINS), ...STATIC_ALLOWED];
```

- Update `wrangler.example.toml` to set `ALLOWED_ORIGINS` based on `${DOMAIN}` and `${DEV_DOMAIN}`.
- Document required vars in `workers/cors-preflight-logger/README.md`.

**Step 2: Commit**

```bash
git add workers/cors-preflight-logger/src/index.js workers/cors-preflight-logger/README.md workers/cors-preflight-logger/wrangler.example.toml
git commit -m "chore(worker): make allowed origins configurable"
```

### Task 4: Document the render step and required envs

**Files:**
- Modify: `README.md`
- Modify: `docs/README-root.md`
- Modify: `workers/cors-preflight-logger/README.md`

**Step 1: Write the failing test**

Ensure docs mention the render step and required envs:

```bash
rg -n "render-infra.sh|wrangler.example|rht.example|DOMAIN|DEV_DOMAIN" README.md docs/README-root.md workers/cors-preflight-logger/README.md >/dev/null
```

**Step 2: Run test to verify it fails**

Run the command above.
Expected: FAIL before docs updates.

**Step 3: Write minimal implementation**

- Add a short section describing `scripts/render-infra.sh` and required envs (`DOMAIN`, `DEV_DOMAIN`, `ZONE_NAME`).
- Note that generated files are ignored and must be rendered before deploy.

**Step 4: Verify docs**

- Confirm examples reference template usage and env-driven rendering.

**Step 5: Commit**

```bash
git add README.md docs/README-root.md workers/cors-preflight-logger/README.md
git commit -m "docs: document infra render step"
```

## Tests to run
- `DOMAIN=codex-api.example.com DEV_DOMAIN=codex-dev.example.com ZONE_NAME=example.com bash scripts/render-infra.sh`
- `docker compose config | rg -n "codex-api"` (with `DOMAIN` exported)
- Optional runtime checks: `npm run smoke:dev` and `npm run smoke:prod` with envs set.
