# Codex Responses Hostname Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a second production hostname backed by a separate CODEX_HOME/AGENTS for standard OpenAI clients.

**Architecture:** Introduce a second app service in `docker-compose.yml` using the same image with a distinct `CODEX_HOME` mount and default output mode. Traefik routes the new hostname to the new service while preserving the existing Obsidian host.

**Tech Stack:** Docker Compose, Traefik labels, Node/Express proxy config.

### Task 1: Ignore new CODEX_HOME directory

**Files:**
- Modify: `.gitignore`
- Modify: `.dockerignore`

**Step 1: Write the failing test**

```bash
rg -n "codex-responses-api" .gitignore .dockerignore
```

**Step 2: Run test to verify it fails**

Run: `rg -n "codex-responses-api" .gitignore .dockerignore`
Expected: no matches (signals missing ignore entries).

**Step 3: Write minimal implementation**

```gitignore
# .gitignore
.codex-responses-api/
```

```dockerignore
# .dockerignore
.codex-responses-api/
```

**Step 4: Run test to verify it passes**

Run: `rg -n "codex-responses-api" .gitignore .dockerignore`
Expected: matches in both files.

**Step 5: Commit**

```bash
git add .gitignore .dockerignore
git commit -m "chore: ignore responses codex home"
```

### Task 2: Add standard-host app service + routers

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Write the failing test**

```bash
docker compose config | rg -n "responses.example.com"
```

**Step 2: Run test to verify it fails**

Run: `docker compose config | rg -n "responses.example.com"`
Expected: no matches (hostname not routed yet).

**Step 3: Write minimal implementation**

```yaml
# docker-compose.yml (new service and labels)
services:
  app-responses:
    image: ${IMAGE:-ghcr.io/drjlabs/codex-app-server-proxy:latest}
    environment:
      - PORT=${RESPONSES_PORT:-11435}
      - PROXY_HOST=${PROXY_HOST:-0.0.0.0}
      - PROXY_API_KEY=${PROXY_API_KEY?set-in-env}
      - CODEX_MODEL=${CODEX_MODEL:-gpt-5.2}
      - PROXY_SANDBOX_MODE=${PROXY_SANDBOX_MODE:-read-only}
      - PROXY_CODEX_WORKDIR=${PROXY_CODEX_WORKDIR:-/tmp/codex-work}
      - PROXY_USE_APP_SERVER=${PROXY_USE_APP_SERVER:-true}
      - CODEX_HOME=/app/.codex-responses-api
      - PROXY_OUTPUT_MODE=openai-json
      - PROXY_COPILOT_AUTO_DETECT=false
      - PROXY_ENABLE_CORS=true
      - PROXY_CORS_ALLOWED_ORIGINS=${RESPONSES_CORS_ALLOWED_ORIGINS:-https://responses.example.com,http://localhost,https://localhost}
    volumes:
      - ./.codex-responses-api:/app/.codex-responses-api
    networks:
      - traefik
    # Do not bind to 127.0.0.1:11435 to avoid collision; optionally 127.0.0.1:11436:11435
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.services.codex-responses.loadbalancer.server.port=${RESPONSES_PORT:-11435}
      - traefik.http.routers.codex-responses.rule=Host(`${RESPONSES_DOMAIN:-responses.example.com}`) && PathPrefix(`/v1`)
      - traefik.http.routers.codex-responses.entrypoints=websecure
      - traefik.http.routers.codex-responses.tls=true
      - traefik.http.routers.codex-responses.middlewares=codex-responses-cors,codex-headers,codex-ratelimit,codex-forwardauth
      - traefik.http.routers.codex-responses-preflight.rule=Host(`${RESPONSES_DOMAIN:-responses.example.com}`) && PathPrefix(`/v1`) && Method(`OPTIONS`)
      - traefik.http.routers.codex-responses-preflight.entrypoints=websecure
      - traefik.http.routers.codex-responses-preflight.tls=true
      - traefik.http.routers.codex-responses-preflight.priority=10000
      - traefik.http.routers.codex-responses-preflight.middlewares=codex-responses-cors,codex-headers,codex-ratelimit
      - traefik.http.routers.codex-responses-preflight.service=noop@internal
      - traefik.http.routers.codex-responses-models.rule=Host(`${RESPONSES_DOMAIN:-responses.example.com}`) && (Path(`/v1/models`) || Path(`/v1/models/`))
      - traefik.http.routers.codex-responses-models.entrypoints=websecure
      - traefik.http.routers.codex-responses-models.tls=true
      - traefik.http.routers.codex-responses-models.priority=9000
      - traefik.http.routers.codex-responses-models.middlewares=codex-responses-cors,codex-headers,codex-ratelimit
      - traefik.http.routers.codex-responses-models.service=codex-responses
      - traefik.http.routers.codex-responses-health.rule=Host(`${RESPONSES_DOMAIN:-responses.example.com}`) && Path(`/healthz`)
      - traefik.http.routers.codex-responses-health.entrypoints=websecure
      - traefik.http.routers.codex-responses-health.tls=true
      - traefik.http.routers.codex-responses-health.service=codex-responses
      - traefik.http.routers.codex-responses-health.middlewares=codex-headers
```

**Step 4: Run test to verify it passes**

Run: `docker compose config | rg -n "responses.example.com"`
Expected: router rules appear in the rendered config.

**Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add responses hostname service"
```

### Task 3: Update docs for dual-host setup

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

**Step 1: Write the failing test**

```bash
rg -n "RESPONSES_DOMAIN" README.md .env.example
```

**Step 2: Run test to verify it fails**

Run: `rg -n "RESPONSES_DOMAIN" README.md .env.example`
Expected: no matches (docs not updated yet).

**Step 3: Write minimal implementation**

```markdown
# README.md additions
- Standard host: `RESPONSES_DOMAIN` (OpenAI-default output mode)
- CODEX_HOME: `./.codex-responses-api` (separate from Obsidian)
```

```dotenv
# .env.example additions
# Responses host for standard OpenAI clients
RESPONSES_DOMAIN=responses.example.com
RESPONSES_CORS_ALLOWED_ORIGINS=https://responses.example.com,http://localhost,https://localhost
```

**Step 4: Run test to verify it passes**

Run: `rg -n "RESPONSES_DOMAIN" README.md .env.example`
Expected: matches in both files.

**Step 5: Commit**

```bash
git add README.md .env.example
git commit -m "docs: document responses hostname"
```

### Task 4: Verification notes (post-deploy)

**Files:**
- None (runbook step only)

**Step 1: Write the failing test**

```bash
# Run on production host after deploy
DOMAIN=responses.example.com npm run smoke:prod
```

**Step 2: Run test to verify it fails**

Expected: only run after deploy; if before deploy it should fail due to missing routes.

**Step 3: Write minimal implementation**

Deploy changes on the host:
- `docker compose up -d --build --force-recreate`

**Step 4: Run test to verify it passes**

Run: `DOMAIN=responses.example.com npm run smoke:prod`
Expected: passes all smoke checks.

**Step 5: Commit**

Not applicable (no code changes).
