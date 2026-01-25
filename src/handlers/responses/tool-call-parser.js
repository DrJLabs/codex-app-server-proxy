const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";

const toSet = (value) => {
  if (!value) return null;
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.filter((item) => typeof item === "string"));
  return null;
};

const toMap = (value) => {
  if (!value) return null;
  if (value instanceof Map) return value;
  if (typeof value === "object") {
    const map = new Map();
    Object.entries(value).forEach(([key, entry]) => {
      map.set(key, entry);
    });
    return map;
  }
  return null;
};

const normalizeOptions = ({
  allowedTools,
  strictTools,
  toolSchemas,
  strictFallback = false,
  repairJson = true,
} = {}) => ({
  allowedTools: toSet(allowedTools),
  strictTools: toMap(strictTools),
  toolSchemas: toMap(toolSchemas),
  strictFallback: Boolean(strictFallback),
  repairJson: Boolean(repairJson),
});

const longestSuffixPrefix = (text, pattern) => {
  const max = Math.min(text.length, pattern.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(pattern.slice(0, len))) return len;
  }
  return 0;
};

const repairJsonPayload = (raw) => {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  return trimmed.replace(/,\s*([}\]])/g, "$1");
};

const resolveStrictMode = (name, { strictTools, strictFallback }) => {
  if (strictTools && strictTools.has(name)) {
    return Boolean(strictTools.get(name));
  }
  return Boolean(strictFallback);
};

const isAllowedTool = (name, allowedTools) => {
  if (!allowedTools || !allowedTools.size) return true;
  return allowedTools.has(name);
};

const coerceArguments = (value) => {
  if (typeof value === "string") {
    return { ok: true, value, coerced: false };
  }
  try {
    return { ok: true, value: JSON.stringify(value ?? ""), coerced: true };
  } catch {
    return { ok: false, value: "", coerced: false };
  }
};

const validateRequiredKeys = (argsText, schema) => {
  if (!schema || typeof schema !== "object") return { ok: true };
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.length) return { ok: true };
  try {
    const parsed = JSON.parse(argsText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "arguments must be an object" };
    }
    const missing = required.filter((key) => !(key in parsed));
    if (missing.length) {
      return { ok: false, error: `missing required keys: ${missing.join(", ")}` };
    }
  } catch (error) {
    return { ok: false, error: error?.message || "invalid arguments json" };
  }
  return { ok: true };
};

const parseToolCallPayload = (raw, options) => {
  const errors = [];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const strictFallback = options.strictFallback;
  let payload = null;
  let parsed = false;
  let parseError = null;

  if (trimmed) {
    try {
      payload = JSON.parse(trimmed);
      parsed = true;
    } catch (error) {
      parseError = error;
    }
  }

  if (!parsed && options.repairJson && trimmed) {
    const repaired = repairJsonPayload(trimmed);
    if (repaired !== trimmed) {
      try {
        payload = JSON.parse(repaired);
        parsed = true;
      } catch (error) {
        parseError = error;
      }
    }
  }

  if (!parsed || !payload || typeof payload !== "object") {
    errors.push({
      type: "invalid_json",
      message: parseError?.message || "invalid tool_call payload",
      strict: Boolean(strictFallback),
    });
    if (strictFallback) {
      return { errors, call: null, fallbackText: null };
    }
    return {
      errors,
      call: null,
      fallbackText: `${OPEN_TAG}${raw}${CLOSE_TAG}`,
    };
  }

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const strict = resolveStrictMode(name, options);

  if (!name) {
    errors.push({
      type: "missing_name",
      message: "tool_call name is required",
      strict,
    });
    if (strict) return { errors, call: null, fallbackText: null };
    return { errors, call: null, fallbackText: `${OPEN_TAG}${raw}${CLOSE_TAG}` };
  }

  if (!isAllowedTool(name, options.allowedTools)) {
    errors.push({
      type: "unknown_tool",
      message: `unknown tool: ${name}`,
      name,
      strict,
    });
    if (strict) return { errors, call: null, fallbackText: null };
    return { errors, call: null, fallbackText: `${OPEN_TAG}${raw}${CLOSE_TAG}` };
  }

  const argsResult = coerceArguments(payload.arguments);
  if (!argsResult.ok) {
    errors.push({
      type: "invalid_arguments",
      message: "arguments must be JSON-serializable",
      strict,
    });
    if (strict) return { errors, call: null, fallbackText: null };
    return { errors, call: null, fallbackText: `${OPEN_TAG}${raw}${CLOSE_TAG}` };
  }

  if (argsResult.coerced) {
    errors.push({
      type: "arguments_coerced",
      message: "arguments coerced to string",
      strict,
    });
    if (strict) return { errors, call: null, fallbackText: null };
  }

  if (strict) {
    const schema = options.toolSchemas?.get(name) || null;
    const validation = validateRequiredKeys(argsResult.value, schema);
    if (!validation.ok) {
      errors.push({
        type: "schema_mismatch",
        message: validation.error || "schema mismatch",
        strict: true,
      });
      return { errors, call: null, fallbackText: null };
    }
  }

  return {
    errors,
    call: {
      name,
      arguments: argsResult.value,
    },
    fallbackText: null,
  };
};

