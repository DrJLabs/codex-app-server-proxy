# Public Project Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the repo read/operate as a polished public project with consistent `codex-app-server-proxy` naming, GHCR image usage, and internal docs kept local-only.

**Architecture:** Treat this as a repo-wide naming + docs hygiene pass. Use `rg`-driven checks to locate legacy names and internal-only links, update only public-facing files, and keep internal content under `docs/internal/` with push guards and snapshot excludes.

**Tech Stack:** Node.js (npm), shell scripts, Docker Compose, GitHub Actions, Markdown docs.

### Task 1: Public metadata naming audit (root docs + package)

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Test: `README.md`, `package.json`

**Step 1: Write the failing test**

Run:
```
rg -n "codex-completions-api|completions-api|completions api" README.md package.json
```
Expected: at least one match (RED) if legacy naming exists.

**Step 2: Run test to verify it fails**

Expected: output lines showing legacy naming or positioning.

**Step 3: Write minimal implementation**

Apply replacements where found:
```
codex-completions-api -> codex-app-server-proxy
completions api -> responses-first proxy
```
Ensure `package.json` stays aligned with:
```json
{
  "name": "codex-app-server-proxy",
  "description": "OpenAI-compatible Responses-first proxy for Codex CLI with streaming SSE."
}
```

**Step 4: Run test to verify it passes**

Re-run the `rg` command. Expected: no matches.

**Step 5: Commit**

```
git add README.md package.json
git commit -m "chore: align root metadata naming"
```

