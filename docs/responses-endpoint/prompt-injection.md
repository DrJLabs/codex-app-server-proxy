# Responses instruction injection matrix

This document describes the instruction/config injected by the proxy for `POST /v1/responses`, with a focus on suppressing Codex internal tools and keeping client tool loops stable.

Scope:

- Endpoint: `/v1/responses`
- Injection sites:
  - `baseInstructions` / `developerInstructions`: `src/handlers/responses/stream.js`, `src/handlers/responses/nonstream.js`
  - App-server config toggles: `turn.config` (same handlers)
  - Worker launch defaults: `src/services/worker/supervisor.js`

## Goals

- Ensure the model uses only client-provided dynamic tools (function tools).
- Prevent Codex from calling its own internal tools (WebSearch, fileChange, exec, etc.), which this proxy blocks when internal tools are disabled.
- Avoid collisions between client tool names and Codex internal tool namespaces.

## Prompt injection: internal tools disabled

### `PROXY_DISABLE_INTERNAL_TOOLS_PROMPT=true` (default)

The proxy injects an explicit instruction block into Responses requests:

- `turn.baseInstructions` is set to `RESPONSES_INTERNAL_TOOLS_INSTRUCTION`.
- `turn.developerInstructions` is prefixed with the same instruction block.

Source:

- `src/lib/prompts/internal-tools-instructions.js` (`RESPONSES_INTERNAL_TOOLS_INSTRUCTION`)

This instruction names internal tool variants explicitly (for example: `WebSearch`, `webSearch`, `web_search_*`, `fileChange`, `commandExecution`, `exec_command_*`, `apply_patch`, `update_plan`) and tells the model to request only dynamic function tools.

### `PROXY_DISABLE_INTERNAL_TOOLS_PROMPT=false`

No internal-tools instruction is injected; only request-provided `instructions` and system/developer `input` items contribute to `developerInstructions`.

## App-server config injection: internal tools disabled

### `PROXY_DISABLE_INTERNAL_TOOLS_CONFIG=true` (default)

The proxy passes `turn.config` to disable internal tools at the app-server level for the thread/turn, including:

- `features.web_search_request=false`
- `features.shell_tool=false`
- `features.shell_snapshot=false`
- `features.exec_policy=false`
- `features.unified_exec=false`
- `features.streamable_shell=false`
- `features.view_image_tool=false`
- `features.apply_patch_freeform=false`
- `tools.web_search=false`
- `tools.view_image=false`

In addition, the worker supervisor launches the Codex app-server with conservative defaults that keep built-in tools off.

### `PROXY_DISABLE_INTERNAL_TOOLS_CONFIG=false`

No disablement config is injected. Codex internal tool calls may execute and will not be blocked by the proxy transport layer.

## Tool calling path (primary)

- **Primary:** Codex app-server dynamic tools (`thread/start.dynamicTools` + JSON-RPC `item/tool/call`).

## Tool name rewriting (collision avoidance)

Before `thread/start`, the proxy rewrites function-tool names that collide with internal tool namespaces and stores a per-thread bidirectional name map.

Example:

- Client tool name: `webSearch`
- App-server tool name: `client_webSearch`

Tool call requests and tool outputs are mapped back to the original client name at the HTTP boundary.

Implementation:

- `src/lib/tools/tool-name-mapping.js`
- `src/services/transport/index.js` (`rewriteDynamicToolsForAppServer`, per-thread `toolNameMap`)
