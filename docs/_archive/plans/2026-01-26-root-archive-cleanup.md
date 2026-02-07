# Root Archive Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move clearly stale root snapshots into an archive so the root stays canonical and future agents don’t confuse historical artifacts for current docs/config.

**Architecture:** Keep canonical files in the repo root. Place dated snapshots and other clearly stale artifacts in `docs/_archive/root-snapshots/` using `git mv` to preserve history. Remove ephemeral temp files with no references. Update the docs index to mention the archive location.

**Tech Stack:** Git, Markdown docs, Node repo tooling (`npm` for doc checks).

### Task 1: Inventory stale root artifacts

**Files:**
- Modify: (none)

**Step 1: List dated/snapshot files in root**

Run: `rg --files -g '*2025*' -g '*2026*' .`
Expected: list of dated root files plus dated docs/plans entries.

**Step 2: Check for references to root snapshots**

Run: `rg -n "README-2025-12-22|AGENTS-2025-12-22|server-2025-12-14|docker-compose-2025-12-20|Dockerfile-2025-12-19|\.env-2025-12-19\.example|\.env-2025-12-21\.dev|\.env\.dev-2025-12-14\.example|\.dockerignore-2025-09-08|\.gitignore-2025-12-22|\.secretlintignore-2025-10-24" .`
Expected: no references; if any found, capture paths before moving.

### Task 2: Create archive location for stale root snapshots

**Files:**
- Create: `docs/_archive/root-snapshots/.gitkeep`

**Step 1: Create archive directory**

Run: `mkdir -p docs/_archive/root-snapshots`
Expected: directory exists.

**Step 2: Add gitkeep to preserve empty dir in git**

Create file `docs/_archive/root-snapshots/.gitkeep` with a single line: `archived root snapshots`.

### Task 3: Move root snapshots into archive

**Files:**
- Move: `README-2025-12-22.md`
- Move: `AGENTS-2025-12-22.md`
- Move: `.gitignore-2025-12-22`
- Move: `.dockerignore-2025-09-08`
- Move: `.secretlintignore-2025-10-24`
- Move: `Dockerfile-2025-12-19`
- Move: `docker-compose-2025-12-20.yml`
- Move: `server-2025-12-14.js`
- Move: `.env-2025-12-19.example`
- Move: `.env-2025-12-21.dev`
- Move: `.env.dev-2025-12-14.example`

**Step 1: Move files with history preserved**

Run:
```
git mv README-2025-12-22.md AGENTS-2025-12-22.md .gitignore-2025-12-22 \
  .dockerignore-2025-09-08 .secretlintignore-2025-10-24 Dockerfile-2025-12-19 \
  docker-compose-2025-12-20.yml server-2025-12-14.js .env-2025-12-19.example \
  .env-2025-12-21.dev .env.dev-2025-12-14.example docs/_archive/root-snapshots/
```
Expected: files moved to `docs/_archive/root-snapshots/`.

### Task 4: Remove ephemeral temp artifacts

**Files:**
- Delete: `_shellfish_uploading_*`
- Delete: `.tmp-proto-tracing.ndjson`
- Delete: `.tmp-usage.test.ndjson`

**Step 1: Remove known temp files**

Run: `rm -f _shellfish_uploading_* .tmp-proto-tracing.ndjson .tmp-usage.test.ndjson`
Expected: temp files removed if present.

**Step 2: Confirm no references to removed temp files**

Run: `rg -n "\.tmp-proto-tracing\.ndjson|\.tmp-usage\.test\.ndjson|_shellfish_uploading" .`
Expected: no matches.

### Task 5: Update documentation index to point at archive

**Files:**
- Modify: `docs/README.md`

**Step 1: Add an “Archive” section**

Add a short section noting `docs/_archive/root-snapshots/` for historical root snapshots.

**Step 2: Run doc checks**

Run:
- `npm run format:check`
- `npm run lint:runbooks`
Expected: no errors.

### Task 6: Commit

**Step 1: Stage changes**

Run: `git add docs/README.md docs/_archive/root-snapshots/.gitkeep docs/_archive/root-snapshots/*`

**Step 2: Commit**

Run: `git commit -m "chore: archive stale root snapshots"`
Expected: commit created with moved files and doc update.
