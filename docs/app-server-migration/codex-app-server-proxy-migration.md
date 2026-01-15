# Migrating `codex-app-server-proxy` to `codex app-server`

⚠️ Proto backend has been removed. Parity fixtures/tests are retired; only app-server transcripts are maintained. This document remains as historical migration notes.

> **Goal (completed):** Switch backend from `codex proto` to `codex app-server` **without changing** the proxy’s external OpenAI‑compatible API responses (both streaming and non‑streaming).

---

## A. Replace CLI invocation

**Before (per request):**

```js
spawn("codex", [
  "proto",
  "--config",
  'preferred_auth_method="chatgpt"',
  /* model, sandbox, … */
]);
```

**After (once at startup):**

```js
spawn("codex", [
  "app-server",
  "--model",
  effectiveModel, // or provided by profile
  "--config",
  'preferred_auth_method="chatgpt"',
  "--config",
  'sandbox_mode="workspace-write"',
  /* any -c key=value overrides you already pass */
]);
```

- Keep the same `CODEX_BIN` resolution; only subcommand changes.
- Pin the CLI dependency (`@openai/codex`) in `package.json` so the `app-server` binary ships with the image.
- `src/lib/json-rpc/schema.ts` is canonical; contributors should not regenerate it from templates. After bumping the CLI, update `schema.ts` only if the runtime contract changes.
- Refresh and verify the JSON Schema bundle after protocol changes: `npm run jsonrpc:bundle` then `npm run jsonrpc:verify`. See `docs/app-server-migration/jsonrpc-schema-workflow.md`.
- `npm run test:unit` and `npm run test:integration` guard against stale bundles or request payload drift; schema validation runs in CI via `jsonrpc:verify`.

---

## B. Process model change (singleton child)

- **Old:** spawn one child per HTTP request; write prompt; read events; kill child.
- **New:** spawn **one** `app-server` on service start; **reuse** for all requests.
  - Create a module‑level singleton `codexAppServer` with start/stop and a JSON‑RPC client.
  - On HTTP server shutdown (SIGINT/SIGTERM), terminate the child gracefully.

**Health:** implement a readiness/health probe that sends a lightweight RPC (or checks initialized state). Auto‑restart the child on exit.

---

## C. JSON‑RPC client: write & read

### C.1 Writer (requests)

- On first use, send **`initialize`** with `client_info`.
- For each API call:
  1. **`sendUserTurn`** (optionally set/receive `conversation_id`)
  2. **`sendUserMessage`** with the flattened prompt text (same `joinMessages(messages)` you already use)
- Assign unique numeric/string `id`s per RPC and track the outstanding map.

### C.2 Reader (responses & notifications)

- Parse **lines** from `stdout` as JSON.
- If a message has `id`, it’s a **response** to a prior request.
- If a message has `method`, it’s a **notification**. Route by method:
  - `agentMessageDelta` → write SSE `delta` chunk.
  - `agentMessage` → write final SSE chunk for message content.
  - `tokenCount`/usage style events → capture `prompt_tokens`/`completion_tokens`.
  - tool/lifecycle events → optional logging/metrics.
- Maintain a per‑HTTP‑request **context** (requestId → conversationId, rpc ids, buffers, usage counters) so notifications go to the correct stream even with concurrency.

---

## D. Streaming path (SSE)

- Keep your external streaming identical:
  - For each `agentMessageDelta` notification, emit:
    ```json
    {
      "id": "...",
      "object": "chat.completion.chunk",
      "choices": [{ "index": 0, "delta": { "content": "…" }, "finish_reason": null }]
    }
    ```
  - For the final `agentMessage`/completion, emit the terminal chunk, then `data: [DONE]`.
- Preserve your existing **tool/function call** delta shaping if the notification includes such payloads.

---

## E. Non‑streaming path (JSON)

- Accumulate message content from notifications and/or use the final RPC `result`.
- Set `choices[0].message` (role `assistant`, content full text).
- Compute `usage`:
  - Prefer explicit usage from notifications or result.
  - Fallback to your existing estimator only if strict counts absent.
- Determine `finish_reason` from the final event/result (map server reason → OpenAI values: `stop`, `length`, `content_filter`, `tool_calls`, etc.).

---

## F. Conversation lifecycle

- **Stateless external API:** create/let the server create a **new conversation per request**; do not carry memory between calls.
- After finishing a request, **release** the context; if the API exposes a cleanup call (e.g., `conversation/delete`), optionally call it to minimize memory footprint.

