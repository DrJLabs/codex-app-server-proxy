# Local Production Quickstart Docs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide a complete local production quickstart (including Windows guidance) so Obsidian Copilot users can run the proxy on the same machine and connect successfully.

**Architecture:** Documentation-only change. Add a production-focused quickstart to `README.md`, then align `docs/getting-started.md` and `docs/troubleshooting.md` with minimal cross-links and concise troubleshooting guidance. Avoid renaming existing headings to preserve links.

**Tech Stack:** Markdown docs, Node.js 22/npm, optional Docker (Dockerfile + local compose example), Obsidian Copilot client.

## Goal
- Add a production quickstart to `README.md` that is copy/paste ready for local Obsidian Copilot use.
- Provide Windows self-host guidance (Docker Desktop/WSL2 recommended).
- Add a short troubleshooting note about the login callback port 1435.

## Assumptions / constraints
- User requested no isolated worktrees; work on a standard branch in this repo.
- Audience is local, same-machine hosting with Obsidian Copilot.
- Default production port is `11435`.
- Login callback uses local port `1435`; keep guidance minimal (ensure port open).
- Keep updates small and avoid rewriting existing “Run locally with Node” guidance.

## Research (current state)
- `README.md` has “Getting Started” with “Run locally with Node” (uses `.codev/`) and “Run with Docker Compose”; no production quickstart for Obsidian Copilot.
- `docs/getting-started.md` is dev-focused (port `18000`) with no production/local guidance.
- `docs/troubleshooting.md` does not mention missing/invalid `auth.json` or login callback port.
- `Dockerfile` and `infra/compose/docker-compose.local.example.yml` already support local container runs with `CODEX_HOME=/app/.codex-api`.

## Analysis
### Options
1) Add a production quickstart section to `README.md` and link to it from `docs/getting-started.md` + a small troubleshooting addition.
2) Create a new `docs/obsidian-local-setup.md` and link it from README + docs index.

### Decision
- Chosen: Option 1. Minimal churn, high visibility, matches user request to keep the quickstart in `README.md`.

### Risks / edge cases
- Users in Docker may fail the login callback; we will explicitly mention port 1435 and recommend host-side login + copying `auth.json`.

### Open questions
- None (answers captured below).

## Q&A (answer before implementation)
- Primary entry point: `README.md` with a production quickstart section.
- Windows self-host: recommend Docker Desktop (WSL2 backend) with the provided local compose example; WSL2 + Node as secondary.
- Obsidian Copilot setup steps: include explicit values.
- Default port: `11435` for production.
- Login callback: mention port `1435` (keep guidance minimal).

## Implementation plan

### Task 1: Add a production quickstart to README

**Files:**
- Modify: `README.md`

**Step 1: Insert the new section under “Getting Started” (after Prerequisites).**

Add the following section verbatim:

```markdown
### Quick Start (Production, local Obsidian Copilot)

Use this when you want to run the proxy on the same machine as Obsidian Copilot (default port `11435`).

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Log in to Codex CLI and seed the production Codex HOME:

   ```bash
   codex login
   mkdir -p .codex-api
   cp ~/.codex/auth.json .codex-api/auth.json
   cp ~/.codex/config.toml .codex-api/config.toml
   ```

3. Start the server (binds to `0.0.0.0:11435` by default; set `PROXY_HOST=127.0.0.1` for loopback-only):

   ```bash
   PROXY_API_KEY=codex-local-secret PROXY_ENV=prod PROXY_HOST=127.0.0.1 PROXY_PORT=11435 npm run start
   ```

4. Configure Obsidian Copilot:

   - Base URL: `http://127.0.0.1:11435`
   - API key: `codex-local-secret`
   - Model: `codex-5` (or `codex-5-low` / `codex-5-medium` / `codex-5-high`)
   - Streaming: enabled

5. Verify:

   ```bash
   curl -s http://127.0.0.1:11435/healthz | jq .
   curl -s http://127.0.0.1:11435/v1/models | jq .
   ```

**Windows (recommended):** Use Docker Desktop (WSL2 backend) with the local compose example:

```bash
cp infra/compose/docker-compose.local.example.yml docker-compose.local.yml
# ensure ./.codex-api has auth.json + config.toml
PROXY_API_KEY=codex-local-secret docker compose -f docker-compose.local.yml up --build
```

If the proxy returns a login URL, Codex uses a local callback on port `1435` — make sure your firewall allows it.
```

**Step 2: Keep existing “Run locally with Node” and “Run with Docker Compose” sections intact.**

**Step 3: No tests needed (docs-only), but verify code fences render and paths are accurate.**

### Task 2: Link to the production quickstart from docs/getting-started.md

**Files:**
- Modify: `docs/getting-started.md`

**Step 1: Add a short production/local callout near the top (after Prerequisites).**

Add this snippet:

```markdown
## Quickstart (production/local for Obsidian Copilot)

For the copy/paste production setup (port `11435`, `.codex-api`, Obsidian Copilot config), follow the
**Quick Start (Production, local Obsidian Copilot)** section in `../README.md`.
```

**Step 2: Leave the dev quickstart (`npm run dev`) as-is.**

### Task 3: Add a minimal login callback note to docs/troubleshooting.md

**Files:**
- Modify: `docs/troubleshooting.md`

**Step 1: Add a short section under “401 Unauthorized.”**

```markdown
## Login URL shown / auth.json invalid

- If `auth.json` is missing or invalid, the proxy returns a login URL in the error message.
- The Codex login flow uses a local callback on port `1435`; ensure it is open and not blocked.
```

### Task 4: Verification (docs-only)

**Step 1: Quick sanity check**

Run:

```bash
rg -n "Quick Start \\(Production, local Obsidian Copilot\\)" README.md
```

Expected: One match in `README.md`.

**Step 2: Optional doc formatting checks**

Run:

```bash
npm run format:check
```

Expected: PASS (or address any Markdown formatting issues).

**Step 3: Commit**

```bash
git add README.md docs/getting-started.md docs/troubleshooting.md
git commit -m "docs: add local production quickstart for copilot"
```

## Tests to run
- `npm run format:check` (optional for docs-only change).
