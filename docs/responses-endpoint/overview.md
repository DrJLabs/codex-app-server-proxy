# `/v1/responses` — Implementation Overview (Native)

This repo implements `POST /v1/responses` with a native responses pipeline (no chat wrapper). Both non-stream and typed SSE streaming talk directly to the JSON-RPC transport.

The route is gated by `PROXY_ENABLE_RESPONSES` (default: `true`).

## Key files

- Routing: `src/routes/responses.js`
- Non-stream handler: `src/handlers/responses/nonstream.js`
- Stream handler: `src/handlers/responses/stream.js`
- Request normalizer (always-flatten): `src/handlers/responses/native/request.js`
- Envelope builder: `src/handlers/responses/native/envelope.js`
- JSON-RPC event ingestion: `src/handlers/responses/native/execute.js`
- Typed SSE adapter: `src/handlers/responses/stream-adapter.js`

## Request normalization (Responses → JSON-RPC)

`normalizeResponsesRequest` enforces OpenAI-style request shape:

- `messages` is rejected (400).
- `input` (string or array) is flattened into a role-tagged transcript:
  - `[system] ...`, `[developer] ...`, `[user] ...`, `[assistant] ...`
  - Tool outputs become `[tool:<call_id>] <output>`
- `input_image` is mapped to JSON-RPC `image` items, with role markers emitted only when needed for deterministic attribution.
- `previous_response_id` is accepted for compatibility but **never** echoed in responses.

The flattened transcript is an internal representation; the `/v1/responses` request/response schema is unchanged.

## Non-stream response shaping

`src/handlers/responses/nonstream.js` runs the native executor and builds the canonical Responses envelope:

- `object: "response"` and `created` are always present.
- Output items include a `message` item with `output_text` and `function_call` items for tools.
- `function_call.arguments` stays a **string**; no `call_id` field is emitted.

## Streaming (typed SSE)

`src/handlers/responses/stream.js` drives `runNativeResponses` and `createResponsesStreamAdapter`, emitting typed SSE events:

- `response.created`
- `response.output_text.delta` / `response.output_text.done`
- tool events: `response.output_item.added`, `response.function_call_arguments.delta/done`,
  `response.output_item.done`
- `response.completed` (final envelope)
- `done` with `[DONE]`

If an upstream/transport error occurs **after** SSE starts, the adapter emits
`response.failed` and terminates with `[DONE]` (no `response.completed`).

## Output mode

For `/v1/responses`, output mode is **header or default only**:

- `x-proxy-output-mode` (explicit) wins.
- Otherwise use `PROXY_RESPONSES_OUTPUT_MODE` (default `openai-json`).

No Copilot auto-detection is applied to `/v1/responses`.

## Observability

- **Structured logs (stdout):**
  - `responses_ingress_raw` (info) captures request shape and output mode.
  - `responses_nonstream_summary` (debug) includes status + usage + `previous_response_id_hash`.
  - `responses.sse_summary` (debug/error) includes stream outcome + usage + `previous_response_id_hash`.
- **Dev trace (NDJSON, `PROTO_LOG_PATH`):**
  - `responses_sse_out` logs each typed SSE event with `stream_event_seq`.
- Metrics: `codex_responses_sse_event_total{route,model,event}`.

## Tests

- Typed SSE contract: `tests/e2e/responses-contract.spec.js`
- Metrics presence: `tests/integration/metrics.int.test.js`

If you change typed SSE semantics, regenerate transcripts:

```bash
node scripts/generate-responses-transcripts.mjs
```
