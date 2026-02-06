# Responses (openai-json) Logging Gaps - App-Server Path

## Scope
- Endpoint: `/v1/responses` only.
- Output mode: **openai-json** only (default via `PROXY_RESPONSES_OUTPUT_MODE`).
- Path: proxy -> app-server JSON-RPC -> proxy -> client (no Traefik/ForwardAuth).

## Goal ("full tracing")
Ability to reconstruct, per request, the **raw ingress payload**, **raw app-server output (including thinking tokens)**, and **tool-call lifecycle** (arguments + outputs), correlated by `req_id`/`trace_id`/`copilot_trace_id` without relying on ad-hoc stdout dumps.

## Reference anchors (code + docs)
- Logging schema + redaction rules: `docs/dev/logging-schema.md`, `src/services/logging/schema.js`.
- Capture settings + defaults: `src/config/index.js`, `src/handlers/responses/capture.js`.
- Responses ingress summary logging: `src/handlers/responses/ingress-logging.js`.
- Responses handlers (openai-json output mode defaulting): `src/handlers/responses/stream.js`, `src/handlers/responses/nonstream.js`, `src/handlers/responses/shared.js`.
- Responses SSE adapter + tool-call summaries: `src/handlers/responses/stream-adapter.js`.
- JSON-RPC transport + backend trace events: `src/services/transport/index.js`, `src/dev-trace/backend.js`, `src/dev-trace/sanitize.js`, `src/dev-logging.js`.

## End-to-end coverage (what is currently logged)

### 1) Raw ingress (client -> proxy)
**Structured (content-free):**
- `responses_ingress_raw` emits shape-only metadata (tools present, input item types, marker flags, tool-output size summaries, output mode effective), **no content**.
- Source: `src/handlers/responses/ingress-logging.js` -> `logResponsesIngressRaw()`.

**Capture (contentful, opt-in):**
- `PROXY_CAPTURE_RESPONSES_TRANSCRIPTS=true` -> sanitized capture of request/response.
- `PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS=true` -> raw bodies (still header-redacted).
- Stream captures record SSE events as emitted by the **proxy**, not the app-server.
- Source: `src/handlers/responses/capture.js`, config in `src/config/index.js`.

### 2) App-server IO (proxy <-> JSON-RPC)
**Dev trace (opt-in, dev only):**
- `backend_submission`/`backend_io`/`tool_block` events emitted to `PROTO_LOG_PATH` when `PROXY_ENV=dev` and `PROXY_LOG_PROTO=true`.
- Payloads are **sanitized** (`src/dev-trace/sanitize.js`) and then **redacted by default** because `payload` is scrubbed in `src/services/logging/schema.js` unless `PROXY_LOG_REDACT=false`.
- Source: `src/services/transport/index.js` -> `src/dev-trace/backend.js` -> `src/dev-logging.js`.

### 3) Proxy output (proxy -> client)
**Streaming (`/v1/responses`, `stream=true`):**
- Typed SSE events emitted by `createResponsesStreamAdapter()`.
- Per-event dev trace logging (`responses_sse_out`) includes event type + sizes (no content), gated by `PROXY_LOG_PROTO`.
- Structured `sse_summary` + `responses_transform_summary` include tool-call counts, hashes, usage summaries.
- Source: `src/handlers/responses/stream-adapter.js`.

**Non-stream (`stream=false`):**
- Structured `responses_nonstream_summary` + `responses_transform_summary` include tool-call counts and output text hash.
- Capture writes full response envelope if `PROXY_CAPTURE_RESPONSES_*` enabled.
- Source: `src/handlers/responses/nonstream.js` + `src/handlers/responses/capture.js`.

## Gaps vs "full tracing" goal

### GAP-A - Raw app-server output capture is dev-only and opt-in
- JSON-RPC notifications are **sanitized** and **redacted by default** in dev trace; in non-dev environments `PROTO_LOG_PATH` is not emitted at all (`PROXY_LOG_PROTO` is dev-only in `src/dev-logging.js`).
- Even with `PROXY_LOG_REDACT=false`, payloads are truncated to `PROXY_TRACE_BODY_LIMIT` (default 4096 bytes) and are **not a full-fidelity capture**.
- Use `PROXY_CAPTURE_APP_SERVER_RAW=true` (dev-only) when you need full-fidelity JSON-RPC payload capture.

### GAP-B - "Raw ingress capture" is opt-in and not guaranteed
- The only contentful ingress capture for `/v1/responses` is via `PROXY_CAPTURE_RESPONSES_*` flags.
- Structured ingress logs are shape-only (as intended) and do **not** preserve payloads.
- Result: full tracing depends on ops setting capture flags; otherwise raw ingress is unavailable.

