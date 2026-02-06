const AUTH_DEFAULT_MESSAGE = "unauthorized";
const AUTH_DEFAULT_CODE = "invalid_api_key";

export function authErrorBody(detailsOrOptions = null) {
  let details = null;
  let codeOverride = null;
  let messageOverride = null;

  if (
    detailsOrOptions &&
    typeof detailsOrOptions === "object" &&
    !Array.isArray(detailsOrOptions)
  ) {
    const hasOverrides =
      Object.prototype.hasOwnProperty.call(detailsOrOptions, "details") ||
      Object.prototype.hasOwnProperty.call(detailsOrOptions, "code") ||
      Object.prototype.hasOwnProperty.call(detailsOrOptions, "message");
    if (hasOverrides) {
      details = detailsOrOptions.details ?? null;
      codeOverride = detailsOrOptions.code ?? null;
      messageOverride = detailsOrOptions.message ?? null;
    } else {
      details = detailsOrOptions;
    }
  }

  const error = {
    message:
      typeof messageOverride === "string" && messageOverride
        ? messageOverride
        : AUTH_DEFAULT_MESSAGE,
    type: "authentication_error",
    code: typeof codeOverride === "string" && codeOverride ? codeOverride : AUTH_DEFAULT_CODE,
  };
  if (details && typeof details === "object" && Object.keys(details).length > 0) {
    error.details = details;
  }
  return { error };
}

export function modelNotFoundBody(model) {
  return {
    error: {
      message: `The model ${model} does not exist or you do not have access to it.`,
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  };
}

export function invalidRequestBody(param, message, code = "invalid_request_error") {
  return {
    error: {
      message: message || "invalid request",
      type: "invalid_request_error",
      param,
      code: code || "invalid_request_error",
    },
  };
}

export function tokensExceededBody(param = "messages") {
  return {
    error: {
      message: "context length exceeded",
      type: "tokens_exceeded_error",
      param,
      code: "context_length_exceeded",
    },
  };
}

export function permissionErrorBody(message = "permission denied") {
  return {
    error: { message, type: "permission_error", code: "permission_denied" },
  };
}

export function serverErrorBody(message = "internal server error") {
  return { error: { message, type: "server_error", code: "internal_error" } };
}

export function sseErrorBody(e) {
  const raw = (e && e.message) || "spawn error";
  const isTimeout = /timeout/i.test(String(raw));
  return {
    error: {
      message: isTimeout ? "request timeout" : raw,
      type: isTimeout ? "timeout_error" : "server_error",
      code: isTimeout ? "request_timeout" : "spawn_error",
    },
  };
}

const toOpenAIError = ({ message, type, code, param = null }) => ({
  error: {
    message,
    type,
    code,
    param: param ?? null,
  },
});

const extractCodexErrorFields = (input) => {
  const base =
    input && typeof input === "object" && input.error && typeof input.error === "object"
      ? input.error
      : input && typeof input === "object"
        ? input
        : {};
  const message = typeof base.message === "string" ? base.message : undefined;
  const codexErrorInfo = base.codexErrorInfo ?? base.codex_error_info ?? undefined;
  const additionalDetails = base.additionalDetails ?? base.additional_details ?? undefined;
  const rawCode = base.code;
  const codeString = typeof rawCode === "string" ? rawCode.trim() : "";
  const parsedCode = codeString ? Number(codeString) : NaN;
  const jsonRpcCode =
    typeof rawCode === "number" ? rawCode : Number.isFinite(parsedCode) ? parsedCode : undefined;
  const infoType =
    codexErrorInfo && typeof codexErrorInfo === "object"
      ? (codexErrorInfo.type ?? codexErrorInfo.name ?? codexErrorInfo.code)
      : (codexErrorInfo ?? (codeString && !Number.isFinite(parsedCode) ? codeString : undefined));
  const httpStatusCode =
    base.httpStatusCode ??
    base.http_status_code ??
    (codexErrorInfo && typeof codexErrorInfo === "object"
      ? (codexErrorInfo.httpStatusCode ?? codexErrorInfo.http_status_code)
      : undefined) ??
    (additionalDetails && typeof additionalDetails === "object"
      ? (additionalDetails.httpStatusCode ?? additionalDetails.http_status_code)
      : undefined);

  let retryAfterSeconds;
  if (additionalDetails && typeof additionalDetails === "object") {
    const rawRetry = additionalDetails.retryAfterSeconds ?? additionalDetails.retry_after_seconds;
    const parsed = rawRetry != null ? Number(rawRetry) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
      retryAfterSeconds = parsed;
    }
  }

  return {
    message,
    codexErrorInfo,
    infoType,
    additionalDetails,
    httpStatusCode,
    jsonRpcCode: Number.isFinite(jsonRpcCode) ? jsonRpcCode : undefined,
    retryAfterSeconds,
  };
};

