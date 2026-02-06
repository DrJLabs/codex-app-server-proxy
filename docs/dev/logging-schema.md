# Logging Schema (Story 3.1)

Purpose: align access, worker lifecycle, and trace/usage emitters to a single structured JSON shape while preserving redaction.

## Canonical fields

- `timestamp` (ISO string), `ts` (ms epoch)
- `level` — `info` | `warn` | `error`
- `component` — `http` | `worker` | `trace` | `usage` | `cors`
- `event` — e.g., `access_log`, `worker_ready`, `worker_exit`, `proto_event`, `usage_summary`
- `req_id` — request correlation id when available
- `route`, `model`, `latency_ms`
- `tokens_prompt`, `tokens_response`
- `worker_state` — `starting|running|ready|stopped`
- `restart_count`, `backoff_ms`
- `maintenance_mode`, `error_code`, `retryable`
- Extra metadata: `method`, `status`, `pid`, `stream`, `mode`, `kind` (usage/proto), `tool_buffer_*` counters

Redaction rules: keys `body|payload|headers|messages|content|params|data|request|response` are replaced with `[redacted]`; long strings truncate at 2000 chars.

## Sources & rotation

- STDOUT/STDERR: access logs and worker lifecycle events (ingest via container/log shipper).
- `TOKEN_LOG_PATH` (default `${TMPDIR}/codex-usage.ndjson`): usage summaries with schema fields; rotate via tmp cleaner or external logrotate.
- `PROTO_LOG_PATH` (default `${TMPDIR}/codex-proto-events.ndjson`): proto/trace events; gated by `PROXY_LOG_PROTO` / `PROXY_TRACE_REQUIRED`.
- `SANITIZER_LOG_PATH` (default `${TMPDIR}/codex-sanitizer.ndjson`): sanitizer toggles/summaries.

Sampling: none; every worker lifecycle transition and request is logged. Rotation is external (tmpdir cleanup or operator logrotate); no payload bodies are emitted in structured logs.

## Capture transcripts (full payloads)

- Enable sanitized captures with `PROXY_CAPTURE_CHAT_TRANSCRIPTS` / `PROXY_CAPTURE_RESPONSES_TRANSCRIPTS`.
- Enable raw bodies with `PROXY_CAPTURE_CHAT_RAW_TRANSCRIPTS` / `PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS`.
- Default directories (app cwd): `test-results/chat-copilot/raw/`, `test-results/chat-copilot/raw-unredacted/`, `test-results/responses-copilot/raw/`, `test-results/responses-copilot/raw-unredacted/`.
- Raw captures still redact secret headers (authorization, API keys, cookies).
- Each capture includes `metadata.proxy_trace_id` to correlate with structured logs.

## Dev-only raw capture streams

- App-server JSON-RPC raw capture (dev-only): `PROXY_CAPTURE_APP_SERVER_RAW=true` writes NDJSON to `PROXY_CAPTURE_APP_SERVER_RAW_DIR` (default `test-results/app-server/raw/app-server-raw.ndjson`).
- Raw thinking capture (dev-only): `PROXY_CAPTURE_THINKING_RAW=true` writes NDJSON to `PROXY_CAPTURE_THINKING_RAW_DIR` (default `test-results/responses-copilot/raw-thinking/responses-thinking-raw.ndjson`).
- Both are gated by `PROXY_ENV=dev` and include `req_id`, `trace_id`, and `copilot_trace_id` for correlation.

## Example

```json
{
  "timestamp": "2025-11-20T15:30:12.123Z",
  "ts": 1732116612123,
  "level": "info",
  "component": "worker",
  "event": "worker_ready",
  "worker_state": "ready",
  "restart_count": 1,
  "latency_ms": 420,
  "pid": 12345
}
```
