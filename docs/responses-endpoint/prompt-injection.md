# Responses prompt injection matrix

This document describes the exact tool-call prompt text injected by the proxy for `/v1/responses` and how it varies by tool configuration and tool choice.

Scope:
- Endpoint: `/v1/responses`
- Injection site: `src/handlers/responses/native/request.js`
- Injection channel: `developerInstructions` passed to app-server on `thread/start`
- Applies only when function tools are present

## Injection trigger

The proxy injects tool-call instructions only when the request includes at least one function tool. Function tools are detected from `tools[]` entries with `type: "function"`, using either the Responses shape (`name` at the top level) or the Chat Completions shape (`function.name`).

If no function tools are present, **no tool-call prompt is injected**.

## Base injected text (always included when function tools exist)

When function tools exist, the following lines are injected verbatim into `developerInstructions`:

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
```

After the base block, the proxy adds scenario-specific lines and the tool manifest (see below).

## Flow (request → injection → tools)

This section describes how tool prompt injection relates to the tool definitions and how both flow through the request lifecycle:

1) **Ingress normalization (`/v1/responses`)**
   - `normalizeResponsesRequest` parses `tools` and `tool_choice` from the request.
   - Only function tools (`type: "function"`) are used to build the injection block.
   - Non-function tools are passed through but do **not** trigger tool-call injection text.

2) **Injection generation (tool schema → developerInstructions)**
   - The injection block is derived exclusively from the function tool list in the request:
     - Base instructions
     - Tool choice constraint line (if any)
     - Tool schema manifest
     - Per-tool examples
   - The injection **does not modify** the tool list; it is advisory text only.
   - Ordering inside `developerInstructions`:
     1. tool injection block (when tools exist)
     2. top-level `instructions`
     3. `input` items with role `system` or `developer`

3) **Forwarding to app-server**
   - The normalized tool list is forwarded to app-server as `thread/start.dynamicTools`.
   - The tool injection text is sent via `developerInstructions`, separate from user transcript.

4) **Streaming parser configuration**
   - The stream adapter uses the same request tool list to configure parsing:
     - `allowedTools` = function tool names
     - `strictTools`/`toolSchemas` = strict schema enforcement where requested
     - If `tool_choice` is `none`, tool parsing is disabled.

In short: **tools define both the model-facing injection text and the parser/runtime tool constraints**, but the injection text itself is only a behavioral hint; tool execution depends on parsed `<tool_call>` output and the tool registry built from the request.

## Tool manifest

The injection ends with a tool manifest, one line per function tool:

```text
Available tools (schema):
- tool_name_here: {"type":"object", ...}
- another_tool: {"type":"object", ...}
```

The schema JSON is produced by `JSON.stringify(tool.parameters)`.

If any tool has `strict: true`, the proxy inserts the following line before the manifest:

```text
Strict tools: toolA, toolB. Arguments MUST conform exactly to schema.
```

## Per-tool guidance and examples

After the tool manifest, the proxy appends a per-tool guidance block with a schema-based example for each tool:

```text
Per-tool guidance and examples (schema-conformant):
Tool: tool_name_here
Description: ...
Parameters:
- paramA (required, string): description
- paramB (optional, array): description
Example tool_call:
<tool_call>{"name":"tool_name_here","arguments":"{\"paramA\":\"example\"}"}</tool_call>
```

Notes:
- The `Description:` line is included only when the tool provides one.
- `Parameters:` is derived from the tool's JSON schema (`properties`, `required`, and `type`).
- The example `arguments` payload is generated from the schema (`default`, `example`, `examples`, `enum`, or type fallbacks).

## Tool choice variants

The proxy varies the injected prompt based on the effective `tool_choice`:

### 1) No tool call requested (no tools)

- Condition: `tools` omitted or contains no function tools.
- Injection: **none** (no prompt added).

### 2) No tool call requested (tool_choice: "none")

When `tool_choice` is explicitly set to `"none"`, the following line is inserted before the manifest:

```text
Tool choice is none: never emit <tool_call>.
```

### 3) tool_choice: "required"

When `tool_choice` is `"required"`, the following line is inserted before the manifest:

```text
Tool choice is required: you MUST emit at least one <tool_call>.
```

### 4) Forced tool choice (explicit)

When `tool_choice` is a function selector (Responses or Chat Completions format), the following line is inserted before the manifest:

```text
Tool choice is forced: you MUST call "tool_name".
```

### 5) Default tool choice when omitted

When `tool_choice` is omitted, the proxy defaults to `"auto"` whenever function tools are present.

## Ordering

`developerInstructions` is built from (in order):
1. tool injection block (when tools exist)
2. `instructions` (top-level request field)
3. any `input` items with role `system` or `developer`

## Example injection (tools present, tool_choice omitted)

Given:
- `tools` includes `getFileTree` and `writeToFile`
- no explicit `tool_choice`
- user input: "Create a new note named [[Example]]."

Injected developer prompt (excerpt):

```text
Tool calling instructions:
Only emit tool calls using <tool_call>...</tool_call>.
Format: <tool_call>{"name":"TOOL_NAME","arguments":"{...}"}</tool_call>
Inside <tool_call>...</tool_call>, output ONLY a JSON object with keys "name" and "arguments".
...
If a tool has no parameters, use arguments "{}".
If no tool is needed, respond with plain text.
Available tools (schema):
- getFileTree: {"type":"object",...}
- writeToFile: {"type":"object",...}
Per-tool guidance and examples (schema-conformant):
Tool: getFileTree
Parameters:
- (no parameters)
Example tool_call:
<tool_call>{"name":"getFileTree","arguments":"{}"}</tool_call>
Tool: writeToFile
Parameters:
- path (required, string): ...
- content (required, string): ...
Example tool_call:
<tool_call>{"name":"writeToFile","arguments":"{\"path\":\"example.md\",\"content\":\"example\"}"}</tool_call>
```

## Why tool calls can still be missing

Even with tool instructions, models may ignore tool use unless `tool_choice` is set to `"required"` or a specific tool. For deterministic tool execution, set `tool_choice` explicitly in the request.
