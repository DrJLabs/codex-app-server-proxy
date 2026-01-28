# App-server payloads (exact fields sent)

This document describes the **exact JSON-RPC payloads** the proxy sends to the Codex app-server
for each request type. It is derived from the current implementation in:
- `src/services/transport/index.js`
- `src/lib/json-rpc/schema.ts`
- `src/handlers/chat/*`
- `src/handlers/responses/*`

Values are omitted when undefined. All IDs and timestamps are representative.

## Transport flow summary

The proxy talks to app-server over JSON-RPC and sends **up to three calls** per request:
1) `newConversation` (always)
2) `sendUserTurn` (optional; gated by `PROXY_RESPONSES_SKIP_TURN`)
3) `sendUserMessage` (always)

The **chat** endpoint sends both `sendUserTurn` and `sendUserMessage`.
The **responses** endpoint sends `sendUserMessage` and may skip `sendUserTurn`.

## Common normalization rules

- `model` is normalized by `normalizeModel()`; `requested` model is used in responses payloads.
- `cwd` uses `PROXY_CODEX_WORKDIR` (default: `/tmp/codex-work`).
- `reasoning.effort` is resolved by `resolveResponsesReasoning()` and implied by model aliases
  (e.g., `gpt-5.2-codev-l` => `low`) when not explicitly supplied.
- Tools are converted into function tool schema objects and passed verbatim to app-server.
- When `PROXY_RESPONSES_OMIT_TOOL_MANIFEST=true`, tool definitions are omitted from
  app-server payloads even if provided by the client.

## JSON-RPC envelope (all methods)

Each call is sent as:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "sendUserMessage",
  "params": { /* method-specific payload */ }
}
```

## 1) newConversation (always)

Created by `buildNewConversationParams()` in `src/lib/json-rpc/schema.ts`.

```json
{
  "model": "gpt-5.2",
  "cwd": "/tmp/codex-work",
  "approvalPolicy": "never",
  "sandbox": "read-only",
  "developerInstructions": "Tool calling instructions: ...",
  "baseInstructions": null,
  "compactPrompt": null,
  "config": null,
  "includeApplyPatchTool": false
}
```

Notes:
- `model` is the **effective** model chosen after normalization.
- `approvalPolicy` and `sandbox` are derived from `PROXY_APPROVAL_POLICY` and
  `PROXY_SANDBOX_MODE`.
- `developerInstructions` include tool-calling rules and the tool schema list for the request.
- `includeApplyPatchTool` is controlled by `PROXY_INCLUDE_APPLY_PATCH_TOOL`.
- For `/v1/responses`, any `input` items with role `system` or `developer` are appended
  into `developerInstructions` (there is no ignore flag on the responses path).

### Full developer instructions (Obsidian tool-call requests)

When function tools are provided (the Obsidian tool set), the proxy builds
**exactly** the following developer instruction text and sends it in
`newConversation.developerInstructions` and, when present, `sendUserTurn.developerInstructions`.
Dynamic sections (tool list, schema summaries, examples) are injected verbatim
from the tool definitions.

```text
Tool calling instructions:
Only emit tool calls using <tool_call>...</tool_call>.
Format: <tool_call>{"name":"TOOL_NAME","arguments":"{...}"}</tool_call>
Inside <tool_call>...</tool_call>, output ONLY a JSON object with keys "name" and "arguments".
Always emit <tool_call> blocks exactly as shown; the client executes them.
Do NOT call internal tools directly (shell, apply_patch, web_search, view_image); only emit <tool_call>.
Read-only sandbox or approval restrictions do NOT prevent emitting <tool_call> output.
Use EXACT parameter names from the schema; do NOT invent or rename keys.
Do not add any extra characters before or after the JSON (no trailing ">", no code fences).
Use exactly one opening <tool_call> and one closing </tool_call> tag.
Output must be valid JSON. Do not add extra braces or trailing characters.
Do NOT wrap the JSON object in an array (no leading "[" or trailing "]").
Bad: <tool_call>[{"name":"tool","arguments":"{...}"}]</tool_call>
Never repeat the closing tag.
Example (exact): <tool_call>{"name":"webSearch","arguments":"{\"query\":\"example\",\"chatHistory\":[]}"}</tool_call>
The "arguments" field must be a JSON string.
If a tool has no parameters, use arguments "{}".
If no tool is needed, respond with plain text.

Tool choice is none: never emit <tool_call>.         (only if tool_choice = "none")
Tool choice is required: you MUST emit at least one <tool_call>.  (only if tool_choice = "required")
Tool choice is forced: you MUST call "TOOL_NAME".    (only if tool_choice names a tool)
Strict tools: toolA, toolB. Arguments MUST conform exactly to schema.  (only if strict tools exist)

Available tools (schema):
- toolName: { ... full JSON schema ... }
- toolName2: { ... full JSON schema ... }

