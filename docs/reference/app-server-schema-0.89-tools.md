# App-server schema (Codex 0.89.0) — tools findings

## How the schema was obtained

```
codex app-server generate-json-schema --out /tmp/app-server-schema
```

Primary bundle:
- `/tmp/app-server-schema/codex_app_server_protocol.schemas.json`

## Request params (no tool manifest fields)

From the generated schema:

- `SendUserTurnParams.properties` = `approvalPolicy`, `conversationId`, `cwd`, `effort`, `items`, `model`, `outputSchema`, `sandboxPolicy`, `summary`
- `SendUserMessageParams.properties` = `conversationId`, `items`

There is **no `tools` field** on either request type in the exported schema.

## v2 thread start params (no tool manifest fields)

`v2.ThreadStartParams.properties` = `approvalPolicy`, `baseInstructions`, `config`, `cwd`, `developerInstructions`, `experimentalRawEvents`, `model`, `modelProvider`, `sandbox`

There is **no `tools` field** on v2 thread start parameters.

## Tool capability toggles (v2)

`v2.ToolsV2` only exposes built-in feature toggles:

```json
{
  "view_image": ["boolean", "null"],
  "web_search": ["boolean", "null"]
}
```

This is a **capability flag**, not a tool manifest.

## Tool definitions (v2)

The schema includes a `v2.Tool` definition (name + JSON schema) but it is **not referenced by request params**. It appears under MCP status/config responses instead.

Key fields:
- `name` (string, required)
- `inputSchema` (JSON schema object, required)
- `outputSchema` (optional JSON schema)
- `description`, `title`, `annotations`

## Where tool definitions appear in v2

- `v2.McpServerStatus.tools`: map of tool name → `v2.Tool`
- `v2.Config.tools`: `v2.ToolsV2` capability toggles

This indicates tools are sourced from MCP server configuration and status, not from per-request tool manifests.

## Implication for the proxy

The proxy can accept OpenAI-style tool manifests, but the app-server schema does not accept them on `sendUserTurn` or `sendUserMessage`. Tool availability must be configured via MCP servers or app-server config, not via the JSON-RPC request payload.
