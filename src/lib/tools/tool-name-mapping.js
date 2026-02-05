import { nanoid } from "nanoid";

const DEFAULT_PREFIX = "client_";

// Names that collide with Codex internal tools / reserved tool namespaces.
// We treat this list as case-insensitive to avoid subtle collisions.
const RESERVED_NAMES = new Set(
  [
    "webSearch",
    "WebSearch",
    "web_search",
    "web_search_*",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "view_image",
    "shell",
    "exec_command",
    "apply_patch",
    "update_plan",
  ].map((name) => String(name).trim().toLowerCase())
);

const TOOL_NAME_SAFE_CHARS = /[^a-zA-Z0-9_-]/g;
const normalizeKey = (name) =>
  String(name ?? "")
    .trim()
    .toLowerCase();

const sanitizeToolName = (name) => {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(TOOL_NAME_SAFE_CHARS, "_");
};

const isReserved = (name) => {
  const key = normalizeKey(name);
  if (!key) return false;
  if (RESERVED_NAMES.has(key)) return true;
  // Also reserve internal tool prefixes (e.g., web_search_begin, exec_command_*)
  return (
    key.startsWith("web_search_") ||
    key.startsWith("exec_command_") ||
    key.startsWith("filechange_") ||
    key.startsWith("file_change_")
  );
};

const makeUniqueName = ({ base, used }) => {
  if (!used.has(base) && !isReserved(base)) return base;
  for (let i = 2; i <= 20; i += 1) {
    const candidate = `${base}_${i}`;
    if (!used.has(candidate) && !isReserved(candidate)) return candidate;
  }
  // Last resort: stable-ish unique suffix.
  for (let i = 0; i < 10; i += 1) {
    const candidate = `${base}_${nanoid(6)}`;
    if (!used.has(candidate) && !isReserved(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
};

/**
 * Rewrite dynamic tool names before sending them to the Codex app-server to avoid collisions with
 * internal tool names (e.g., "webSearch"). Returns rewritten tools plus a bidirectional mapping.
 */
export function rewriteDynamicToolsForAppServer(dynamicTools, { prefix = DEFAULT_PREFIX } = {}) {
  if (!Array.isArray(dynamicTools) || dynamicTools.length === 0) {
    return { dynamicTools, toolNameMap: null };
  }

  const used = new Set(
    dynamicTools.map((tool) => (tool && typeof tool === "object" ? tool.name : "")).filter(Boolean)
  );

  const toClient = new Map();
  const toWorker = new Map();
  let changed = false;

  const rewritten = dynamicTools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const originalName = String(tool.name ?? "").trim();
    if (!originalName) return tool;

    const safeOriginal = sanitizeToolName(originalName);
    const needsRewrite = isReserved(originalName);
    if (!needsRewrite && safeOriginal === originalName) return tool;

    const baseName = safeOriginal || `tool_${nanoid(6)}`;
    const workerName = makeUniqueName({ base: `${prefix}${baseName}`, used });

    used.add(workerName);
    toWorker.set(originalName, workerName);
    toClient.set(workerName, originalName);
    changed = true;

    return { ...tool, name: workerName };
  });

  if (!changed) return { dynamicTools: rewritten, toolNameMap: null };
  return { dynamicTools: rewritten, toolNameMap: { toClient, toWorker } };
}
