# Root Archive Cleanup Design

**Goal:** Keep the repo root canonical by moving clearly stale, dated snapshots into an archive so future agents do not confuse them with current docs/config.

**Scope:** Root-level dated snapshot files (README, AGENTS, Docker/compose backups, ignore files, and example env files). Excludes any non-example `.env*` files to avoid moving secrets into docs.

**Approach:**
- Create `docs/_archive/root-snapshots/` to hold historical root snapshots.
- Move dated snapshot files into the archive directory.
- Remove ephemeral temp artifacts in root.
- Update `docs/README.md` to point at the archive and note it is not authoritative.

**Out of scope:** Cleaning non-root directories, generated output directories, or private local state (e.g., `.codev/`, `.codex-api/`).

**Risks and mitigations:**
- **Secrets:** Skip non-example `.env*` files; do not move or commit secrets.
- **References:** Verify there are no in-repo references to moved snapshots before archiving.
