# Codex App-Server Tools vs Client Tool Manifests

## Summary

The Codex app-server still does **not** accept per-request tool manifests in JSON-RPC v1. It only enables:

- Built-in tools toggled in config (`web_search`, `view_image`)
- MCP tools loaded from configured MCP servers
- **Dynamic tools declared at v2 thread start** (`dynamicTools`)

As a result, `/v1/responses` requests that include `tools` are accepted by the proxy ingress but **cannot be forwarded** to the app-server as tool definitions for v1 requests. The JSON-RPC `SendUserTurnParams` only accepts `items` (text/image/localImage/skill), so client tool manifests are dropped before Codex core sees them. Dynamic tools in v2 provide a direct, structured alternative to the text/XML tool-call workaround.

## Evidence (Codex 0.92.0)

### JSON-RPC request payloads do not include tools (v1)

Exported schema (from the live CLI) confirms no `tools` field on the v1 request params:

```bash
node ./node_modules/@openai/codex/bin/codex.js app-server generate-json-schema --out /tmp/app-server-schema-0.92.0
```

- `SendUserTurnParams` only supports `conversation_id`, `items`, `cwd`, `approval_policy`, `sandbox_policy`, `model`, etc.
  - `/tmp/app-server-schema-0.92.0/codex_app_server_protocol.schemas.json`
- `SendUserMessageParams` only supports `conversationId` and `items`.
  - `/tmp/app-server-schema-0.92.0/codex_app_server_protocol.schemas.json`

### Dynamic tools are now supported at thread start (v2)

- `v2.ThreadStartParams` accepts `dynamicTools: DynamicToolSpec[]`.
  - `/tmp/app-server-schema-0.92.0/v2/ThreadStartParams.json`
- The server can request execution via `item/tool/call` with `DynamicToolCallParams`.
  - `/tmp/app-server-schema-0.92.0/ServerRequest.json`
- Event stream includes `dynamic_tool_call_request` items for client-side execution.
  - `/tmp/app-server-schema-0.92.0/EventMsg.json`
- Client responds with `DynamicToolCallResponse`.
  - `/tmp/app-server-schema-0.92.0/DynamicToolCallResponse.json`

### Tool configuration is config + MCP only (v1)

- `ToolsV2` only exposes `web_search` and `view_image` toggles.
  - `/tmp/app-server-schema-0.92.0/codex_app_server_protocol.schemas.json`

### MCP remains supported

- App-server exposes MCP server listing and status (`mcpServerStatus/list`), and reload (`config/mcpServer/reload`).
- Exported schema shows `v2.McpServerStatus.tools` as a map of tool name → `Tool` (name + JSON schemas).

## Implication for Obsidian tools

To make Obsidian tools available to Codex via the app-server, there are now two viable paths:

1. **Dynamic tools (v2)**: inject Obsidian tool specs in `dynamicTools` at thread start and handle `item/tool/call` requests + `dynamic_tool_call_request` events.
2. **MCP tools**: expose Obsidian tools via MCP and configure them in `CODEX_HOME/config.toml`.

Client-supplied `tools` in `/v1/responses` still cannot be used directly by app-server in v1 requests, but v2 dynamic tools can now carry the same schema without relying on fragile XML tool-call blocks.

## Options to support client tool manifests (proxy-level)

If we want to accept `tools` from `/v1/responses` and make them available to Codex:

1. **Use dynamic tools (v2)**: map client tool manifests to `dynamicTools` and wire `item/tool/call` to the client tool executor.
2. **Ephemeral MCP bridge**: spin up a local MCP server from the client manifest and register it in the app-server config for the session.
3. **Config layer injection**: use the v2 `config/write` APIs to write an overlay config that injects MCP tooling and reloads.

Dynamic tools are now the cleanest path for direct, structured tool calls.
