import { EventEmitter } from "node:events";
import { getJsonRpcTransport, TransportError } from "./index.js";
import { createUserMessageItem, normalizeInputItems } from "../../lib/json-rpc/schema.ts";
import { logStructured } from "../logging/schema.js";
import { config as CFG } from "../../config/index.js";

const LOG_PREFIX = "[proxy][json-rpc-adapter]";

const toStringSafe = (data) => (typeof data === "string" ? data : (data?.toString?.("utf8") ?? ""));
const INLINE_AUTH_PATTERN = /\b(auth_url|login_url|login_id)=([^\s|]+)/gi;
const redactInlineAuth = (value) =>
  typeof value === "string"
    ? value.replace(INLINE_AUTH_PATTERN, (_match, key) => `${key}=[REDACTED]`)
    : value;

export class JsonRpcChildAdapter extends EventEmitter {
  constructor({ reqId, timeoutMs, normalizedRequest = null, trace = null }) {
    super();
    this.reqId = reqId;
    this.timeoutMs = timeoutMs;
    this.transport = getJsonRpcTransport();
    this.context = null;
    this.closed = false;
    this.started = false;
    this.normalizedRequest = normalizedRequest;
    this.trace = trace;

    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      write: (chunk) => {
        try {
          const result = this.#handleWrite(chunk);
          if (result && typeof result.then === "function") {
            result.catch((err) => {
              console.warn(`${LOG_PREFIX} stdin.write rejected`, err);
            });
            return true;
          }
          if (typeof result === "boolean") return result;
          return result ?? true;
        } catch (err) {
          console.warn(`${LOG_PREFIX} stdin.write threw`, err);
          throw err;
        }
      },
    };

