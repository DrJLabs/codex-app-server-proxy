# Codex App-Server Tools vs Client Tool Manifests

## Summary

The Codex app-server does **not** accept per-request tool manifests in JSON-RPC. It only enables:

- Built-in tools toggled in config (`web_search`, `view_image`)
- MCP tools loaded from configured MCP servers

As a result, `/v1/responses` requests that include `tools` are accepted by the proxy ingress but **cannot be forwarded** to the app-server as per-turn tool definitions. Tool manifests are only accepted at thread start via `thread/start.dynamicTools`; `turn/start` accepts only `input` and execution controls.

## Evidence (Codex 0.89.0)

### JSON-RPC request payloads do not include tools

Exported schema (from the live CLI) confirms no `tools` field on the request params:

```bash
codex app-server generate-json-schema --out /tmp/app-server-schema
```

- `TurnStartParams` only supports `threadId`, `input`, `cwd`, `approvalPolicy`, `sandboxPolicy`, `model`, etc.
  - `/tmp/app-server-schema/codex_app_server_protocol.schemas.json` (exported schema)
  - `/external/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`
- `ThreadStartParams` supports `dynamicTools` (tool manifests), `developerInstructions`, and conversation-scoped config.
  - `/tmp/app-server-schema/codex_app_server_protocol.schemas.json` (exported schema)

### Tool configuration is config + MCP only

- `ToolsV2` only exposes `web_search` and `view_image` toggles.
  - `/tmp/app-server-schema/codex_app_server_protocol.schemas.json` (exported schema)
- Core tool registry is built from config and MCP tools (converted into OpenAI tool specs).
  - `/external/codex/codex-rs/core/src/tools/spec.rs`

### MCP is the only dynamic tool source

- App-server exposes MCP server listing and status (`mcpServerStatus/list`), and reload (`config/mcpServer/reload`).
  - `/external/codex/codex-rs/app-server/README.md`
- Exported schema shows `v2.McpServerStatus.tools` as a map of tool name → `Tool` (name + JSON schemas).
  - `/tmp/app-server-schema/codex_app_server_protocol.schemas.json`

## How this fits into the proxy

The proxy currently does two distinct things:

1. Accepts OpenAI-style `/v1/responses` requests (including `tools`).
2. Normalizes/flat-flattens input and forwards `items` to the Codex app-server via JSON-RPC.

Because JSON-RPC does **not** carry tool manifests, tool definitions in the HTTP request cannot reach Codex core. This explains why the client sees “no tools available” even though ingress logs show the tools in the original request.

## Internal tool shim (proxy behavior)

When `PROXY_DISABLE_INTERNAL_TOOLS=true`, the proxy blocks built-in Codex tools. To avoid dead ends in client flows, the proxy shims some internal tool notifications into dynamic tool calls:

- Internal `webSearch` -> dynamic tool `webSearch` (forces `chatHistory: []`).
- Internal `fileChange` -> dynamic tool `writeToFile` or `replaceInFile` (based on `diff`).

If a follow-up request sends a tool output that does not match a pending tool call, the proxy appends a `[function_call_output ...]` text item to the next turn so the model can continue.

This shim requires those client tool names to be present in the dynamic tool manifest; other internal tool types (e.g., `commandExecution`) still fail when internal tools are disabled.

## Implication for Obsidian tools

To make Obsidian tools available to Codex via the app-server, they must be exposed **as MCP tools** (or another Codex-native tool source) and configured in `CODEX_HOME/config.toml`. Client-supplied `tools` in `/v1/responses` cannot be used directly by app-server today.

Example MCP config pattern (from Codex docs):

```toml
# config.toml
[mcp_servers.obsidian]
command = "codex-stdio-to-uds"
args = ["/tmp/mcp.sock"]
```

After updating config, call `config/mcpServer/reload` (or restart the app-server) and verify tools via `mcpServerStatus/list`.

## Options to support client tool manifests (proxy-level)

If we want to accept `tools` from `/v1/responses` and make them available to Codex:

1. **Protocol extension**: Add a JSON-RPC method or parameter that allows sending a tool manifest (and teach app-server/core to ingest it).
2. **Ephemeral MCP bridge**: Spin up a local MCP server from the client manifest and register it in the app-server config for the session.
3. **Config layer injection**: Use the v2 `config/write` APIs to write an overlay config that injects MCP tooling and reloads.

Until one of the above exists, the proxy can only use built-in + MCP tools configured outside the request.
