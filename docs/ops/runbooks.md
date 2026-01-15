# Ops Runbooks

This repo includes scripts for common operator workflows (snapshot, rollback, backup, smoke).

## Smoke checks

- Dev: `npm run smoke:dev`
- Prod: `DOMAIN=<domain> KEY=<key> npm run smoke:prod`
- Tool-call smoke defaults to `/v1/responses`:
  - Dev smoke uses `TOOL_SMOKE_MODES=textual`.
  - Prod smoke defaults to `TOOL_SMOKE_MODES=structured`.
  - Override: `TOOL_SMOKE_ENDPOINT=chat TOOL_SMOKE_MODES=structured` to assert structured tool_calls on chat completions.
- If `PROXY_ENABLE_METRICS=true`, set `PROXY_METRICS_TOKEN` in `.env`/`.env.dev` (or pass `METRICS_TOKEN=...` when running smoke) to avoid 403s from `/metrics`.

## Snapshot (release bundle)

Create a snapshot bundle under `releases/`:

```bash
npm run ops:snapshot
```

Preview only:

```bash
npm run snapshot:dry-run
```

## Rollback

Rollback stacks using the recorded release bundles:

```bash
npm run ops:rollback
```

Environment-specific helpers:

```bash
npm run ops:rollback:prod
npm run ops:rollback:dev
```

## Backup Codex data

Back up `.codex-api` to the configured mount point:

```bash
npm run backup:data
```

## Dev → Prod config sync

Copy non-secret Codex home config from `.codev` to `.codex-api`:

```bash
npm run port:sync-config
```

This intentionally does not copy secrets such as `auth.json`.

## Cloud/CI bootstrap

For ephemeral environments (CI runners, cloud VMs), [`../scripts/setup-codex-cloud.sh`](../scripts/setup-codex-cloud.sh) installs deps, prepares writable Codex homes, and can optionally run tests:

```bash
./scripts/setup-codex-cloud.sh --verify
```