### Task 2: Public docs index and overview alignment

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/README-root.md`
- Test: `docs/README.md`, `docs/README-root.md`

**Step 1: Write the failing test**

Run:
```
rg -n "codex-completions-api|completions-api|completions api" docs/README.md docs/README-root.md
```
Expected: matches if legacy naming exists (RED).

**Step 2: Run test to verify it fails**

Expected: matches printed for legacy naming.

**Step 3: Write minimal implementation**

Replace any legacy naming and ensure public index does NOT link to internal-only paths:
```
docs/internal/
docs/private/
```
Add a short note (if needed) that internal docs live under `docs/internal/` and are not part of the public distribution.

**Step 4: Run test to verify it passes**

Re-run the `rg` command. Expected: no matches.

**Step 5: Commit**

```
git add docs/README.md docs/README-root.md
git commit -m "docs: align public docs index naming"
```

### Task 3: Public docs content pass (responses-first positioning)

**Files:**
- Modify: `docs/getting-started.md`
- Modify: `docs/configuration.md`
- Modify: `docs/deployment/production.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docs/observability.md`
- Modify: `docs/architecture.md`
- Modify: `docs/codex-proxy-tool-calls.md`
- Test: same as above

**Step 1: Write the failing test**

Run:
```
rg -n "codex-completions-api|completions-api|completions api" docs/getting-started.md docs/configuration.md docs/deployment/production.md docs/troubleshooting.md docs/observability.md docs/architecture.md docs/codex-proxy-tool-calls.md
```
Expected: matches if legacy naming exists (RED).

**Step 2: Run test to verify it fails**

Expected: output lines with legacy naming or completions-first framing.

**Step 3: Write minimal implementation**

Replace legacy naming and update positioning to responses-first. Ensure these specifics are correct:
```
Default model: gpt-5.2
Default port: 11435
Auth flow: login-link flow + auth fallback behavior
```
Keep migration docs consistent with the Responses endpoint framing.

**Step 4: Run test to verify it passes**

Re-run the `rg` command. Expected: no matches.

**Step 5: Commit**

```
git add docs/getting-started.md docs/configuration.md docs/deployment/production.md docs/troubleshooting.md docs/observability.md docs/architecture.md docs/codex-proxy-tool-calls.md
git commit -m "docs: refresh public docs naming and framing"
```

### Task 4: GHCR and Compose alignment

**Files:**
- Modify: `docker-compose.yml`
- Modify: `infra/compose/compose.dev.stack.yml`
- Modify: `infra/compose/docker-compose.local.example.yml`
- Modify: `.env.example`
- Test: same as above

**Step 1: Write the failing test**

Run:
```
rg -n "codex-completions-api|completions-api|completions api" docker-compose.yml infra/compose/compose.dev.stack.yml infra/compose/docker-compose.local.example.yml .env.example
```
Expected: matches if legacy naming exists (RED).

**Step 2: Run test to verify it fails**

Expected: output lines with legacy naming or non-GHCR references.

**Step 3: Write minimal implementation**

Ensure GHCR image instructions use:
```
ghcr.io/<owner>/codex-app-server-proxy:latest
```
Ensure `.env.example` includes:
```
PROXY_OTEL_SERVICE_NAME=codex-app-server-proxy
```
Keep dev/local compose image names in sync with public naming:
```
codex-app-server-proxy:dev
codex-app-server-proxy:local
```

**Step 4: Run test to verify it passes**

Re-run the `rg` command. Expected: no matches.

**Step 5: Commit**

```
git add docker-compose.yml infra/compose/compose.dev.stack.yml infra/compose/docker-compose.local.example.yml .env.example
git commit -m "chore: align compose and env naming"
```

### Task 5: Runtime identifiers and test output naming

**Files:**
- Modify: `src/services/tracing.js`
- Modify: `src/services/transport/index.js`
- Modify: `src/lib/json-rpc/schema.ts`
- Modify: `tests/**` (only files with legacy naming)
- Test: `src/**`, `tests/**`

**Step 1: Write the failing test**

Run:
```
rg -n "codex-completions-api|completions-api|completions api" src tests
```
Expected: matches if legacy naming exists (RED).

**Step 2: Run test to verify it fails**

Expected: output lines showing legacy naming in runtime identifiers or tests.

**Step 3: Write minimal implementation**

Replace any legacy strings with:
```
codex-app-server-proxy
```
Ensure telemetry identifiers and schema labels remain stable and public-safe.

**Step 4: Run test to verify it passes**

Re-run the `rg` command. Expected: no matches.

**Step 5: Commit**

```
git add src/services/tracing.js src/services/transport/index.js src/lib/json-rpc/schema.ts tests
git commit -m "chore: align runtime identifiers and tests"
```

### Task 6: Internal docs guardrails and release snapshot exclusions

**Files:**
- Verify/Modify: `.husky/pre-push`
- Verify/Modify: `scripts/stack-snapshot.sh`
- Modify: `docs/internal/README.md`
- Modify: `docs/README.md`
- Test: `.husky/pre-push`, `scripts/stack-snapshot.sh`

**Step 1: Write the failing test**

Run:
```
rg -n "docs/internal" .husky/pre-push scripts/stack-snapshot.sh docs/README.md docs/internal/README.md
```
Expected: matches if guardrails already exist (RED if missing).

**Step 2: Run test to verify it fails**

Expected: if guardrails missing, no matches (treat as failure); if present, confirm content matches policy.

**Step 3: Write minimal implementation**

Ensure pre-push blocks `origin` pushes with `docs/internal` present, and snapshots exclude `docs/internal`:
```
git ls-tree -r --name-only HEAD docs/internal | grep -q .
--exclude='docs/internal'
```
Ensure docs index only notes internal docs exist, without linking to internal paths.

**Step 4: Run test to verify it passes**

Re-run the `rg` command. Expected: matches for guardrails, and no public links to internal content.

**Step 5: Commit**

```
git add .husky/pre-push scripts/stack-snapshot.sh docs/internal/README.md docs/README.md
git commit -m "docs: reinforce internal docs guardrails"
```

### Task 7: GitHub metadata and workflow hygiene

**Files:**
- Modify: `.github/workflows/*`
- Modify: `.github/ISSUE_TEMPLATE/*`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Test: `.github/workflows/*`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md`

**Step 1: Write the failing test**

Run:
```
rg -n "codex-completions-api|completions-api|completions api|docs/internal" .github
```
Expected: matches if legacy naming or internal links exist (RED).

**Step 2: Run test to verify it fails**

Expected: output lines showing legacy naming or internal-only references.

**Step 3: Write minimal implementation**

Update any GHCR references to:
```
ghcr.io/<owner>/codex-app-server-proxy:latest
```
Remove internal-only links from public templates.

**Step 4: Run test to verify it passes**

Re-run the `rg` command. Expected: no matches.

**Step 5: Commit**

```
git add .github
git commit -m "chore: clean up GitHub metadata"
```

### Task 8: Final verification and cleanup

**Files:**
- Test: repo-wide

**Step 1: Run naming audit**

Run:
```
rg -n "codex-completions-api|completions-api|completions api" . --glob '!node_modules/**' --glob '!docs/internal/**'
```
Expected: no matches.

**Step 2: Run formatting + lint**

Run:
```
npm run format:check
npm run lint:runbooks
```
Expected: both pass.

**Step 3: Commit (if any fixes required)**

```
git add .
git commit -m "chore: finalize public project polish"
```

**Step 4: Summarize verification evidence**

Record command outputs and artifacts for the PR summary (if opened).

---

Plan complete and saved to `docs/plans/2025-12-29-public-project-polish-implementation.md`. Two execution options:

1. Subagent-Driven (this session) - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. Parallel Session (separate) - Open new session with executing-plans, batch execution with checkpoints

Which approach?
