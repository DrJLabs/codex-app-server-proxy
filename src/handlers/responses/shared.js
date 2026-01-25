import { nanoid } from "nanoid";

const RESPONSE_ID_PREFIX = "resp_";
const MESSAGE_ID_PREFIX = "msg_";

const sanitizeIdentifier = (value, prefix) => {
  if (typeof value === "string" && value.trim()) {
    const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    if (cleaned) {
      return cleaned.startsWith(prefix) ? cleaned : `${prefix}${cleaned}`;
    }
  }
  return `${prefix}${nanoid()}`;
};

export const normalizeResponseId = (value) => {
  let base = typeof value === "string" ? value.trim() : "";
  if (base.startsWith(RESPONSE_ID_PREFIX)) {
    base = base.slice(RESPONSE_ID_PREFIX.length);
  }
  base = base.replace(/^chatcmpl-/, "");
  return sanitizeIdentifier(base, RESPONSE_ID_PREFIX);
};

export const normalizeMessageId = (value) => {
  let base = typeof value === "string" ? value.trim() : "";
  if (base.startsWith(MESSAGE_ID_PREFIX)) {
    base = base.slice(MESSAGE_ID_PREFIX.length);
  }
  return sanitizeIdentifier(base, MESSAGE_ID_PREFIX);
};

export const resolveResponsesOutputMode = ({ req, defaultValue }) => {
  const explicit = req?.headers?.["x-proxy-output-mode"];
  if (explicit && String(explicit).trim()) {
    return { effective: String(explicit).trim(), source: "header" };
  }
  return { effective: defaultValue, source: "default" };
};

export const applyDefaultProxyOutputModeHeader = (req, desiredOutputMode) => {
  const desired =
    desiredOutputMode === undefined || desiredOutputMode === null
      ? ""
      : String(desiredOutputMode).trim();
  if (!desired) return () => {};

  const headers = req && typeof req === "object" ? req.headers : null;
  if (!headers || typeof headers !== "object") return () => {};

  const original = headers["x-proxy-output-mode"];
  if (original !== undefined && String(original).trim()) {
    return () => {};
  }

  headers["x-proxy-output-mode"] = desired;

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (original === undefined) {
      delete headers["x-proxy-output-mode"];
    } else {
      headers["x-proxy-output-mode"] = original;
    }
  };
};

export const splitResponsesTools = (tools) => {
  const functionTools = [];
  const nativeTools = [];
  if (!Array.isArray(tools)) {
    return { functionTools, nativeTools };
  }
  tools.forEach((tool) => {
    const type = typeof tool?.type === "string" ? tool.type.toLowerCase() : "";
    if (type === "function") {
      functionTools.push(tool);
    } else {
      nativeTools.push(tool);
    }
  });
  return { functionTools, nativeTools };
};