### GAP-C - Tool-call outputs are not logged end-to-end
- Proxy logs **tool-call arguments** (hash/len) for streaming, and **tool-call counts** in summaries.
- There is **no structured log for tool outputs** returned by the client (`tool_output` items), only a boolean + byte count in ingress summary and a warning for unmatched outputs.
- Non-stream path lacks the per-call `tool_call_arguments_done` log (stream-only today).
- Result: cannot trace tool execution outputs and call-id continuity across steps without capture files.

### GAP-D - Correlation gaps across layers
- Backend trace events currently carry `{ req_id, route, mode }` only; they do **not** include `trace_id` or `copilot_trace_id` even when present in handler locals (see `docs/logging-gaps/README.md`).
- Result: hard to join backend notifications to structured ingress/egress logs unless using `req_id` alone.

### GAP-E - "Thinking tokens" may be sanitized or stripped before proxy output
- Metadata sanitization (when `PROXY_SANITIZE_METADATA=true`) removes segments before the adapter emits text deltas, but only logs hash/keys summaries.
- There is no persistent "raw-before-sanitize" stream for responses.
- Result: cannot reconstruct reasoning/metadata segments if they were removed.

## Current status and next steps

### Status (implemented, dev-only unless noted)
- App-server raw capture (dev-only): `PROXY_CAPTURE_APP_SERVER_RAW=true` with `PROXY_CAPTURE_APP_SERVER_RAW_DIR` and `PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES`.
- Raw thinking capture (dev-only): `PROXY_CAPTURE_THINKING_RAW=true` with `PROXY_CAPTURE_THINKING_RAW_DIR` and `PROXY_CAPTURE_THINKING_RAW_MAX_BYTES`.
- Tool output logging emits `tool_call_output` summaries (hash/len only) in both stream and non-stream paths.
- Backend trace events include `trace_id` and `copilot_trace_id` for correlation.

### Remaining gaps
- Full-fidelity app-server output capture is dev-only and opt-in. Non-dev environments still rely on sanitized/truncated proto trace and/or HTTP transcript captures.
- Tool outputs are logged as hashes/byte counts only unless transcript capture is enabled.

### Ops playbook (dev-only)
Recommended dev toggles (local or dev stack):
- `PROXY_ENV=dev`
- `PROXY_LOG_PROTO=true`
- `PROXY_LOG_REDACT=false` (dev-only; enables unredacted proto payloads)
- `PROXY_TRACE_BODY_LIMIT=65536` (raise if needed for long deltas)
- `PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS=true`
- Optional: `PROXY_CAPTURE_RESPONSES_RAW_DIR=./test-results/responses-copilot/raw-unredacted`
- Optional: `PROXY_CAPTURE_APP_SERVER_RAW=true`
- Optional: `PROXY_CAPTURE_APP_SERVER_RAW_DIR=./test-results/app-server/raw`
- Optional: `PROXY_CAPTURE_THINKING_RAW=true`
- Optional: `PROXY_CAPTURE_THINKING_RAW_DIR=./test-results/responses-copilot/raw-thinking`

How to correlate artifacts:
- Use `X-Request-Id` from the HTTP response as `req_id` for log joins.
- Set `x-proxy-capture-id` on the request to pin capture filenames.
- Raw ingress/egress captures include `metadata.proxy_trace_id` (same as `req_id`).
- App-server raw capture lines include `req_id`, `rpc_id`, and `notification_method` for matching.

Where to look:
- Structured stdout: container logs (search `event:"responses_ingress_raw"`, `event:"sse_summary"`).
- Dev trace NDJSON: `${PROTO_LOG_PATH}` (default `/tmp/codex-proto-events.ndjson`).
- Responses raw captures: `test-results/responses-copilot/raw-unredacted/` (or override path).
- App-server raw capture NDJSON: `test-results/app-server/raw/app-server-raw.ndjson` (when enabled).
- Thinking raw capture NDJSON: `test-results/responses-copilot/raw-thinking/responses-thinking-raw.ndjson` (when enabled).

## Notes specific to openai-json mode
- `/v1/responses` defaults to `openai-json` via `PROXY_RESPONSES_OUTPUT_MODE` and `applyDefaultProxyOutputModeHeader()` (`src/handlers/responses/shared.js`).
- Response shapes are tagged as `responses_v0_typed_sse_openai_json` (stream) and `responses_v0_nonstream_openai_json` (non-stream) in summaries (`src/handlers/responses/stream-adapter.js`, `src/handlers/responses/nonstream.js`).
- Tool-call events are emitted as typed SSE (`response.output_item.*`, `response.function_call_arguments.*`) in stream mode; these are logged only as sizes/hashes unless capture is enabled.
