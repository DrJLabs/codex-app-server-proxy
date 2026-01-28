import crypto from "node:crypto";
import { config as CFG } from "../../config/index.js";
import { invalidRequestBody } from "../../lib/errors.js";
import { logStructured } from "../../services/logging/schema.js";

const DEFAULT_TTL_MS = 120_000;
const ENABLED = Boolean(CFG.PROXY_RESPONSES_IDEMPOTENCY);
const TTL_MS = Number(CFG.PROXY_RESPONSES_IDEMPOTENCY_TTL_MS || DEFAULT_TTL_MS);
const USE_FINGERPRINT = Boolean(CFG.PROXY_RESPONSES_IDEMPOTENCY_FINGERPRINT);

const idempotencyCache = new Map();

const pruneExpired = (now) => {
  for (const [key, entry] of idempotencyCache.entries()) {
    if (!entry || entry.expiresAt <= now) idempotencyCache.delete(key);
  }
};

const stableStringify = (value) => {
  if (value === null || value === undefined) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number" || type === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (type === "object") {
    const keys = Object.keys(value)
      // eslint-disable-next-line security/detect-object-injection
      .filter((key) => value[key] !== undefined)
      .sort();
    const entries = keys.map(
      (key) =>
        // eslint-disable-next-line security/detect-object-injection
        `${JSON.stringify(key)}:${stableStringify(value[key])}`
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
};

const sha256 = (input) => crypto.createHash("sha256").update(input).digest("hex");

const summarizeTools = (tools) => {
  if (!Array.isArray(tools)) return null;
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      const type = typeof tool.type === "string" ? tool.type.trim().toLowerCase() : "function";
      const name = tool.function?.name || tool.fn?.name || tool.name || null;
      return { type, name };
    })
    .filter(Boolean);
};

const buildFingerprintPayload = (body, mode) => {
  if (!body || typeof body !== "object") return { mode };
  return {
    mode,
    model: body.model ?? null,
    instructions: body.instructions ?? null,
    input: body.input ?? null,
    tool_choice: body.tool_choice ?? body.toolChoice ?? null,
    parallel_tool_calls: body.parallel_tool_calls ?? body.parallelToolCalls ?? null,
    tools: summarizeTools(body.tools),
    response_format: body.response_format ?? body.responseFormat ?? null,
    metadata: body.metadata ?? null,
  };
};

const resolveHeaderValue = (req, names) => {
  if (!req || !req.headers) return "";
  for (const name of names) {
    // eslint-disable-next-line security/detect-object-injection
    const value = req.headers[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length && typeof value[0] === "string" && value[0].trim()) {
      return value[0].trim();
    }
  }
  return "";
};

const resolveIdempotencyKey = (req, body, mode) => {
  const headerKey = resolveHeaderValue(req, [
    "idempotency-key",
    "x-idempotency-key",
    "x-idempotency_key",
  ]);
  if (headerKey) return { key: `key:${mode}:${headerKey}`, source: "header" };

  const bodyKey =
    (typeof body?.idempotency_key === "string" && body.idempotency_key.trim()) ||
    (typeof body?.idempotencyKey === "string" && body.idempotencyKey.trim()) ||
    "";
  if (bodyKey) return { key: `key:${mode}:${bodyKey}`, source: "body" };

  if (USE_FINGERPRINT) {
    const payload = buildFingerprintPayload(body, mode);
    const fingerprint = sha256(stableStringify(payload));
    return { key: `fp:${mode}:${fingerprint}`, source: "fingerprint" };
  }

  return { key: "", source: "" };
};

const buildDuplicateError = (status) =>
  invalidRequestBody(
    "idempotency_key",
    status === "inflight"
      ? "duplicate request already in-flight"
      : "duplicate request already completed",
    status === "inflight" ? "idempotency_in_flight" : "idempotency_replayed"
  );

export const registerResponsesIdempotency = ({ req, body, mode, reqId }) => {
  if (!ENABLED) {
    return {
      enabled: false,
      shouldBlock: false,
      markDone: () => {},
      markFailed: () => {},
    };
  }

  const now = Date.now();
  pruneExpired(now);

  const { key, source } = resolveIdempotencyKey(req, body, mode);
  if (!key) {
    return {
      enabled: false,
      shouldBlock: false,
      markDone: () => {},
      markFailed: () => {},
    };
  }

  const existing = idempotencyCache.get(key);
  if (existing && existing.expiresAt > now) {
    return {
      enabled: true,
      shouldBlock: true,
      statusCode: 409,
      body: buildDuplicateError(existing.status || "inflight"),
      existing,
      key,
      source,
      markDone: () => {},
      markFailed: () => {},
    };
  }

  const entry = {
    key,
    source,
    status: "inflight",
    reqId,
    startedAt: now,
    expiresAt: now + Math.max(1, TTL_MS || DEFAULT_TTL_MS),
  };
  idempotencyCache.set(key, entry);

  return {
    enabled: true,
    shouldBlock: false,
    key,
    source,
    entry,
    markDone: () => {
      entry.status = "done";
      entry.completedAt = Date.now();
    },
    markFailed: () => {
      idempotencyCache.delete(key);
    },
  };
};

export const logResponsesIdempotencyBlock = ({ reqId, route, mode, idempotency }) => {
  if (!idempotency?.shouldBlock) return;
  const existing = idempotency.existing || {};
  logStructured(
    {
      component: "responses",
      event: "responses_idempotency_block",
      level: "info",
      req_id: reqId,
      route,
      mode,
    },
    {
      idempotency_key: idempotency.key || null,
      idempotency_source: idempotency.source || null,
      existing_status: existing.status || null,
      existing_req_id: existing.reqId || null,
      existing_started_at: existing.startedAt || null,
      existing_completed_at: existing.completedAt || null,
    }
  );
};
