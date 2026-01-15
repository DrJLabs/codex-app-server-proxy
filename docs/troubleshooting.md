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

## `/v1/responses` missing

- `/v1/responses` is gated by `PROXY_ENABLE_RESPONSES` (default true).

## `/metrics` returns 403

- Metrics are restricted by default. Enable loopback access or provide a metrics bearer token (see [`../src/routes/metrics.js`](../src/routes/metrics.js)).

## Cloudflare 524 / long non-stream requests

- Consider using streaming mode.
- For dev stacks behind Cloudflare, the repo supports an early-finalize guard (`PROXY_NONSTREAM_TRUNCATE_AFTER_MS`) to avoid the 100s no-bytes window.

## Need the canonical contract?

- See [`openai-endpoint-golden-parity.md`](openai-endpoint-golden-parity.md) for the byte-level streaming and envelope definitions.