---

## G. Concurrency & timeouts

- Continue to cap **SSE concurrency** (e.g., environment `PROXY_SSE_MAX_CONCURRENCY`).
- Implement **per‑request timeouts** as before. If the app-server doesn’t support cancel:
  - Return a timeout error to the client.
  - Optionally **restart** the app-server child if it appears stuck (circuit breaker).
- Avoid killing the shared child for routine request timeouts unless necessary.

---

## H. Configuration & deployment

- **Auth:** ensure `CODEX_HOME` contains valid login (ChatGPT OAuth via `codex login`) or set `OPENAI_API_KEY` and configure `preferred_auth_method="api_key"`.
- **Docker/compose:** mount credentials into the container, e.g.:
  ```yaml
  volumes:
    - ~/.codex:/app/.codex-api:rw
  environment:
    - CODEX_HOME=/app/.codex-api
  ```
- **Profiles/models:** if callers specify `model`, run multiple app-server **instances** (one per model/profile) and route based on the request. Do not rely on in‑process model switching unless officially supported.
- **Upgrades:** pin a tested CLI version; track release notes for JSON‑RPC/event name changes.
- **Secrets:** keep credentials outside the image—mount them into `/app/.codex-api` and ensure the directory stays writable for Codex rollouts and session state.
- **Probes & orchestration:** keep your orchestrator wiring aligned to readiness (`/readyz`) and liveness (`/livez`) so traffic drains promptly when workers restart.

### H.1 Docker Compose health checks

Add explicit HTTP health checks so orchestrators only send traffic once `/readyz` reports ready. Example:

```yaml
services:
  codex-api:
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:${PORT:-11435}/readyz || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 15s
```

Compose keeps restarting the container if `/livez` fails; the readiness endpoint flips back to `503` within ~5s of a worker exit, so the check above gates deployment rolls until the worker handshake succeeds again.

### H.2 systemd configuration

Ensure units rely on the new probes and restart counters. Recommended unit fragment:

```ini
[Service]
ExecStart=/usr/bin/node /opt/codex/server.js
ExecStartPost=/usr/bin/curl --fail --silent --retry 5 --retry-connrefused http://127.0.0.1:${PORT:-11435}/livez
Restart=on-failure
RestartSec=5s
```

Systemd will only report the service healthy after `/livez` succeeds; readiness remains false until the supervisor announces the JSON-RPC handshake.

### H.3 Traefik load balancer wiring

Wire the external load balancer to `/readyz` so traffic drains instantly when the worker restarts:

```yaml
labels:
  - "traefik.http.services.codex-api.loadbalancer.healthCheck.path=/readyz"
  - "traefik.http.services.codex-api.loadbalancer.healthCheck.interval=5s"
  - "traefik.http.services.codex-api.loadbalancer.healthCheck.timeout=2s"
```

Traefik will stop routing within a single interval when readiness falls to `false`, aligning with the supervisor’s <5s guarantee.

### H.4 Probe payload expectations

- `/readyz` exposes restart/backoff metadata in `health.readiness.details` (`restarts_total`, `next_restart_delay_ms`, `last_exit`, `startup_latency_ms`, `last_ready_at`).
- Crash/restart cycles flip readiness to `503` within <5s while `/livez` stays `200` during supervised restarts.
- Slow starts keep readiness false until the handshake completes.
- Backoff respects the 250 ms to 5 s policy; alert if `next_restart_delay_ms > 5000` or `restarts_total` grows.

### H.5 Smoke commands (local)

```bash
curl -fsS http://127.0.0.1:${PORT:-11435}/readyz | jq '.health.readiness'
curl -fsS http://127.0.0.1:${PORT:-11435}/livez | jq '.health.liveness'
curl -fsS http://127.0.0.1:${PORT:-11435}/metrics | grep codex_worker_restarts_total
```

Expect `ok:true` when the worker handshakes; crash loops should show `reason:"worker_exit"` plus incremented `restarts_total` and non-zero `next_restart_delay_ms` until recovery.

---

## I. Code touch‑points (typical repo)

