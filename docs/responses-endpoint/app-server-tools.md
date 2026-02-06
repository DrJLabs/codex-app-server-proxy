# Codex App-Server Tools and Client Tool Manifests

## Summary

Codex app-server (JSON-RPC v2) only accepts custom tool manifests at **thread start** (`thread/start.dynamicTools`). There is no per-turn/per-request tool manifest on `turn/start`.

Implications for this proxy:

- `/v1/responses` accepts OpenAI `tools[]` and forwards **function tools** to Codex as `dynamicTools` when the proxy creates a new thread.
- Once a thread exists, the Codex tool registry is fixed for that thread. Tool manifests cannot be changed without starting a new thread.
- When the client sends `function_call_output` items, the proxy resolves the originating thread from pending tool calls and reuses that thread's canonical tool manifest and instructions. `tools[]` included on the follow-up request are treated as advisory only (used for parsing/fallback) and are not allowed to mutate the active thread toolset.

## Evidence (Codex 0.92.0)

### Turn requests do not carry tool manifests

Exported schema (from the live CLI) shows:

- `TurnStartParams` supports `threadId`, `input`, `cwd`, `approvalPolicy`, `sandboxPolicy`, `model`, etc.
- `TurnStartParams` does **not** include `tools` or `dynamicTools`.

Generate locally:

```bash
codex app-server generate-json-schema --out /tmp/app-server-schema
```

### Thread start accepts dynamic tools

`ThreadStartParams` supports:

- `dynamicTools` (custom tool manifest)
- `baseInstructions` / `developerInstructions`
- `config` (per-thread feature/tool toggles)

### Built-in tool toggles are capability flags only

`ToolsV2` only exposes built-in capability toggles:

- `web_search`
- `view_image`

Custom tools are not declared through these toggles.

## Tool name collisions (internal vs dynamic)

Codex reserves internal tool namespaces (for example: `WebSearch` / `web_search_*`, `fileChange`, `commandExecution`, `view_image`, `exec_command_*`). If a client provides a dynamic tool with a colliding name (for example: `webSearch`), Codex may route a call to the internal tool instead of the dynamic tool.

When internal tools are disabled in this proxy, those internal tool attempts are blocked and surface as `internal_tools_disabled` failures.

To avoid collisions, the proxy rewrites reserved function-tool names **before** `thread/start` and stores a per-thread name map:

- Client tool name: `webSearch`
- App-server tool name: `client_webSearch`

At the HTTP API boundary, tool calls and tool outputs are mapped back to the original client name so clients do not need to change their tool list. Raw app-server captures will show the rewritten names.

## Internal tool disabling (two layers)

When `PROXY_DISABLE_INTERNAL_TOOLS_CONFIG=true` (default), the proxy disables internal tools at two layers:

- **Per-thread/turn config**: `turn.config.features.*` and `turn.config.tools.*` passed through JSON-RPC.
- **Worker launch config**: `codex app-server -c features.web_search_request=false -c features.shell_tool=false -c features.shell_snapshot=false -c features.unified_exec=false -c features.exec_policy=false -c features.apply_patch_freeform=false -c tools.web_search=false -c tools.view_image=false ...`.

When `PROXY_DISABLE_INTERNAL_TOOLS_PROMPT=true` (default), `/v1/responses` also injects explicit base instructions naming internal tool variants that must not be called.

## Optional internal tool shim (off by default)

If `PROXY_ENABLE_INTERNAL_TOOLS_SHIM=true`, the proxy can translate some internal tool notifications into dynamic tool call requests (for example: internal web search or file changes). This is off by default and is not required for normal OpenAI Responses clients.

## MCP tools (server-side)

MCP tools are configured in `CODEX_HOME/config.toml` and are executed inside the app-server. They are independent from client-provided dynamic tools declared via `dynamicTools`.

If you need server-side tools, configure MCP and reload the server, for example with `config/mcpServer/reload`.
