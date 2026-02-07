# Plan: Public Project Polish (naming, GHCR, docs hygiene)

## Goal
- Make the repo read/operate as a polished public project by:
  - consistent naming (`codex-app-server-proxy`),
  - publishing/pulling container images from GHCR,
  - reorganizing docs so public readers see only public materials.

## Assumptions / constraints
- Canonical public name: `codex-app-server-proxy`.
- Standard GHCR conventions: `ghcr.io/<owner>/<repo>:<tag>` with `latest` on main.
- Internal docs must be git‑tracked locally, but should not be pushed to the public remote.
- Keep runtime behavior intact; this is presentation/packaging + docs hygiene.

## Research (current state)
- Name still appears across runtime/config/docs:
  - `package.json` name/description
  - Compose files (`docker-compose.yml`, `infra/compose/*.yml`)
  - Scripts (`scripts/*`, `scripts/stack-snapshot.sh`, `release.yml`)
  - Telemetry/client identity (`src/services/tracing.js`, `src/services/transport/index.js`, `src/lib/json-rpc/schema.ts`)
  - `.env.example` (`PROXY_OTEL_SERVICE_NAME`)
- Release workflow creates tarball names using `codex-app-server-proxy`.
- Docs include deep internal materials (now under `docs/internal/`, sourced from `docs/bmad`, `docs/surveys`, `docs/codex-longhorizon`, `docs/stories`, `docs/review`, `docs/PRD.md`, `docs/epics.md`, `docs/test-design-epic-2.md`).
- `docs/README.md` is the public index and currently links to internal/ops artifacts.

## Analysis
### Options for internal docs handling
1) Private canonical repo + public filtered mirror (most reliable; public never sees internal paths).
2) Private repo/submodule for internal docs (reliable, but public repo still exposes a pointer).
3) Keep internal docs in repo with local pre‑push guard only (fastest, but bypassable).
4) Local‑only branch for internal docs (deferred; skip for now).

### Decision
- Use option 3 now to satisfy “tracked but not pushed” within a single repo:
  - Add `docs/internal/` and move internal materials there.
  - Add a pre‑push guard that aborts pushes to `origin` if `docs/internal/` is present.
  - Exclude `docs/internal/` from release snapshots.
- Defer stronger isolation until public distribution is required; then pick option 1 or 2.

### Risks / edge cases
- Pre‑push hooks can be bypassed (e.g., `--no-verify`, CI, alternate remotes).
- Renaming tarball/image names could break external automation that expects old names.

### Open questions
- When public distribution becomes a requirement, should we use a filtered mirror (option 1) or a private submodule (option 2)?

## Implementation plan
### Checklist (public surface audit + docs hygiene)
- [x] **Inventory the public surface (repo root).**
  Paths: `README.md`, `CONTRIBUTING.md`, `LICENSE`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `package.json`, `docker-compose.yml`, `.env.example`, `.github/`, `docs/`, `infra/`, `scripts/`, `src/`, `tests/`, `external/`.
  How: `rg --files` to list; `rg -n "codex-completions-api|completions api|completions-api" .` to find stale name/positioning; confirm no internal-only references in public files.
  AC: All public-facing files reference `codex-app-server-proxy` and “responses-first” positioning; no public file links into `docs/internal/`.
- [x] **Docs IA + content audit (public docs only).**
  Paths: `docs/README.md`, `docs/README-root.md`, `docs/getting-started.md`, `docs/configuration.md`, `docs/deployment/production.md`, `docs/troubleshooting.md`, `docs/observability.md`, `docs/architecture.md`, `docs/codex-proxy-tool-calls.md`.
  How: `rg -n "completions" docs` to update legacy framing; `rg -n "gpt-5" docs` to ensure `gpt-5.2`; check Quickstart includes port `11435`, login-link flow, and auth fallback.
  AC: Public docs are internally consistent, responses-first, show correct default model, and include the login-link flow + auth fallback.
- [x] **Internal docs isolation (track locally, no public push).**
  Paths: `docs/internal/`, `.husky/pre-push`, `.gitignore`, `scripts/stack-snapshot.sh`, `docs/internal/README.md`.
  How: Confirm `docs/README.md` only notes internal docs exist; pre-push blocks `origin` when `docs/internal/` exists; snapshots skip `docs/internal/`.
  AC: Internal docs are accessible locally but guarded from accidental public push; internal artifacts are ignored.
- [x] **GitHub/project metadata hygiene.**
  Paths: `.github/workflows/`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`, `README.md`.
  How: Check for internal-only references or private links; verify GHCR publish workflow naming and tags.
  AC: All metadata is public-safe, GHCR instructions match `ghcr.io/<owner>/codex-app-server-proxy`, and release docs avoid internal links.
- [x] **Runtime config + compose examples.**
  Paths: `docker-compose.yml`, `infra/compose/compose.dev.stack.yml`, `infra/compose/docker-compose.local.example.yml`, `.env.example`, `docs/deployment/production.md`.
  How: Verify service name, port `11435`, and GHCR image tags are consistent; ensure example env vars align with docs.
  AC: Compose examples and docs align on ports, image names, and auth/login flow expectations.
- [x] **Scripts and tooling docs alignment.**
  Paths: `scripts/`, `docs/getting-started.md`, `docs/troubleshooting.md`, `docs/deployment/production.md`.
  How: Check for references to old names or paths; ensure script output names (snapshots/backups) match new naming.
  AC: Scripts and docs refer to the same naming, paths, and commands.
- [x] **Source/test references to old branding.**
  Paths: `src/`, `tests/`.
  How: `rg -n "codex-completions-api|completions-api" src tests` to catch leftover names in telemetry, schema, or tests.
  AC: No lingering old-brand strings in runtime or test output.

## Tests to run
- `npm run format:check`
- `npm run lint:runbooks`
