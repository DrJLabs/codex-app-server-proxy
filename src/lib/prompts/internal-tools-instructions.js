// Saved for potential reuse; not injected by default.
export const CHAT_INTERNAL_TOOLS_INSTRUCTION = [
  "INTERNAL TOOLS ARE DISABLED.",
  "Never use internal tools (shell/exec_command/apply_patch/update_plan/view_image).",
  "Request only dynamic tool calls provided by the client.",
].join("\n");

// Guidance for /v1/responses when internal tool execution is blocked by the proxy.
export const RESPONSES_INTERNAL_TOOLS_INSTRUCTION = [
  "INTERNAL TOOLS ARE DISABLED.",
  "Do NOT call internal tools, including (exact names/variants):",
  "- WebSearch, webSearch, web_search, web_search_*",
  "- view_image",
  "- fileChange, item/fileChange, fileChange_*, file_change_*",
  "- commandExecution, item/commandExecution, exec_command_*",
  "- mcpToolCall",
  "- shell, exec_command, apply_patch, update_plan",
  "Instead, request ONLY dynamic tool calls provided by the client (function tools).",
  "For file operations, use client tools like writeToFile/replaceInFile (not fileChange).",
  "For web search, use a client-provided function tool from the tool list (not internal WebSearch/webSearch).",
].join("\n");
