# Troubleshooting

## 401 Unauthorized

- Ensure you’re sending `Authorization: Bearer <PROXY_API_KEY>` to protected routes.
- `/v1/models` is public by default but may return 401 if `PROXY_PROTECT_MODELS=true`.

## Login URL shown / auth.json invalid

- If `auth.json` is missing or invalid, the proxy returns a login URL in the error message.
- The Codex login flow uses a local callback on port `1435`; ensure it is open and not blocked.

## 503 worker_not_ready (app-server mode)

- In app-server mode (`PROXY_USE_APP_SERVER=true`), `/v1/chat/completions` and `/v1/responses` are gated by worker readiness.
- Check `/readyz` and `/healthz` for readiness reasons and supervisor state.

## "internal tools disabled" / `internal_tools_disabled`

If you see an error like `internal tools disabled` (or `code: "internal_tools_disabled"`), the Codex app-server attempted to invoke an internal tool (for example: WebSearch/fileChange/commandExecution) but the proxy blocked it.

Common causes:

- A client tool name collides with a Codex internal tool name (example: client `webSearch`). The proxy rewrites reserved names at `thread/start` (for example: `webSearch` -> `client_webSearch`) and maps back to the client name at the HTTP boundary.
- The model does not see the expected dynamic tool registry (missing/empty tools on the thread), so it falls back to internal tools.
- A follow-up tool-output request is treated as a new thread and loses the original tool manifest/instructions.

Mitigations:

- Keep `PROXY_DISABLE_INTERNAL_TOOLS_CONFIG=true` and `PROXY_DISABLE_INTERNAL_TOOLS_PROMPT=true`.
- Ensure follow-up tool outputs include the original `call_id` and go to the same proxy instance.
- In dev, enable raw capture (`PROXY_CAPTURE_APP_SERVER_RAW=true` and `PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS=true`) and inspect `test-results/app-server/raw/app-server-raw.ndjson` plus `test-results/responses-copilot/raw-unredacted/`.

## `/v1/responses` missing

- `/v1/responses` is gated by `PROXY_ENABLE_RESPONSES` (default true).

## `/metrics` returns 403

- Metrics are restricted by default. Enable loopback access or provide a metrics bearer token (see [`../src/routes/metrics.js`](../src/routes/metrics.js)).

## Cloudflare 524 / long non-stream requests

- Consider using streaming mode.
- For dev stacks behind Cloudflare, the repo supports an early-finalize guard (`PROXY_NONSTREAM_TRUNCATE_AFTER_MS`) to avoid the 100s no-bytes window.

## Need the canonical contract?

- See [`openai-endpoint-golden-parity.md`](openai-endpoint-golden-parity.md) for the byte-level streaming and envelope definitions.
