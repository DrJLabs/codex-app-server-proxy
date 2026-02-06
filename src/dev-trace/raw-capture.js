import fs from "node:fs";
import path from "node:path";
import { config as CFG } from "../config/index.js";

const APP_SERVER_FILENAME = "app-server-raw.ndjson";
const THINKING_FILENAME = "responses-thinking-raw.ndjson";
const TRUNCATION_SUFFIX = "…<truncated>";
const appendQueues = new Map();
const REDACTED = "<redacted>";
const INLINE_AUTH_PATTERN = /\b(auth_url|login_url|login_id)=([^\s|]+)/gi;
const SECRET_HEADER_PATTERN =
  /\b(x-api-key|x-proxy-api-key|x-codex-key|cookie|set-cookie)\s*:\s*([^\s\r\n]+)/gi;
const BEARER_PATTERN = /\b((?:proxy-)?authorization\s*:\s*bearer\s+)([^\s\r\n]+)/gi;

const isDev = () => String(CFG.PROXY_ENV || "").toLowerCase() === "dev";

const ensureDir = (filePath) => {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- config-derived path
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {}
};

const safeStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
};

const redactSensitiveString = (value) => {
  if (typeof value !== "string" || !value) return value;
  return value
    .replace(INLINE_AUTH_PATTERN, (_match, key) => `${key}=${REDACTED}`)
    .replace(BEARER_PATTERN, (_match, prefix) => `${prefix}${REDACTED}`)
    .replace(SECRET_HEADER_PATTERN, (_match, key) => `${key}: ${REDACTED}`);
};

const sanitizeThinkingValue = (value, depth = 0) => {
  if (depth > 8) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeThinkingValue(entry, depth + 1));
  if (typeof value !== "object") return value;
  const next = {};
  for (const [key, entryValue] of Object.entries(value)) {
    // eslint-disable-next-line security/detect-object-injection -- sanitize captured dev-only payloads
    next[key] = sanitizeThinkingValue(entryValue, depth + 1);
  }
  return next;
};

const truncateValue = (value, maxBytes) => {
  if (!maxBytes || maxBytes <= 0) return { value, truncated: false, bytes: null };
  const raw = safeStringify(value);
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= maxBytes) return { value, truncated: false, bytes };
  const preview =
    raw.slice(0, Math.max(0, maxBytes - TRUNCATION_SUFFIX.length)) + TRUNCATION_SUFFIX;
  return {
    value: { truncated: true, bytes, preview },
    truncated: true,
    bytes,
  };
};

const appendJsonLine = (filePath, obj = {}) => {
  let payload;
  try {
    payload = JSON.stringify(obj) + "\n";
  } catch {
    return Promise.resolve();
  }
  ensureDir(filePath);
  const previous = appendQueues.get(filePath) || Promise.resolve();
  const appendTask = () =>
    new Promise((resolve) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- config-derived path
      fs.appendFile(filePath, payload, { encoding: "utf8" }, () => resolve());
    });
  const next = previous.then(() => appendTask());
  const tracked = next.finally(() => {
    if (appendQueues.get(filePath) === tracked) {
      appendQueues.delete(filePath);
    }
  });
  appendQueues.set(filePath, tracked);
  return tracked;
};

export const __whenRawCaptureIdle = (filePath) => {
  if (filePath) {
    const pending = appendQueues.get(filePath);
    return pending ? pending.then(() => undefined) : Promise.resolve();
  }
  return Promise.all(Array.from(appendQueues.values())).then(() => undefined);
};

export const resolveAppServerRawPath = () => {
  const dir = CFG.PROXY_CAPTURE_APP_SERVER_RAW_DIR;
  return path.join(String(dir), APP_SERVER_FILENAME);
};

export const resolveThinkingRawPath = () => {
  const dir = CFG.PROXY_CAPTURE_THINKING_RAW_DIR;
  return path.join(String(dir), THINKING_FILENAME);
};

export const appendAppServerRawCapture = (entry = {}) => {
  if (!isDev() || !CFG.PROXY_CAPTURE_APP_SERVER_RAW) return;
  const maxBytes = Number(CFG.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES || 0);
  const { value: payload, truncated, bytes } = truncateValue(entry.payload, maxBytes);
  const record = {
    ...entry,
    ts: Date.now(),
    payload,
    payload_truncated: truncated || false,
    payload_bytes: bytes,
    payload_max_bytes: maxBytes || null,
  };
  appendJsonLine(resolveAppServerRawPath(), record);
};

export const appendThinkingRawCapture = (entry = {}) => {
  if (!isDev() || !CFG.PROXY_CAPTURE_THINKING_RAW) return;
  const maxBytes = Number(CFG.PROXY_CAPTURE_THINKING_RAW_MAX_BYTES || 0);
  const sanitizedEntry = {
    ...entry,
    delta: sanitizeThinkingValue(entry.delta),
    metadata_info: sanitizeThinkingValue(entry.metadata_info),
  };
  const { value: delta, truncated, bytes } = truncateValue(sanitizedEntry.delta, maxBytes);
  const record = {
    ...sanitizedEntry,
    ts: Date.now(),
    delta,
    delta_truncated: truncated || false,
    delta_bytes: bytes,
    delta_max_bytes: maxBytes || null,
  };
  appendJsonLine(resolveThinkingRawPath(), record);
};
