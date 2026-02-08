# Documentation Index

This folder is the canonical index for repository documentation. Update this file whenever docs are added, removed, or renamed.

## Start here

- [`../README.md`](../README.md) — overview + quickstart
- [`README-root.md`](README-root.md) — generated snapshot of the repository README for doc-local reference
- [`getting-started.md`](getting-started.md) — first-run walkthrough
- [`configuration.md`](configuration.md) — environment variables and defaults (authoritative)
- [`architecture.md`](architecture.md) — architecture entry point (canonical links)

## Docs policy

- Canonical docs: `docs/api/*`, `docs/configuration.md`, `docs/deployment/*`, `docs/ops/*`, `docs/observability.md`, `docs/troubleshooting.md`
- Reference captures: `docs/reference/*`, `docs/references/*` (source material, may be verbose)
- Archive: `docs/_archive/*` (historical context; not kept current)
- `docs/README-root.md` is generated from `README.md` via `npm run docs:sync-readme-root`

## Development

- [`local-development.md`](local-development.md) — Node vs shim vs Docker workflows
- [`api/overview.md`](api/overview.md) — endpoint overview + runnable curl examples
- [`api/responses.md`](api/responses.md) — `/v1/responses` usage notes
- [`api/chat-completions.md`](api/chat-completions.md) — `/v1/chat/completions` usage notes
- [`troubleshooting.md`](troubleshooting.md) — common errors and fixes

## Defaults (important)

- Internal Codex tools (`shell`, `apply_patch`, etc.) are disabled by default and only client-provided dynamic tool calls are allowed.
- Tool registries are thread-scoped in Codex; the proxy forwards request `tools[]` at `thread/start` and reuses the thread's canonical toolset/instructions when clients send `function_call_output` items.
- See `configuration.md` for `PROXY_DISABLE_INTERNAL_TOOLS`, `PROXY_DISABLE_INTERNAL_TOOLS_CONFIG`, `PROXY_DISABLE_INTERNAL_TOOLS_PROMPT`, and `PROXY_ENABLE_INTERNAL_TOOLS_SHIM`.

## Deployment and ops

- [`deployment/dev-stack.md`](deployment/dev-stack.md) — dev stack (`compose/dev-stack.yml`)
- [`deployment/production.md`](deployment/production.md) — production compose (`docker-compose.yml`)
- [`ops/runbooks.md`](ops/runbooks.md) — snapshot/rollback/backup/smoke workflows

## Observability

- [`observability.md`](observability.md) — logs, request IDs, metrics, tracing
- [`reference/config-matrix.md`](reference/config-matrix.md) — environment/mount matrix + ForwardAuth notes

## API contracts (canonical)

- [`openai-endpoint-golden-parity.md`](openai-endpoint-golden-parity.md) — golden transcript contract for `/v1/chat/completions` and `/v1/responses`
- [`responses-endpoint/overview.md`](responses-endpoint/overview.md) — `/v1/responses` implementation notes
- [`responses-endpoint/app-server-tools.md`](responses-endpoint/app-server-tools.md) — tool manifest limitations and MCP integration notes
- [`responses-endpoint/prompt-injection.md`](responses-endpoint/prompt-injection.md) — `/v1/responses` tool-call prompt injection matrix
- [`reference/obsidian-tool-manifest.md`](reference/obsidian-tool-manifest.md) — Obsidian Copilot tool manifest capture
- [`reference/obsidian-developer-prompt-5-tools.md`](reference/obsidian-developer-prompt-5-tools.md) — Obsidian Copilot developer prompt capture (short tools)
- [`reference/obsidian-developer-prompt-13-tools.md`](reference/obsidian-developer-prompt-13-tools.md) — Obsidian Copilot developer prompt capture (full tools)
- [`reference/app-server-protocol.schema.json`](reference/app-server-protocol.schema.json) — JSON-RPC schema bundle (Codex app-server)
- [`reference/app-server-schema-0.89-tools.md`](reference/app-server-schema-0.89-tools.md) — schema extract for tool support (Codex 0.89.0)

## Deep dives and backlogs

- [`logging-gaps/README.md`](logging-gaps/README.md) — observability gap tracker
- [`api-v2-migration/client-to-app-server.md`](api-v2-migration/client-to-app-server.md) — `/v1/responses` openai-json ingress -> JSON-RPC handoff trace
- [`api-v2-migration/app-server-to-client.md`](api-v2-migration/app-server-to-client.md) — app-server tool request/output -> client response reverse trace

## Plans

The repository keeps dated implementation plans in `docs/_archive/plans/`. These are useful for historical context but are not maintained as canonical docs.

## Internal docs (not published)

- Internal planning/surveys are maintained separately and are not part of the public distribution.

## Archive

- `docs/_archive/` (tracked) — historical snapshots and dated notes; not authoritative for current setup.

## Doc hygiene

- Run `npm run format:check` and `npm run lint:runbooks` before committing doc changes.
- Keep local-only notes out of the public repo or in private remotes.
