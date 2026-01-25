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

## Deep dives and backlogs

- [`app-server-migration/`](app-server-migration/) — JSON-RPC schema exports and migration notes
- [`logging-gaps/README.md`](logging-gaps/README.md) — observability gap tracker

## Internal docs (not published)

- Internal planning/surveys/archives are maintained separately and are not part of the public distribution.

## Doc hygiene

- Run `npm run format:check` and `npm run lint:runbooks` before committing doc changes.
- Keep local-only notes out of the public repo or in private remotes.
