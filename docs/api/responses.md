# Responses (`/v1/responses`)

This endpoint aims to match the OpenAI Responses API closely and uses a native responses pipeline (no chat wrapper).

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

## Input shape notes

- Use `input` (string or array of input items). `messages` is not supported and returns 400.
- `previous_response_id` is accepted for client compatibility but is not echoed back.
- `instructions` is supported and flattened into the internal transcript for JSON-RPC.

## Tool output shape

`/v1/responses` emits tool calls as top-level `function_call` items in `output[]`:

```json
{
  "type": "function_call",
  "id": "call_123",
  "call_id": "call_123",
  "name": "lookup_user",
  "arguments": "{\"id\":\"42\"}"
}
```

Follow-up requests should send tool results as `function_call_output` items:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"status\":\"ok\"}"
}
```

Clients that echo `function_call` items back in `input` are accepted.

## Tool outputs and thread continuity

When a client submits `function_call_output` items, the proxy resolves the originating app-server thread and reuses its canonical tool manifest and instructions.

- If **none** of the tool outputs map to an active tool call, the request is rejected with `tool_outputs_unmatched`.
- If some outputs match and others do not, the request is accepted. Unmatched outputs are left in the next turn transcript and the proxy logs `tool_outputs_unmatched` with a count.

## Tool name rewriting (internal collision avoidance)

Before starting a new app-server thread, the proxy rewrites function-tool names that collide with Codex internal tool namespaces. For example, a client tool named `webSearch` is declared to the app-server as `client_webSearch`, but tool calls in `/v1/responses` are mapped back to `webSearch` for the client.

Raw app-server traces will show the rewritten names.

## Internal tool shim (optional)

When `PROXY_DISABLE_INTERNAL_TOOLS_CONFIG=true`, internal app-server tool notifications are blocked. If `PROXY_ENABLE_INTERNAL_TOOLS_SHIM=true`, the proxy can translate some internal tool events into dynamic tool calls:

- Internal `webSearch` events -> dynamic tool `webSearch` (ensures `chatHistory: []`).
- Internal `fileChange` events -> dynamic tool `writeToFile` or `replaceInFile` (based on presence of `diff`).

When the shim recognizes a tool output for a shimmed internal tool call, the proxy appends a `[function_call_output ...]` text line to the next turn so the model can continue.

This shim requires the client tool names above to exist; other internal tool types (for example: `commandExecution`) still fail when internal tools are disabled.

## Streaming (typed SSE)

When `stream:true`, the proxy emits typed SSE events such as:

- `response.created`
- `response.output_text.delta`
- `response.output_text.done`
- `response.completed`
- `done`

Each SSE payload includes a monotonically increasing `sequence_number`.

## Contract reference

See [`../openai-endpoint-golden-parity.md`](../openai-endpoint-golden-parity.md) for the canonical event ordering and envelope details.
