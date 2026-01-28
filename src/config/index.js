/* eslint-disable security/detect-object-injection */
import os from "node:os";
import path from "node:path";
const str = (name, def) => String(process.env[name] ?? def);
const num = (name, def) => {
  const raw = process.env[name];
  const val = Number(raw);
  return Number.isNaN(val) ? Number(def) : val;
};
const resolveTruncateMs = () => {
  const modern = process.env.PROXY_NONSTREAM_TRUNCATE_AFTER_MS;
  if (modern !== undefined && modern !== "") {
    const parsedModern = Number(modern);
    if (!Number.isNaN(parsedModern)) return parsedModern;
  }

  return 0;
};
const boolishTrue = (value) => /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
const boolishFalse = (value) => /^(0|false|no|off)$/i.test(String(value ?? "").trim());
const bool = (name, def) => boolishTrue(process.env[name] ?? def);

const resolveApprovalPolicy = () => {
  const raw = process.env.PROXY_APPROVAL_POLICY ?? process.env.CODEX_APPROVAL_POLICY ?? "never";
  const normalized = String(raw).trim().toLowerCase();
  return normalized || "never";
};

const resolveStopAfterToolsGraceMs = () => {
  const raw = process.env.PROXY_STOP_AFTER_TOOLS_GRACE_MS;
  if (raw === undefined || raw === null || raw === "") return 300;
  const val = Number(raw);
  return Number.isNaN(val) ? 300 : val;
};

const resolveIgnoreClientSystemPrompt = () => bool("PROXY_IGNORE_CLIENT_SYSTEM_PROMPT", "true");

const resolveTitleGenIntercept = () =>
  /^(1|true|yes)$/i.test(String(process.env.PROXY_TITLE_GEN_INTERCEPT ?? "true"));

const resolveToolBlockDelimiter = () => {
  const raw = process.env.PROXY_TOOL_BLOCK_DELIMITER;
  if (raw === undefined || raw === null || raw === "") return "";
  if (boolishFalse(raw)) return "";
  if (boolishTrue(raw)) return "\n\n";
  return String(raw).replace(/\\n/g, "\n");
};

const resolveTrustProxy = () => {
  const raw = process.env.PROXY_TRUST_PROXY;
  const trimmed = raw === undefined || raw === null ? "loopback" : String(raw).trim();
  if (!trimmed) return false;
  if (boolishFalse(trimmed)) return false;
  if (boolishTrue(trimmed)) return true;
  return trimmed;
};

const resolveAuthLoginUrlMode = () => {
  const raw = process.env.PROXY_AUTH_LOGIN_URL_MODE ?? "";
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return "";
  return ["code", "message", "code+message"].includes(normalized) ? normalized : "";
};