1. **Process spawn module**: change subcommand; add singleton lifecycle; add health/restart logic.
2. **Protocol adapter**: replace proto line parser with JSON‑RPC reader; add request writer.
3. **SSE handler**: map `agentMessageDelta`/`agentMessage` to OpenAI chunks; keep existing shape.
4. **Non‑stream handler**: assemble final message & usage; finalize finish_reason.
5. **Config/env**: ensure `CODEX_HOME`, model/profile flags, sandbox/approvals are passed.
6. **Tests**: use the deterministic JSON-RPC shim and refresh golden transcripts.
7. **Docs**: update README and deployment notes (auth, volumes, CLI version).

---

## J. Example JSON-RPC shapes

**Initialize:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "client_info": { "name": "codex-app-server-proxy", "version": "1.0.0" } }
}
```

**Turn + message:**

```json
{"jsonrpc":"2.0","id":2,"method":"sendUserTurn","params":{}}

{"jsonrpc":"2.0","id":3,"method":"sendUserMessage","params":{"text":"[system] …\n[user] …"}}
```

---

## K. Transcript fixture maintenance (app-server only)

1. **Refresh transcripts** – run `npm run transcripts:generate` to capture app-server outputs. The generator writes to `test-results/chat-completions/app/`, stamps each artifact with `backend`, `backend_storage`, `codex_bin`, `cli_version`, `node_version`, and the current Git `commit`, and regenerates `test-results/chat-completions/manifest.json` summarizing scenario coverage.
2. **Smoke the baseline** – before publishing updated fixtures, run:
   ```bash
   npm run test:integration
   npm test
   ```
   This confirms the SSE adapters remain healthy after regeneration. Capture the command output (or CI links) for the release record.
3. **Log versions** – copy the Codex CLI/App Server version information from the transcript `metadata` blocks (or `manifest.json`) into deployment notes so downstream stories know which baseline the fixtures represent.
4. **Intentional mismatch drills (optional)** – edit a single transcript to validate the tooling, then restore the corpus with `npm run transcripts:generate`.

**Streaming delta (notification):**

```json
{ "jsonrpc": "2.0", "method": "agentMessageDelta", "params": { "delta": "Hello" } }
```

**Final message (notification):**

```json
{ "jsonrpc": "2.0", "method": "agentMessage", "params": { "text": "Hello world!" } }
```

**Final response (to id 3):**

```json
{ "jsonrpc": "2.0", "id": 3, "result": { "status": "complete" } }
```

(Exact method names/fields can evolve—write a tolerant adapter.)

---

### K.1 Tool-call regression anchors (Story 2.10)

- **Structured fixtures (stop-after-tools on/off):** Run `npm run transcripts:generate` twice with `PROXY_STOP_AFTER_TOOLS=false` and `PROXY_STOP_AFTER_TOOLS=true PROXY_STOP_AFTER_TOOLS_MODE=burst`, writing results under `tests/e2e/fixtures/tool-calls/*.app.json` and updating `manifest.json` to record backend, stop policy, and seed. Proto variants have been removed for Story 2.10+. These fixtures back ACs 1/2/9/23/29/31/37.
- **Textual fallback + large-arg stub:** Capture a replay that streams a literal `<use_tool>` block (multibyte, 8KB+) and document the expected tail stripping in `tests/e2e/fixtures/tool-calls/README.md`. If the generator lacks this scenario, add a placeholder entry and link to the captured transcript path so smoke/tests can reference it (ACs 3/7/15/16/40).
- **Disconnect/error smoke stub:** Add a smoke path that aborts after the first `delta.tool_calls` and verifies no more frames arrive; record the gap until the harness exists. Note expected artifacts: raw SSE, normalized JSON, backend stderr (ACs 12/13/18/26/36).
- **Smoke runner usage:** `node scripts/smoke/stream-tool-call.js [--expect-xml] [--allow-single] [--include-usage]` writes artifacts to the internal QA artifacts directory (not published here) and fails on mixed frames or multiple finish chunks. Extend it with disconnect/textual scenarios when added, and wire into CI smoke once present (ACs 4/10/19/20/25/27/33/42).
- **CI gate reminder:** `npm run test:integration && npm test` must pass after fixture refresh; parity or smoke failures block rollout. Upload updated fixtures plus hashes to the PR and cite the seed/CLI version in the change summary (AC 5/18).

## L. Remaining gaps

1. **No CI/dev mock:** add a lightweight JSON‑RPC fake app-server for tests (fixtures for initialize, deltas, final).
2. **Cancellation:** if/when Codex surfaces a cancel RPC, wire it; until then rely on timeouts and selective restarts.
3. **Schema evolution:** feature-flag method handlers; ignore unknown notifications; log for observability.
4. **Per-request models:** prefer instance routing; optionally queue per-model workers.
5. **Tool events:** ensure function/tool call deltas continue to map to OpenAI tool_calls if you expose them.

---

## N. Runbook checklist updates

### N.1 Prerequisites before toggling `PROXY_USE_APP_SERVER`

1. Verify `@openai/codex@0.53.0` is installed in the target image or host before enabling the app-server to guarantee the bundled binary includes the `app-server` subcommand (Source: Section A, [../architecture.md#decision-summary](../architecture.md#decision-summary)).
2. Confirm the environment mounts a writable `CODEX_HOME` (`.codev` for dev, `.codex-api` for containerized deployments) so the supervisor can persist rollout and session state (Source: Section H; [../stories/1-5-wire-readiness-and-liveness-probes-to-worker-state.md#dev-notes](../stories/1-5-wire-readiness-and-liveness-probes-to-worker-state.md#dev-notes)).
3. Stage and production monitors must track `/readyz` latency plus `worker_supervisor.restarts_total`; alert if readiness stays false for longer than 30 s or restarts increase by >1 within 10 minutes (Source: Section H; [../architecture.md#decision-summary](../architecture.md#decision-summary)).

### N.2 Toggle workflow by environment

- **Docker Compose (dev & staging):**
1. Edit `.env.dev` or the staging compose overrides so `PROXY_USE_APP_SERVER=true`; set to `false` only during maintenance windows when the backend is unavailable (Source: internal tech stack doc; not published here).
  2. Run `npm run dev:stack:down` (if active) followed by `npm run dev:stack:up` to rebuild with the new flag.
  3. Execute `npm run smoke:dev` to validate CLI availability (`codex app-server --help`) and edge routing before promoting traffic (Source: [../../scripts/dev-smoke.sh](../../scripts/dev-smoke.sh)).
- **systemd (production host):**
  1. Update `/etc/systemd/system/codex-openai-proxy.service.d/env.conf` so `Environment=PROXY_USE_APP_SERVER=true`.
  2. Reload units with `systemctl daemon-reload && systemctl restart codex-openai-proxy`.
  3. Run `npm run smoke:prod` for the public domain, ensuring `/readyz` flips to `200` before reopening traffic (Source: [../../scripts/prod-smoke.sh](../../scripts/prod-smoke.sh)).
- **Traefik health gating:** ensure `traefik.http.services.codex-api.loadbalancer.healthCheck.path=/readyz` remains configured so traffic drains during worker restarts (Source: Section H; [../architecture.md#decision-summary](../architecture.md#decision-summary)).

### N.3 Verification checklist after toggling

1. `curl -f https://{domain}/readyz` returns `200` with `"ready":true` within five seconds (Source: [../stories/1-5-wire-readiness-and-liveness-probes-to-worker-state.md#dev-notes](../stories/1-5-wire-readiness-and-liveness-probes-to-worker-state.md#dev-notes)).
2. `curl -f https://{domain}/livez` stays `200`; any `503` requires paging the on-call and rolling back the flag (Source: Section H).
3. Run `npm run lint:runbooks` before publishing documentation updates to satisfy formatting and link linting (Source: internal tech stack doc, testing/QA section; not published here).

### N.4 Environment configuration matrix

| Environment       | Default backend | Flag toggle location                                         | CLI version requirement | `CODEX_HOME` mount | Smoke verification command              | Probe expectation                                                                        |
| ----------------- | --------------- | ------------------------------------------------------------ | ----------------------- | ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Local / Dev stack | app-server (`true`) | `.env.dev` (`PROXY_USE_APP_SERVER=true`; set to `false` only during maintenance windows when the backend is unavailable) | `@openai/codex@0.53.0`  | `${REPO}/.codev`   | `npm run smoke:dev`                     | `http://127.0.0.1:${PORT:-11435}/readyz` returns `200` after supervisor handshake (<5s)  |
| Staging           | app-server (`true`) | compose overrides / `.env.dev` (`PROXY_USE_APP_SERVER=true` by default; set to `false` only during maintenance windows when the backend is unavailable) | `@openai/codex@0.53.0`  | `/app/.codex-api`  | `npm run smoke:dev` (with `DEV_DOMAIN`) | `https://{staging-domain}/readyz` gated via Traefik health check                         |
| Production        | app-server (`true`) | `/etc/systemd/system/codex-openai-proxy.service.d/env.conf` (`Environment=PROXY_USE_APP_SERVER=true`; set to `false` only during maintenance windows when the backend is unavailable) | `@openai/codex@0.53.0`  | `/app/.codex-api`  | `npm run smoke:prod`                    | `https://codex-api.example.com/readyz` wired to Traefik health monitor               |

Defaults mirror `.env.example`, `.env.dev`, and `docker-compose.yml`; the docs lint compares this matrix against those files to catch drift (Source: Section H; internal tech stack doc; not published here).

### N.5 Operational change log additions

- 2025-10-31 — Documented feature flag rollout, environment matrix, and probe verification steps for the app-server cutover. Linked smoke harnesses and Story 1.5 probe evidence so partner teams can reuse readiness data (Source: [../epics.md#story-16-document-foundation-and-operational-controls](../epics.md#story-16-document-foundation-and-operational-controls); [../stories/1-5-wire-readiness-and-liveness-probes-to-worker-state.md#change-log](../stories/1-5-wire-readiness-and-liveness-probes-to-worker-state.md#change-log)).

### N.6 Tool-call burst controls & telemetry (Story 2.9a)

Multi-tool turn fidelity ships behind explicit flags so operators can cap or roll back behavior without redeploying:

| Variable | Default | Effect | Rollback pairing |
| --- | --- | --- | --- |
| `PROXY_STOP_AFTER_TOOLS` | `false` | When `true`, terminate the stream immediately after a tool burst (still emits finish chunk + `[DONE]`). | Combine with MODE=`first` for legacy single-call behavior. |
| `PROXY_STOP_AFTER_TOOLS_MODE` | `burst` | `burst` resets a short grace timer so all sequential tool calls finish; `first` cuts after the first call. | Set to `first` with `PROXY_TOOL_BLOCK_MAX=1` to fully mimic Story 2.8 behavior. |
| `PROXY_TOOL_BLOCK_MAX` | `0` (unlimited) | Hard cap on the number of tool calls forwarded per choice. | Use `1` during incident mitigation; telemetry records truncation when the cap hits. |
| `PROXY_SUPPRESS_TAIL_AFTER_TOOLS` | `false` | Drops assistant narration that arrives after the last `<use_tool>` block. | Leave `true` while burst mode is active to keep responders from seeing stray prose. |
| `PROXY_TOOL_BLOCK_DEDUP` | `false` | Removes duplicate textual `<use_tool>` blocks when Codex emits identical payloads. | Leave `false` unless clients complain about duplicates. |
| `PROXY_TOOL_BLOCK_DELIMITER` | `""` | Separator between textual blocks in Obsidian mode. Set to `true` (newline) or a literal string (supports `\n`). | Set to `false`/empty to restore tightly packed XML. |
| `PROXY_ENABLE_PARALLEL_TOOL_CALLS` | `false` | Exposes Codex’s experimental parallel tools. Keep disabled until app + downstream clients fully support it. | Leave `false` unless staging tests explicitly require parallel execution. |

**Telemetry expectations**

- Streaming handlers emit an SSE comment before `[DONE]` with `{"tool_call_count":N,"tool_call_truncated":bool,"stop_after_tools_mode":"..."}`. Tail `scripts/smoke/stream-tool-call.js` output or run `curl` with `--no-buffer` to verify counts.
- Non-stream responses include HTTP headers: `x-codex-stop-after-tools-mode`, `x-codex-tool-call-count`, and `x-codex-tool-call-truncated`.
- Structured logs now capture the same data:
  - `TOKEN_LOG_PATH` (usage NDJSON) records `tool_call_count_total`, `tool_call_truncated_total`, and `stop_after_tools_mode` per request.
  - `PROTO_LOG_PATH` includes `kind:"tool_call_summary"` entries with burst counts, truncation flags, `stop_after_tools_mode`, and `tool_block_max`.

**Operational validation**

1. Run `node scripts/smoke/stream-tool-call.js` (requires `KEY` env) to assert at least two tool calls stream under normal burst mode. Pass `--allow-single` only when intentionally capping to single-call mode.
2. Tail usage logs to ensure `tool_call_truncated_total` flips to `1` when you set `PROXY_TOOL_BLOCK_MAX=1` (legacy mode) and returns to `0` when the cap is removed.
3. Document any flag flips in the rollout notes and keep `docs/codex-proxy-tool-calls.md` aligned with production defaults.
