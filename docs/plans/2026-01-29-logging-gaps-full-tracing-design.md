# Logging Gaps Full Tracing Design

**Goal:** Provide dev-only, full-fidelity tracing for `/v1/responses` (openai-json) that captures raw ingress, raw app-server output (including thinking), and tool-call lifecycle data with stable correlation across layers.

**Scope:**
- Endpoint: `/v1/responses` only.
- Output mode: `openai-json` only.
- Environment: dev-only capture gated by `PROXY_ENV=dev`.

**Non-goals:**
- Production capture.
- Changing response shapes or tool-call semantics.
- Reworking the JSON-RPC transport protocol.

## Proposed Changes
1. **App-server raw capture (dev-only):**
   - New toggle `PROXY_CAPTURE_APP_SERVER_RAW=true` writes NDJSON lines for JSON-RPC traffic.
   - Each line includes `req_id`, `trace_id`, `copilot_trace_id`, `rpc_id`, `direction`, `method/notification_method`, and raw `payload`.
   - A per-record size guard truncates overly large payloads.
   - Capture path default: `test-results/app-server/raw/` with override env.

2. **Raw thinking capture (dev-only):**
   - New toggle `PROXY_CAPTURE_THINKING_RAW=true` writes NDJSON lines for agent deltas before sanitization.
   - Records include `req_id`, `trace_id`, `copilot_trace_id`, `event_type`, and raw content/metadata.
   - Capture path default: `test-results/responses-copilot/raw-thinking/`.

3. **Trace id propagation into backend events:**
   - Extend JSON-RPC trace context to include `trace_id` and `copilot_trace_id` from `res.locals`.
   - Backend trace events and raw capture lines include these ids for joins.

4. **Tool output logging:**
   - Emit structured `tool_call_output` logs (hash/len only) for tool output items in both stream and non-stream paths.
   - Include `call_id`, and `tool_name` when available, to correlate with tool-call arguments.

## Data Format
- App-server raw NDJSON line example:
  ```json
  {"ts": 1738147200000, "req_id":"req-1", "trace_id":"abc", "copilot_trace_id":"xyz", "rpc_id":42, "direction":"inbound", "notification_method":"responses/stream", "payload":{...}}
  ```
- Thinking raw NDJSON line example:
  ```json
  {"ts": 1738147200000, "req_id":"req-1", "event_type":"text_delta", "delta":"...", "metadataInfo":{...}}
  ```

## Security & Privacy
- Dev-only gating enforced by `PROXY_ENV=dev`.
- Size limits prevent unbounded growth; no default capture in prod.
- No changes to existing redaction or structured log policies.

## Testing & Verification
- Unit tests for backend trace capture and trace id propagation.
- Unit tests for tool output logging in responses handlers.
- Unit tests for raw capture writers (dev-only gating + truncation).

## Rollout
- Add env flags to config and document in `docs/dev/logging-schema.md`.
- Enable only in local/dev environments when required.
