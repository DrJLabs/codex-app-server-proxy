# Responses-First README + Default Model Update (Design)

## Goals
- Make `/v1/responses` the primary endpoint in public-facing docs, with `/v1/chat/completions` retained for compatibility.
- Emphasize ChatGPT login as the intended auth flow and surface login URL behavior; keep `auth.json` copy as fallback.
- Set the default effective model to `gpt-5.2` across runtime defaults, configs, and tests.
- Update public-facing naming in the README without renaming internal identifiers.

## Decisions
- README title/intro updated to “Codex App-Server Proxy”; repo/package/image names remain unchanged.
- Auth guidance: use ChatGPT login; if auth is missing/expired, the proxy returns a login URL that writes `auth.json` under `CODEX_HOME`. Copying `~/.codex/auth.json` remains a fallback.
- Do not copy `~/.codex/config.toml`; use the repo-managed config (`.codev/config.toml`) as the baseline for `.codex-api`.
- Default model is `gpt-5.2` everywhere the proxy or config supplies a fallback.

## Scope
- Runtime defaults: `src/config/index.js`, `src/routes/*`, `src/utils.js`, `src/services/worker/supervisor.js`, `src/config/models.js`.
- Deployment/config defaults: `Dockerfile`, `.env.example`, `infra/compose/*.yml`, `.codev/config.toml`.
- Docs: `README.md`, `docs/configuration.md`, `docs/README-root.md`.
- Tests updated to expect the `gpt-5.2` default.

## Non-goals
- Renaming the repo, npm package, Docker image tags, or OTEL service names.
- Removing legacy endpoints beyond keeping `/v1/chat/completions` for compatibility (`/v1/completions` is already removed as part of the proto deprecation).