const createResult = () => ({
  visibleTextDeltas: [],
  parsedToolCalls: [],
  errors: [],
});

const consumeBuffer = (state, incoming, options, { flush = false } = {}) => {
  const result = createResult();
  let buffer = state.buffer + (typeof incoming === "string" ? incoming : "");

  while (buffer.length) {
    if (!state.inTag) {
      const openIdx = buffer.indexOf(OPEN_TAG);
      if (openIdx === -1) {
        const keep = flush ? 0 : longestSuffixPrefix(buffer, OPEN_TAG);
        const safe = buffer.slice(0, buffer.length - keep);
        if (safe) result.visibleTextDeltas.push(safe);
        buffer = buffer.slice(buffer.length - keep);
        break;
      }
      if (openIdx > 0) {
        result.visibleTextDeltas.push(buffer.slice(0, openIdx));
      }
      buffer = buffer.slice(openIdx + OPEN_TAG.length);
      state.inTag = true;
      state.tagContent = "";
    }

    if (state.inTag) {
      const closeIdx = buffer.indexOf(CLOSE_TAG);
      if (closeIdx === -1) {
        state.tagContent += buffer;
        buffer = "";
        break;
      }
      state.tagContent += buffer.slice(0, closeIdx);
      buffer = buffer.slice(closeIdx + CLOSE_TAG.length);

      const parsed = parseToolCallPayload(state.tagContent, options);
      if (parsed.call) {
        result.parsedToolCalls.push(parsed.call);
      }
      if (parsed.fallbackText) {
        result.visibleTextDeltas.push(parsed.fallbackText);
      }
      if (parsed.errors.length) {
        result.errors.push(...parsed.errors);
      }

      state.inTag = false;
      state.tagContent = "";
    }
  }

  if (flush) {
    if (state.inTag) {
      result.errors.push({ type: "unclosed_tag", message: "unterminated tool_call block" });
      result.visibleTextDeltas.push(`${OPEN_TAG}${state.tagContent}`);
      state.inTag = false;
      state.tagContent = "";
    }
    if (buffer) {
      result.visibleTextDeltas.push(buffer);
      buffer = "";
    }
  }

  state.buffer = buffer;
  return result;
};

export const createToolCallParser = (options = {}) => {
  const normalized = normalizeOptions(options);
  const state = {
    buffer: "",
    inTag: false,
    tagContent: "",
  };

  return {
    ingest(delta) {
      return consumeBuffer(state, delta, normalized, { flush: false });
    },
    flush() {
      return consumeBuffer(state, "", normalized, { flush: true });
    },
  };
};

export const parseToolCallText = (text, options = {}) => {
  const parser = createToolCallParser(options);
  const first = parser.ingest(text);
  const tail = parser.flush();
  return {
    visibleTextDeltas: [...first.visibleTextDeltas, ...tail.visibleTextDeltas],
    parsedToolCalls: [...first.parsedToolCalls, ...tail.parsedToolCalls],
    errors: [...first.errors, ...tail.errors],
  };
};
