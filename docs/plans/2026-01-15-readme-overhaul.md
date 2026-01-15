# README Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the root README with a quick-start entrypoint and ensure all linked docs are current, including a clear split between standard Responses usage and Obsidian Copilot chat-completions usage.

**Architecture:** Keep `README.md` lean (what it is, quickstart, minimal config, doc map), and move deep operational detail into canonical docs under `docs/`. Update docs to reflect current repo defaults and remove outdated branch references.

**Tech Stack:** Markdown, Node/npm scripts, Docker Compose.

### Task 1: Audit README scope and doc targets

**Files:**
- Modify: `README.md`
- Modify: `docs/README.md`

**Step 1: Capture current branch/reference drift (acceptance check)**

Run: `rg -n "main-p" README.md docs`

Expected: Matches in README/doc snapshot indicating outdated branch mention.

**Step 2: Identify canonical doc targets**

Run: `rg -n "Documentation|Docs" README.md`

Expected: Links to `docs/README.md`, `docs/getting-started.md`, `docs/configuration.md`, `docs/api/overview.md`, `docs/deployment/production.md`, `docs/ops/runbooks.md`.

**Step 3: Update doc index to include Responses vs Copilot split**

Edit `docs/README.md` to add explicit links to:
- `docs/api/responses.md`
- `docs/api/chat-completions.md`

**Step 4: Verify doc index links are present**

Run: `rg -n "responses.md|chat-completions.md" docs/README.md`

Expected: Both links present.

**Step 5: Commit**

```bash
git add docs/README.md
git commit -m "docs: update documentation index for client paths"
```

### Task 2: Clarify Responses vs Obsidian Copilot in API docs

**Files:**
- Modify: `docs/api/overview.md`
- Modify: `docs/api/responses.md`
- Modify: `docs/api/chat-completions.md`

**Step 1: Define acceptance checks**

Run: `rg -n "Responses|Obsidian Copilot" docs/api`

Expected: No or minimal matches before edits.

**Step 2: Add client-path guidance to `docs/api/overview.md`**

Add a short section that explains:
- `/v1/responses` for standard Responses clients
- `/v1/chat/completions` for Obsidian Copilot
- Output mode considerations and links to the per-endpoint docs

**Step 3: Update endpoint docs with client-specific notes**

Edit:
- `docs/api/responses.md` to note standard Responses usage and output mode defaults.
- `docs/api/chat-completions.md` to note Obsidian Copilot expectations and tool-block streaming options.

**Step 4: Verify acceptance checks**

Run: `rg -n "Responses|Obsidian Copilot" docs/api`

Expected: Matches in overview + endpoint docs.

**Step 5: Commit**

```bash
git add docs/api/overview.md docs/api/responses.md docs/api/chat-completions.md
git commit -m "docs: clarify responses vs copilot usage"
```

### Task 3: Rewrite root README to quick-start + doc map

**Files:**
- Modify: `README.md`
- Modify: `docs/README-root.md`

**Step 1: Define acceptance checks**

Run: `rg -n "main-p" README.md docs/README-root.md`

Expected: Matches before edits.

**Step 2: Rewrite `README.md`**

Replace the long-form README with:
- Short overview and feature bullets
- Quick start (local Node + Docker Compose)
- Client path split (Responses vs Obsidian Copilot)
- Minimal config table (core env vars)
- Doc map linking to canonical docs

**Step 3: Refresh the README snapshot**

Update `docs/README-root.md` to match the new root README.

**Step 4: Verify acceptance checks**

Run: `rg -n "main-p" README.md docs/README-root.md`

Expected: No matches.

**Step 5: Commit**

```bash
git add README.md docs/README-root.md
git commit -m "docs: overhaul readme quickstart and doc map"
```

### Task 4: Validate linked docs for accuracy

**Files:**
- Modify: `docs/getting-started.md`
- Modify: `docs/configuration.md`
- Modify: `docs/deployment/production.md`
- Modify: `docs/deployment/dev-stack.md`
- Modify: `docs/local-development.md`
- Modify: `docs/ops/runbooks.md`
- Modify: `docs/troubleshooting.md`

**Step 1: Check for outdated references**

Run: `rg -n "main-p|master|trunk" docs`

Expected: No matches after README updates.

**Step 2: Verify key commands and defaults**

Spot-check commands and defaults against:
- `package.json` scripts
- `docker-compose.yml` and `infra/compose/compose.dev.stack.yml`
- `src/config/index.js`

Update docs as needed to match current defaults.

**Step 3: Run doc lint (if runbooks changed)**

Run: `npm run lint:runbooks`

Expected: Pass.

**Step 4: Commit**

```bash
git add docs/getting-started.md docs/configuration.md docs/deployment/production.md \
  docs/deployment/dev-stack.md docs/local-development.md docs/ops/runbooks.md docs/troubleshooting.md
git commit -m "docs: align linked docs with current repo"
```
