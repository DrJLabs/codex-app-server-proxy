# Documentation Index

This folder is the canonical index for repository documentation. Update this file whenever docs are added, removed, or renamed.

## Start here

- [`../README.md`](../README.md) — overview + quickstart
- [`README-root.md`](README-root.md) — snapshot of the repository README for doc-local reference
- [`getting-started.md`](getting-started.md) — first-run walkthrough
- [`configuration.md`](configuration.md) — environment variables and defaults (authoritative)
- [`architecture.md`](architecture.md) — architecture entry point (canonical links)

## Development

- [`local-development.md`](local-development.md) — Node vs shim vs Docker workflows
- [`app-server-payloads.md`](app-server-payloads.md) — exact JSON-RPC payloads sent to app-server
- [`obsidian-prompt-changes.md`](obsidian-prompt-changes.md) — proposed Obsidian prompt sanitization rules
- [`obsidian-xml-system-prompt.md`](obsidian-xml-system-prompt.md) — proposed Obsidian XML tool-call system prompt
- [`obsidian-tool-manifest.md`](obsidian-tool-manifest.md) — captured Obsidian tool manifest (raw client payload)
- [`api/overview.md`](api/overview.md) — endpoint overview + runnable curl examples
- [`api/responses.md`](api/responses.md) — `/v1/responses` usage notes
- [`api/chat-completions.md`](api/chat-completions.md) — `/v1/chat/completions` usage notes
- [`troubleshooting.md`](troubleshooting.md) — common errors and fixes

## Deployment and ops

- [`deployment/dev-stack.md`](deployment/dev-stack.md) — dev stack (`infra/compose/compose.dev.stack.yml`)
- [`deployment/production.md`](deployment/production.md) — production compose (`docker-compose.yml`)
- [`ops/runbooks.md`](ops/runbooks.md) — snapshot/rollback/backup/smoke workflows

## Observability

- [`observability.md`](observability.md) — logs, request IDs, metrics, tracing
- [`reference/config-matrix.md`](reference/config-matrix.md) — environment/mount matrix + ForwardAuth notes

## API contracts (canonical)

- [`openai-endpoint-golden-parity.md`](openai-endpoint-golden-parity.md) — golden transcript contract for `/v1/chat/completions` and `/v1/responses`
- [`responses-endpoint/overview.md`](responses-endpoint/overview.md) — `/v1/responses` implementation notes
- [`responses-endpoint/app-server-tools.md`](responses-endpoint/app-server-tools.md) — tool manifest limitations and MCP integration notes
- [`responses-endpoint/obsidian-tool-call-simulation.md`](responses-endpoint/obsidian-tool-call-simulation.md) — OpenAI-parity tool-call simulation plan
- [`responses-endpoint/prompt-injection.md`](responses-endpoint/prompt-injection.md) — `/v1/responses` tool-call prompt injection matrix
- [`reference/app-server-protocol.schema.json`](reference/app-server-protocol.schema.json) — JSON-RPC schema bundle (Codex app-server)
- [`reference/app-server-schema-0.92-tools.md`](reference/app-server-schema-0.92-tools.md) — schema extract for tool support (Codex 0.92.0)

## Deep dives and backlogs

- [`logging-gaps/README.md`](logging-gaps/README.md) — observability gap tracker

## Plans (working drafts)

- [`plans/2026-01-25-obsidian-tool-call-simulation-v2.md`](plans/2026-01-25-obsidian-tool-call-simulation-v2.md) — Responses tool-call simulation v2 implementation plan

## Internal docs (not published)

- Internal planning/surveys are maintained separately and are not part of the public distribution.

## Archive

- `docs/_archive/` (gitignored) — local-only historical root snapshots; not authoritative for current setup.

## Doc hygiene

- Run `npm run format:check` and `npm run lint:runbooks` before committing doc changes.
- Keep local-only notes out of the public repo or in private remotes.