export const config = {
  PORT: num("PORT", 11435),
  PROXY_HOST: str("PROXY_HOST", "0.0.0.0"),
  PROXY_TRUST_PROXY: resolveTrustProxy(),
  API_KEY: str("PROXY_API_KEY", "codex-local-secret"),
  PROXY_ENV: str("PROXY_ENV", ""),
  PROTECT_MODELS: bool("PROXY_PROTECT_MODELS", "false"),
  CODEX_MODEL: str("CODEX_MODEL", "gpt-5.2"),
  PROXY_TITLE_SUMMARY_EXEC_MODEL: str("PROXY_TITLE_SUMMARY_EXEC_MODEL", "gpt-5.2"),
  // prettier-ignore
  PROXY_TITLE_SUMMARY_EXEC_REASONING_EFFORT: str("PROXY_TITLE_SUMMARY_EXEC_REASONING_EFFORT", "low"),
  CODEX_BIN: str("CODEX_BIN", "codex"),
  CODEX_HOME: str("CODEX_HOME", path.join(process.cwd(), ".codex-api")),
  PROXY_SANDBOX_MODE: str("PROXY_SANDBOX_MODE", "read-only").toLowerCase(),
  PROXY_CODEX_WORKDIR: str("PROXY_CODEX_WORKDIR", path.join(os.tmpdir(), "codex-work")),
  PROXY_USE_APP_SERVER: bool("PROXY_USE_APP_SERVER", "true"),
  PROXY_ENABLE_RESPONSES: bool("PROXY_ENABLE_RESPONSES", "true"),
  CODEX_FORCE_PROVIDER: str("CODEX_FORCE_PROVIDER", ""),
  // Streaming & tools controls
  PROXY_DEFAULT_STREAM: bool("PROXY_DEFAULT_STREAM", "false"),
  PROXY_SSE_KEEPALIVE_MS: num("PROXY_SSE_KEEPALIVE_MS", 15000),
  PROXY_ENABLE_PARALLEL_TOOL_CALLS: bool("PROXY_ENABLE_PARALLEL_TOOL_CALLS", "false"),
  PROXY_STOP_AFTER_TOOLS: bool("PROXY_STOP_AFTER_TOOLS", ""),
  PROXY_STOP_AFTER_TOOLS_MODE: str("PROXY_STOP_AFTER_TOOLS_MODE", "burst").toLowerCase(),
  PROXY_STOP_AFTER_TOOLS_GRACE_MS: resolveStopAfterToolsGraceMs(),
  PROXY_SUPPRESS_TAIL_AFTER_TOOLS: bool("PROXY_SUPPRESS_TAIL_AFTER_TOOLS", ""),
  PROXY_TOOL_BLOCK_MAX: num("PROXY_TOOL_BLOCK_MAX", 0),
  PROXY_TOOL_BLOCK_DEDUP: bool("PROXY_TOOL_BLOCK_DEDUP", "false"),
  PROXY_TOOL_BLOCK_DELIMITER: resolveToolBlockDelimiter(),
  PROXY_DISABLE_SHELL_TOOL: bool("PROXY_DISABLE_SHELL_TOOL", "true"),
  PROXY_DISABLE_UNIFIED_EXEC: bool("PROXY_DISABLE_UNIFIED_EXEC", "true"),
  PROXY_INCLUDE_APPLY_PATCH_TOOL: bool("PROXY_INCLUDE_APPLY_PATCH_TOOL", "false"),
  PROXY_RESPONSES_OMIT_TOOL_MANIFEST: bool("PROXY_RESPONSES_OMIT_TOOL_MANIFEST", "false"),
  PROXY_RESPONSES_XML_TOOL_CALLS: bool("PROXY_RESPONSES_XML_TOOL_CALLS", "false"),
  PROXY_RESPONSES_STRIP_OBSIDIAN_SYSTEM_PROMPT: bool(
    "PROXY_RESPONSES_STRIP_OBSIDIAN_SYSTEM_PROMPT",
    "false"
  ),
  PROXY_RESPONSES_INJECT_TOOL_SCHEMA: bool("PROXY_RESPONSES_INJECT_TOOL_SCHEMA", "true"),
  PROXY_RESPONSES_IDEMPOTENCY: bool("PROXY_RESPONSES_IDEMPOTENCY", "false"),
  PROXY_RESPONSES_IDEMPOTENCY_TTL_MS: num("PROXY_RESPONSES_IDEMPOTENCY_TTL_MS", 120000),
  PROXY_RESPONSES_IDEMPOTENCY_FINGERPRINT: bool("PROXY_RESPONSES_IDEMPOTENCY_FINGERPRINT", "false"),
  PROXY_OUTPUT_MODE: str("PROXY_OUTPUT_MODE", "obsidian-xml").toLowerCase(),
  PROXY_RESPONSES_OUTPUT_MODE: str("PROXY_RESPONSES_OUTPUT_MODE", "openai-json").toLowerCase(),
  PROXY_RESPONSES_SKIP_TURN: bool("PROXY_RESPONSES_SKIP_TURN", "false"),
  PROXY_RESPONSES_DEFAULT_MAX_TOKENS: num("PROXY_RESPONSES_DEFAULT_MAX_TOKENS", 0),
  PROXY_COPILOT_AUTO_DETECT: bool("PROXY_COPILOT_AUTO_DETECT", "false"),
  PROXY_APPROVAL_POLICY: resolveApprovalPolicy(),
  PROXY_AUTH_LOGIN_URL: bool("PROXY_AUTH_LOGIN_URL", "false"),
  PROXY_AUTH_LOGIN_URL_MODE: resolveAuthLoginUrlMode(),
  PROXY_IGNORE_CLIENT_SYSTEM_PROMPT: resolveIgnoreClientSystemPrompt(),
  PROXY_TITLE_GEN_INTERCEPT: resolveTitleGenIntercept(),
  // Timeouts
  PROXY_TIMEOUT_MS: num("PROXY_TIMEOUT_MS", 300000),
  PROXY_IDLE_TIMEOUT_MS: num("PROXY_IDLE_TIMEOUT_MS", 15000),
  PROXY_STREAM_IDLE_TIMEOUT_MS: num("PROXY_STREAM_IDLE_TIMEOUT_MS", 300000),
  // Misc
  PROXY_ENABLE_CORS: str("PROXY_ENABLE_CORS", "true"),
  PROXY_CORS_ALLOWED_ORIGINS: str("PROXY_CORS_ALLOWED_ORIGINS", "*"),
  PROXY_LOG_CORS_ORIGIN: bool("PROXY_LOG_CORS_ORIGIN", "false"),
  PROXY_ENABLE_METRICS: bool("PROXY_ENABLE_METRICS", "false"),
  PROXY_METRICS_ALLOW_UNAUTH: bool("PROXY_METRICS_ALLOW_UNAUTH", "false"),
  PROXY_METRICS_ALLOW_LOOPBACK: bool("PROXY_METRICS_ALLOW_LOOPBACK", "true"),
  PROXY_METRICS_TOKEN: str("PROXY_METRICS_TOKEN", ""),
  PROXY_MAINTENANCE_MODE: bool("PROXY_MAINTENANCE_MODE", "false"),
  PROXY_KILL_ON_DISCONNECT: str("PROXY_KILL_ON_DISCONNECT", "false"),
  PROXY_SANITIZE_METADATA: bool("PROXY_SANITIZE_METADATA", "false"),
  PROXY_CAPTURE_CHAT_TRANSCRIPTS: bool("PROXY_CAPTURE_CHAT_TRANSCRIPTS", "false"),
  PROXY_CAPTURE_CHAT_DIR: str(
    "PROXY_CAPTURE_CHAT_DIR",
    path.join(process.cwd(), "test-results", "chat-copilot", "raw")
  ),
  PROXY_CAPTURE_CHAT_RAW_TRANSCRIPTS: bool("PROXY_CAPTURE_CHAT_RAW_TRANSCRIPTS", "false"),
  PROXY_CAPTURE_CHAT_RAW_DIR: str(
    "PROXY_CAPTURE_CHAT_RAW_DIR",
    path.join(process.cwd(), "test-results", "chat-copilot", "raw-unredacted")
  ),
  PROXY_CAPTURE_RESPONSES_TRANSCRIPTS: bool("PROXY_CAPTURE_RESPONSES_TRANSCRIPTS", "false"),
  PROXY_CAPTURE_RESPONSES_DIR: str(
    "PROXY_CAPTURE_RESPONSES_DIR",
    path.join(process.cwd(), "test-results", "responses-copilot", "raw")
  ),
  PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS: bool("PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS", "false"),
  PROXY_CAPTURE_RESPONSES_RAW_DIR: str(
    "PROXY_CAPTURE_RESPONSES_RAW_DIR",
    path.join(process.cwd(), "test-results", "responses-copilot", "raw-unredacted")
  ),
  // Ingress safety: guardrails for client-provided memory/tool transcripts
  PROXY_INGRESS_GUARDRAIL: bool("PROXY_INGRESS_GUARDRAIL", "true"),
  // Worker supervisor
  WORKER_BACKOFF_INITIAL_MS: num("WORKER_BACKOFF_INITIAL_MS", 500),
  WORKER_BACKOFF_MAX_MS: num("WORKER_BACKOFF_MAX_MS", 5000),
  WORKER_RESTART_MAX: num("WORKER_RESTART_MAX", 25),
  WORKER_STARTUP_TIMEOUT_MS: num("WORKER_STARTUP_TIMEOUT_MS", 8000),
  WORKER_SHUTDOWN_GRACE_MS: num("WORKER_SHUTDOWN_GRACE_MS", 5000),
  WORKER_MAX_CONCURRENCY: num("WORKER_MAX_CONCURRENCY", 4),
  WORKER_REQUEST_TIMEOUT_MS: num("WORKER_REQUEST_TIMEOUT_MS", 120000),
  WORKER_HANDSHAKE_TIMEOUT_MS: num("WORKER_HANDSHAKE_TIMEOUT_MS", 15000),
  // Security
  PROXY_RATE_LIMIT_ENABLED: bool("PROXY_RATE_LIMIT_ENABLED", "false"),
  PROXY_RATE_LIMIT_WINDOW_MS: num("PROXY_RATE_LIMIT_WINDOW_MS", 60_000),
  PROXY_RATE_LIMIT_MAX: num("PROXY_RATE_LIMIT_MAX", 60),
  PROXY_SSE_MAX_CONCURRENCY: num("PROXY_SSE_MAX_CONCURRENCY", 4),
  PROXY_TEST_ENDPOINTS: bool("PROXY_TEST_ENDPOINTS", "false"),
  PROXY_TEST_ALLOW_REMOTE: bool("PROXY_TEST_ALLOW_REMOTE", "false"),
  PROXY_USAGE_ALLOW_UNAUTH: bool("PROXY_USAGE_ALLOW_UNAUTH", "false"),
  // Non-stream guard: allow early finalize to avoid edge timeouts (ms; 0=disabled)
  PROXY_NONSTREAM_TRUNCATE_AFTER_MS: resolveTruncateMs(),
  // Limits
  PROXY_MAX_PROMPT_TOKENS: num("PROXY_MAX_PROMPT_TOKENS", 0), // 0 disables context-length guard
  PROXY_MAX_CHAT_CHOICES: num("PROXY_MAX_CHAT_CHOICES", 5),
};