export function normalizeCodexError(input) {
  const extracted = extractCodexErrorFields(input);
  const info = extracted.infoType ?? extracted.codexErrorInfo ?? "";
  const infoLower = String(info).toLowerCase();
  const message = extracted.message ?? "Internal server error.";
  const messageLower = message.toLowerCase();

  if (
    infoLower.includes("unauthorized") ||
    infoLower.includes("unauthorised") ||
    messageLower.includes("authentication required")
  ) {
    return {
      statusCode: 401,
      body: toOpenAIError({
        message: extracted.message ?? "Authentication required.",
        type: "authentication_error",
        code: "unauthorized",
      }),
    };
  }

  if (info === "UsageLimitExceeded") {
    return {
      statusCode: 429,
      body: toOpenAIError({
        message: extracted.message ?? "Rate limit exceeded.",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      }),
      retryAfterSeconds: extracted.retryAfterSeconds,
    };
  }

  if (info === "ContextWindowExceeded") {
    return {
      statusCode: 400,
      body: toOpenAIError({
        message: extracted.message ?? "Context length exceeded.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      }),
    };
  }

  if (
    Number.isFinite(extracted.jsonRpcCode) &&
    [-32700, -32600, -32602].includes(extracted.jsonRpcCode)
  ) {
    return {
      statusCode: 400,
      body: toOpenAIError({
        message: extracted.message ?? "Invalid request.",
        type: "invalid_request_error",
        code: "invalid_request_error",
      }),
    };
  }

  if (info === "BadRequest") {
    return {
      statusCode: 400,
      body: toOpenAIError({
        message: extracted.message ?? "Bad request.",
        type: "invalid_request_error",
        code: "bad_request",
      }),
    };
  }

  if (info === "SandboxError") {
    return {
      statusCode: 400,
      body: toOpenAIError({
        message: extracted.message ?? "Sandbox error.",
        type: "invalid_request_error",
        code: "sandbox_error",
      }),
    };
  }

  if (infoLower.includes("responsestreamdisconnected")) {
    return {
      statusCode: 502,
      body: toOpenAIError({
        message: extracted.message ?? "Upstream stream disconnected.",
        type: "api_connection_error",
        code: "stream_disconnected",
      }),
    };
  }

  if (Number.isFinite(extracted.httpStatusCode)) {
    const status = Number(extracted.httpStatusCode);
    if (status === 401) {
      return {
        statusCode: 401,
        body: toOpenAIError({
          message: extracted.message ?? "Authentication required.",
          type: "authentication_error",
          code: "unauthorized",
        }),
      };
    }
    if (status === 403) {
      return {
        statusCode: 403,
        body: toOpenAIError({
          message: extracted.message ?? "Permission denied.",
          type: "permission_error",
          code: "permission_denied",
        }),
      };
    }
    const type =
      status === 429
        ? "rate_limit_error"
        : status >= 500
          ? "server_error"
          : "invalid_request_error";
    const code =
      status === 429 ? "rate_limit_exceeded" : status >= 500 ? "upstream_error" : "bad_request";
    return {
      statusCode: status,
      body: toOpenAIError({
        message: extracted.message ?? "Upstream request failed.",
        type,
        code,
      }),
      ...(status === 429 && Number.isFinite(extracted.retryAfterSeconds)
        ? { retryAfterSeconds: extracted.retryAfterSeconds }
        : {}),
    };
  }

  return {
    statusCode: 500,
    body: toOpenAIError({
      message,
      type: "server_error",
      code: "internal_error",
    }),
  };
}
