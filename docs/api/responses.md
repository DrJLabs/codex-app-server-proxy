# Responses (`/v1/responses`)

This endpoint aims to match the OpenAI Responses API closely and shares the same backend pipeline as chat completions.

## Intended clients

- Standard OpenAI Responses clients should use this endpoint.
- Obsidian Copilot uses `/v1/responses` when the selected model is gpt-5* (current ChatGPT-login Codex support). If you pick a chat-completions model, Copilot will use `/v1/chat/completions` instead (see [`chat-completions.md`](chat-completions.md)).
- Output mode defaults to `openai-json` for `/v1/responses`; override per request with `x-proxy-output-mode: openai-json` if needed.

## Enable/disable

`/v1/responses` is enabled by default. Disable it with:

```bash
PROXY_ENABLE_RESPONSES=false
```

## Auth

Bearer token is required:

```http
Authorization: Bearer <PROXY_API_KEY>
```

## Non-stream request (minimal)

```json
{
  "model": "codev-5",
  "input": "Say hello.",
  "stream": false
}
```

## Streaming (typed SSE)

When `stream:true`, the proxy emits typed SSE events such as:

- `response.created`
- `response.output_text.delta`
- `response.output_text.done`
- `response.completed`
- `done`

## Contract reference

See [`../openai-endpoint-golden-parity.md`](../openai-endpoint-golden-parity.md) for the canonical event ordering and envelope details.
