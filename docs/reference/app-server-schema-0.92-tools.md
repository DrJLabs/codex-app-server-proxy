# App-server schema (Codex 0.92.0) — tools findings

## How the schema was obtained

```bash
node ./node_modules/@openai/codex/bin/codex.js app-server generate-json-schema --out /tmp/app-server-schema-0.92.0
```

Primary bundle:
- `/tmp/app-server-schema-0.92.0/codex_app_server_protocol.schemas.json`

## Request params (still no per-request tool manifest)

From the generated schema:

- `SendUserTurnParams.properties` = `approvalPolicy`, `conversationId`, `cwd`, `effort`, `items`, `model`, `outputSchema`, `sandboxPolicy`, `summary`
- `SendUserMessageParams.properties` = `conversationId`, `items`

There is still **no `tools` field** on the v1 request types.

## v2 thread start params (dynamic tools added)

`v2.ThreadStartParams.properties` now include:

- `dynamicTools` (array of `DynamicToolSpec`)

`DynamicToolSpec` schema (from `v2/ThreadStartParams.json`):

```json
{
  "type": "object",
  "required": ["description", "inputSchema", "name"],
  "properties": {
    "description": {"type": "string"},
    "inputSchema": true,
    "name": {"type": "string"}
  }
}
```

## Dynamic tool call events (server -> client)

The event stream now includes a dynamic tool call request item:

```json
{
  "type": "dynamic_tool_call_request",
  "tool": "string",
  "arguments": "any",
  "callId": "string",
  "turnId": "string"
}
```

(See `EventMsg.json` and `ServerNotification.json` in the exported bundle.)

## Dynamic tool call response (client -> server)

`DynamicToolCallResponse` is defined as:

```json
{
  "type": "object",
  "required": ["output", "success"],
  "properties": {
    "output": {"type": "string"},
    "success": {"type": "boolean"}
  }
}
```

## Tool capability toggles (v2)

`v2.ToolsV2` still only exposes built-in feature toggles:

```json
{
  "view_image": ["boolean", "null"],
  "web_search": ["boolean", "null"]
}
```

This is a **capability flag**, not a tool manifest.

## Implication

Dynamic tools can now be declared at thread start (`dynamicTools`) and routed over
`dynamic_tool_call_request` events, which enables client-side execution without
relying on model-authored XML tool-call blocks. Per-request tool manifests are
still not supported on v1 `sendUserTurn`/`sendUserMessage`.