Per-tool guidance and examples (schema-conformant):
Tool: toolName
Description: tool description (if present)
Parameters:
- <lines produced by summarizeSchemaParameters(...)>
Example tool_call:
<tool_call>{"name":"toolName","arguments":"{...example args...}"}</tool_call>

Tool: toolName2
Description: tool description (if present)
Parameters:
- <lines produced by summarizeSchemaParameters(...)>
Example tool_call:
<tool_call>{"name":"toolName2","arguments":"{...example args...}"}</tool_call>
```

Notes:
- The **Available tools (schema)** list is derived from each tool's JSON schema as provided
  by the client. The schema is included verbatim (no truncation before logging).
- **Per-tool guidance** is computed with `summarizeSchemaParameters()` and
  `exampleForSchema()` from `src/handlers/responses/native/request.js`.
- If `body.instructions` is provided, it is appended as an additional developer instruction
  block after the tool injection text.

## 2) sendUserTurn (chat + optional in responses)

Built by `buildSendUserTurnParams()` in `src/lib/json-rpc/schema.ts` and sent by
`JsonRpcTransport.#sendUserTurn()` in `src/services/transport/index.js`.

```json
{
  "conversationId": "019bfd08-57c5-71f0-b8ef-c44ff460ff21",
  "items": [
    { "type": "text", "data": { "text": "[user] ...original prompt..." } }
  ],
  "cwd": "/tmp/codex-work",
  "approvalPolicy": "never",
  "sandboxPolicy": { "type": "read-only" },
  "model": "gpt-5.2-codev-l",
  "summary": "auto",
  "effort": "low",
  "choiceCount": 1,
  "choice_count": 1,
  "tools": {
    "definitions": [
      { "type": "function", "function": { "name": "getFileTree", "parameters": { /* schema */ } } }
    ]
  },
  "outputSchema": null,
  "output_schema": null
}
```

Notes:
- `effort` is included when resolved; for alias models it is implied.
- `tools` is included when tool definitions exist, unless
  `PROXY_RESPONSES_OMIT_TOOL_MANIFEST=true`.
- `choiceCount` and `choice_count` are both set when `n` is provided.
- The `items` list is always normalized (non-empty).
- **Responses:** this call is skipped entirely when `PROXY_RESPONSES_SKIP_TURN=true`.

## 3) sendUserMessage (always)

Built by `buildSendUserMessageParams()` in `src/lib/json-rpc/schema.ts` and sent by
`JsonRpcTransport.sendUserMessage()` in `src/services/transport/index.js`.

```json
{
  "conversationId": "019bfd08-57c5-71f0-b8ef-c44ff460ff21",
  "items": [
    { "type": "text", "data": { "text": "[user] ...original prompt..." } }
  ],
  "includeUsage": false,
  "include_usage": false,
  "stream": true,
  "temperature": null,
  "topP": null,
  "top_p": null,
  "maxOutputTokens": 65000,
  "max_output_tokens": 65000,
  "tools": {
    "definitions": [
      { "type": "function", "function": { "name": "getFileTree", "parameters": { /* schema */ } } }
    ]
  },
  "responseFormat": null,
  "response_format": null,
  "reasoning": { "effort": "low" },
  "finalOutputJsonSchema": null,
  "final_output_json_schema": null
}
```

Notes:
- `reasoning` is injected on responses requests when effort resolves (explicit or implied).
- `tools` is omitted entirely when `PROXY_RESPONSES_OMIT_TOOL_MANIFEST=true` (even if the
  client supplied tools).
- `stream` is derived from the incoming request and defaults to proxy settings.

## Response vs chat differences

### Responses endpoint
- Always uses `sendUserMessage`.
- Uses `PROXY_RESPONSES_SKIP_TURN` to decide whether to send `sendUserTurn`.
- Injects `reasoning.effort` into the **message** payload.
- Uses **model alias** for `requestedModel`, but sends **effective model** to app-server.
- `system`/`developer` input items are included in `developerInstructions`.

### Chat endpoint
- Uses `sendUserTurn` + `sendUserMessage`.
- Implied reasoning effort is set on the **turn** (when applicable).
- No `reasoning` object is injected into `sendUserMessage`.
- System/developer messages are only sent as `baseInstructions` when
  `PROXY_IGNORE_CLIENT_SYSTEM_PROMPT=false` (default is true, so they are dropped).

## Tool schema payloads

Tool definitions are passed as JSON Schema under:

```json
{
  "tools": {
    "definitions": [
      {
        "type": "function",
        "function": {
          "name": "toolName",
          "description": "Tool description",
          "parameters": { /* full JSON schema */ }
        }
      }
    ]
  }
}
```

This schema list is also embedded in `developerInstructions` for app-server alignment.

## How to confirm live payloads

Enable proto logging and inspect `/home/node/.codex/proto-events.ndjson` for:
- `backend_submission` events (`method: newConversation` / `sendUserMessage`)
- `backend_io` events for `sendUserTurn` and `sendUserMessage`

These logs show the **actual payloads** sent at runtime (often truncated for size).
