# Proposed Obsidian prompt changes (exact deltas)

This document specifies **exact** changes to the Obsidian system/developer prompt
before it is merged into `developerInstructions` for `/v1/responses`.
Goal: remove tool‑format conflicts that cause long deliberation, without shortening
the overall prompt or altering non‑tool content.

## Current behavior (baseline)

In `src/handlers/responses/native/request.js`, any `input` items with role
`system` or `developer` are appended to `developerInstructions` **verbatim**
after the tool‑call guidance injection.

## Proposed behavior (exact changes)

Before appending any `system`/`developer` content, apply a deterministic filter
that removes **only tool‑related guidance**. Everything else remains unchanged.

### 1) Line‑level removal (case‑insensitive)

Remove any line that matches **any** of the patterns below:

```
\btool_call\b
<tool_call
</tool_call
\btool\s+call\b
\buse_tool\b
\btool\s+result\b
\btool\s+output\b
\bfunction_call\b
\bfunction\s+call\b
\bfunctions\.
\btool\s+schema\b
\btool\s+manifest\b
\btool\s+choice\b
\btool\s+definitions?\b
\bavailable\s+tools\b
\btools?\s*:\b
\bupdate_plan\b
\bagent\s+mode\b
\bmcp\b
\bapply_patch\b
\bshell_tool\b
\bunified_exec\b
\bweb_search\b
\bview_image\b
```

### 2) Block removal (tool sections)

If a line matches any of these headers (case‑insensitive), remove that line
**and all subsequent lines until the next blank line**:

```
tools:
tooling:
tool instructions:
tool calling instructions:
available tools:
tool schema:
tool manifest:
```

### 3) Code‑block removal (tool syntax)

If a fenced code block (```) contains any of the tool patterns above,
drop the entire code block.

### 4) No other changes

If none of the rules apply, preserve the line exactly as provided.

## Example (before → after)

**Before**

```
You are an Obsidian assistant. Follow the user request.

Tool calling instructions:
Only emit tool calls using <tool_call>...</tool_call>.
Available tools:
- getFileTree
- readNote

If you need to look things up, use web_search.
Summarize the result for the user.
```

**After**

```
You are an Obsidian assistant. Follow the user request.

Summarize the result for the user.
```

## Implementation location (planned)

Add a helper in `src/handlers/responses/native/request.js`:

- `sanitizeDeveloperInstructionForObsidian(text: string): string`

Apply it inside `appendDeveloperContent()` before `pushDeveloperInstruction(...)`.

This affects **only** system/developer input items (Obsidian prompt), not
the tool‑call guidance injected by the proxy itself.