    // Align with Node streams API expectations
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
  }

  async #handleWrite(chunk) {
    if (this.closed || this.started) return;
    this.started = true;
    const raw = toStringSafe(chunk).trim();
    let submission;
    try {
      submission = raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn(`${LOG_PREFIX} failed to parse submission`, err);
      submission = null;
    }
    const prompt = this.#extractPrompt(submission);

    try {
      const normalized = this.normalizedRequest || null;
      const turnPayload = normalized?.turn ? { ...normalized.turn } : undefined;
      const messagePayload = normalized?.message ? { ...normalized.message } : null;
      if (turnPayload && turnPayload.tools === undefined && messagePayload?.tools !== undefined) {
        turnPayload.tools = messagePayload.tools;
      }
      if (turnPayload) {
        turnPayload.items = normalizeInputItems(turnPayload.items, prompt);
        if (!Array.isArray(turnPayload.items) || turnPayload.items.length === 0) {
          turnPayload.items = [createUserMessageItem(prompt)];
        }
        if (Object.prototype.hasOwnProperty.call(turnPayload, "text")) {
          delete turnPayload.text;
        }
      }

      this.context = await this.transport.createChatRequest({
        requestId: this.reqId,
        timeoutMs: this.timeoutMs,
        turnParams: turnPayload,
        trace: this.trace,
      });
      if (this.closed) {
        this.transport.cancelContext(
          this.context,
          new TransportError("request aborted", {
            code: "request_aborted",
            retryable: false,
          })
        );
        await this.context.promise.catch(() => {});
        return;
      }
      this.#wireContext(this.context);
      await this.context.promise;
      this.#finalize(0);
    } catch (err) {
      this.#handleError(err);
    }
  }

  #extractPrompt(submission) {
    if (!submission) return "";
    if (typeof submission?.op?.items?.[0]?.text === "string") {
      return submission.op.items[0].text;
    }
    if (typeof submission?.prompt === "string") {
      return submission.prompt;
    }
    return "";
  }

  #wireContext(context) {
    context.emitter.on("delta", (params) => {
      const payload = this.#normalizeDelta(params);
      if (payload) this.#emitStdout({ type: "agent_message_delta", msg: payload });
    });
    context.emitter.on("message", (params) => {
      const payload = this.#normalizeMessage(params);
      if (payload) this.#emitStdout({ type: "agent_message", msg: payload });
    });
    context.emitter.on("usage", (params) => {
      const payload = this.#normalizeUsage(params, context);
      if (payload) this.#emitStdout({ type: "token_count", msg: payload });
    });
    context.emitter.on("result", (result) => {
      const finish = this.#extractFinish(result);
      if (finish) this.#emitStdout({ type: "task_complete", msg: { finish_reason: finish } });
    });
    context.emitter.on("notification", (message) => {
      if (!message?.method) return;
      const method = String(message.method);
      const normalizedMethod = method.replace(/^codex\/event\//i, "");
      const params = message?.params && typeof message.params === "object" ? message.params : {};
      if (normalizedMethod === "error") {
        const codexErrorInfo = params.codexErrorInfo;
        const willRetry = params.willRetry;
        const errorPayload = params.error && typeof params.error === "object" ? params.error : null;
        const rawErrorMessage =
          typeof errorPayload?.message === "string" ? errorPayload.message : "";
        const errorMessage = redactInlineAuth(rawErrorMessage);
        const errorInfo = errorPayload?.codexErrorInfo ?? codexErrorInfo;
        const statusCode =
          errorInfo?.responseStreamDisconnected?.httpStatusCode ??
          errorInfo?.responseStreamDisconnected?.http_status_code ??
          errorInfo?.response_stream_disconnected?.httpStatusCode ??
          errorInfo?.response_stream_disconnected?.http_status_code ??
          null;
        const additionalDetails =
          errorPayload?.additionalDetails ??
          params.additionalDetails ??
          params.additional_details ??
          null;
        const rawCodexError = {
          message: errorMessage || rawErrorMessage || null,
          codexErrorInfo: errorInfo ?? codexErrorInfo ?? null,
          additionalDetails,
          httpStatusCode: statusCode,
          willRetry: willRetry ?? null,
        };
        const authRequiredSignal =
          codexErrorInfo === "unauthorized" ||
          statusCode === 401 ||
          /\b401\b/.test(rawErrorMessage);
        if (authRequiredSignal && willRetry !== true) {
          logStructured(
            {
              component: "json_rpc",
              event: "auth_required",
              level: "warn",
              req_id: this.reqId,
              route: this.trace?.route || null,
              mode: this.trace?.mode || null,
            },
            {
              auth_required: true,
              codex_error_info: errorInfo ?? codexErrorInfo ?? null,
              error_message: errorMessage || null,
              http_status_code: statusCode,
              will_retry: willRetry ?? null,
            }
          );
          const cancelWithAuth = (details = null) => {
            const mergedDetails = details && typeof details === "object" ? { ...details } : {};
            mergedDetails.raw_codex_error = rawCodexError;
            const authError = new TransportError("auth required", {
              code: "auth_required",
              retryable: false,
              details: mergedDetails,
            });
            this.transport.cancelContext?.(this.context, authError);
          };
          if (
            CFG.PROXY_AUTH_LOGIN_URL &&
            typeof this.transport?.getAuthLoginDetails === "function"
          ) {
            Promise.resolve(this.transport.getAuthLoginDetails())
              .then((details) => cancelWithAuth(details || null))
              .catch(() => cancelWithAuth());
          } else {
            cancelWithAuth();
          }
          return;
        }
      }
      if (
        normalizedMethod === "agent_message_delta" ||
        normalizedMethod === "agent_message_content_delta" ||
        normalizedMethod === "agent_message" ||
        normalizedMethod === "token_count" ||
        normalizedMethod === "task_complete" ||
        normalizedMethod === "agentMessageDelta" ||
        normalizedMethod === "agentMessage" ||
        normalizedMethod === "tokenCount" ||
        normalizedMethod === "taskComplete"
      ) {
        return;
      }
      this.#emitStdout({ type: message.method, msg: message.params || {} });
    });
    context.emitter.on("error", (err) => this.#handleError(err));
  }

  #normalizeDelta(params) {
    if (!params) return null;
    if (typeof params.delta === "string") {
      return { delta: params.delta };
    }
    if (typeof params === "string") {
      return { delta: params };
    }
    if (params.delta && typeof params.delta === "object") {
      return { delta: params.delta };
    }
    if (params.content || params.text) {
      return { delta: params.content ?? params.text };
    }
    return { delta: params };
  }

  #normalizeMessage(params) {
    if (!params) return null;
    if (params.message) return { message: params.message };
    const message = {};
    if (params.content !== undefined) message.content = params.content;
    if (params.tool_calls) message.tool_calls = params.tool_calls;
    if (params.function_call) message.function_call = params.function_call;
    if (params.metadata) message.metadata = params.metadata;
    if (Object.keys(message).length === 0 && typeof params === "string") {
      message.content = params;
    }
    return { message };
  }

  #normalizeUsage(params, context) {
    const usage = {
      prompt_tokens: context?.usage?.prompt_tokens ?? 0,
      completion_tokens: context?.usage?.completion_tokens ?? 0,
    };
    if (params && typeof params === "object") {
      if (Number.isFinite(params.prompt_tokens)) usage.prompt_tokens = Number(params.prompt_tokens);
      if (Number.isFinite(params.completion_tokens)) {
        usage.completion_tokens = Number(params.completion_tokens);
      }
      if (params.finish_reason) usage.finish_reason = params.finish_reason;
    }
    return usage;
  }

  #extractFinish(result) {
    if (!result) return null;
    if (typeof result.finishReason === "string") return result.finishReason;
    if (typeof result.finish_reason === "string") return result.finish_reason;
    if (result.result && typeof result.result.finish_reason === "string") {
      return result.result.finish_reason;
    }
    if (result.result && typeof result.result.status === "string") {
      return result.result.status;
    }
    return null;
  }

  #emitStdout(obj) {
    try {
      this.stdout.emit("data", JSON.stringify(obj) + "\n");
    } catch (err) {
      console.warn(`${LOG_PREFIX} failed to emit stdout`, err);
    }
  }

  #handleError(err) {
    if (this.closed) return;
    const message = err instanceof TransportError ? err.message : String(err || "unknown error");
    this.stderr.emit("data", message + "\n");
    this.emit("error", err);
    this.#finalize(1);
  }

  #finalize(code) {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => {
      try {
        this.stdout.emit("end");
      } catch {}
      this.emit("exit", code ?? 0);
    });
  }

  kill() {
    if (this.closed) return;
    if (this.context) {
      const error = new TransportError("request aborted", {
        code: "request_aborted",
        retryable: false,
      });
      this.transport.cancelContext?.(this.context, error);
      this.context = null;
    }
    this.#finalize(null);
  }
}

export function createJsonRpcChildAdapter(options) {
  return new JsonRpcChildAdapter(options);
}
