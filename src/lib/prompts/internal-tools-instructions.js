// Saved for potential reuse; not injected by default.
export const CHAT_INTERNAL_TOOLS_INSTRUCTION =
  "Never use internal tools (shell/exec_command/apply_patch/update_plan/view_image). Request only dynamic tool calls provided by the client.";

// Saved for potential reuse; not injected by default.
export const RESPONSES_INTERNAL_TOOLS_INSTRUCTION =
  "Never use internal tools (web_search, view_image, fileChange, commandExecution, mcpToolCall, shell, exec_command, apply_patch, update_plan). Use client tools like writeToFile/replaceInFile for file operations. Request only dynamic tool calls provided by the client.";
