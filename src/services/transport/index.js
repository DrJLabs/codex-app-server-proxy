import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { config as CFG } from "../../config/index.js";
import { nanoid } from "nanoid";
import {
  ensureWorkerSupervisor,
  getWorkerChildProcess,
  getWorkerSupervisor,
  onWorkerSupervisorEvent,
} from "../worker/supervisor.js";
import { isAppServerMode } from "../backend-mode.js";
import {
  buildInitializeParams,
  buildNewConversationParams,
  buildAddConversationListenerParams,
  buildRemoveConversationListenerParams,
  createUserMessageItem,
  normalizeInputItems,
  buildSendUserMessageParams,
  buildSendUserTurnParams,
} from "../../lib/json-rpc/schema.ts";
import { authErrorBody, normalizeCodexError } from "../../lib/errors.js";
import {
  logBackendNotification,
  logBackendResponse,
  logBackendSubmission,
} from "../../dev-trace/backend.js";

const JSONRPC_VERSION = "2.0";
const LOG_PREFIX = "[proxy][json-rpc-transport]";
const DEFAULT_CLIENT_INFO = {
  name: "codex-app-server-proxy",
  version: "1.0.0",
};
const RESULT_COMPLETION_GRACE_MS = Math.min(
  Math.max(5000, Math.floor(CFG.WORKER_REQUEST_TIMEOUT_MS / 4)),
  CFG.WORKER_REQUEST_TIMEOUT_MS
);

const normalizeNotificationMethod = (method) => {
  if (!method) return "";
  const value = String(method);
  return value.replace(/^codex\/event\//i, "");
};

const summarizeTurnParamsForLog = (params) => {
  if (!params || typeof params !== "object") return { kind: typeof params };
  const summary = {
    keys: Object.keys(params).sort(),
  };
  if (Array.isArray(params.items)) {
    const capped = params.items.slice(0, 10);
    summary.items = capped.map((item) => {
      if (!item || typeof item !== "object") {
        return { kind: typeof item };
      }
      const hasType = Object.prototype.hasOwnProperty.call(item, "type");
      const hasData = Object.prototype.hasOwnProperty.call(item, "data");
      const dataKeys =
        item.data && typeof item.data === "object" ? Object.keys(item.data).sort() : [];
      return {
        hasType,
        type: item.type,
        hasData,
        dataKeys,
      };
    });
    summary.items_truncated = params.items.length > capped.length;
  }
  if (params.sandboxPolicy && typeof params.sandboxPolicy === "object") {
    const policy = params.sandboxPolicy;
    const type =
      typeof policy.type === "string"
        ? policy.type
        : typeof policy.mode === "string"
          ? policy.mode
          : undefined;
    summary.sandboxPolicy = {
      type,
      network_access: policy.network_access,
      exclude_tmpdir_env_var: policy.exclude_tmpdir_env_var,
      exclude_slash_tmp: policy.exclude_slash_tmp,
      writable_roots_count: Array.isArray(policy.writable_roots) ? policy.writable_roots.length : 0,
    };
  }
  return summary;
};

class TransportError extends Error {
  constructor(message, { code = "transport_error", retryable = false, details = null } = {}) {
    super(message);
    this.name = "JsonRpcTransportError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

class RequestContext {
  #resolve;
  #reject;
  constructor({ requestId, timeoutMs, onTimeout, trace }) {
    this.requestId = requestId;
    this.trace = trace || null;
    this.clientConversationId = `ctx_${nanoid(12)}`;
    this.conversationId = null;
    this.subscriptionId = null;
    this.listenerAttached = false;
    this.emitter = new EventEmitter();
    this.usage = { prompt_tokens: 0, completion_tokens: 0 };
    this.rpc = { turnId: null, messageId: null };
    this.result = null;
    this.finalMessage = null;
    this.finishReason = null;
    this.deltas = [];
    this.seenContentDelta = false;
    this.completed = false;
    this.completionTimer = null;
    this.timeout = setTimeout(() => {
      if (this.completed) return;
      onTimeout?.(this);
    }, timeoutMs);
    this.promise = new Promise((resolve, reject) => {
      this.#resolve = (value) => {
        if (this.completed) return;
        this.completed = true;
        clearTimeout(this.timeout);
        resolve(value);
      };
      this.#reject = (err) => {
        if (this.completed) return;
        this.completed = true;
        clearTimeout(this.timeout);
        reject(err);
      };
    });
  }

  addDelta(payload) {
    this.deltas.push(payload);
    this.emitter.emit("delta", payload);
  }

  setFinalMessage(payload) {
    this.finalMessage = payload;
    this.emitter.emit("message", payload);
  }

  setUsage(payload) {
    if (payload && typeof payload === "object") {
      if (Number.isFinite(payload.prompt_tokens)) {
        this.usage.prompt_tokens = Number(payload.prompt_tokens);
      }
      if (Number.isFinite(payload.completion_tokens)) {
        this.usage.completion_tokens = Number(payload.completion_tokens);
      }
      if (payload.finish_reason && typeof payload.finish_reason === "string") {
        this.finishReason = payload.finish_reason;
      }
    }
    this.emitter.emit("usage", payload);
  }

  setResult(payload) {
    this.result = payload;
    this.emitter.emit("result", payload);
  }

  setFinishReason(reason) {
    if (reason) this.finishReason = reason;
  }

  resolve(value) {
    this.#resolve?.(value);
    this.emitter.emit("end", value);
  }

  reject(err) {
    this.#reject?.(err);
    this.emitter.emit("error", err);
  }

  abort(err) {
    this.reject(err);
  }
}

class JsonRpcTransport {
  constructor() {
    this.supervisor = getWorkerSupervisor();
    this.child = null;
    this.stdoutReader = null;
    this.stderrReader = null;
    this.handshakeCompleted = false;
    this.handshakeData = null;
    this.handshakePromise = null;
    this.rpcSeq = 1;
    this.pending = new Map();
    this.contextsByConversation = new Map();
    this.contextsByRequest = new Map();
    this.activeRequests = 0;
    this.destroyed = false;
    this.rpcTraceById = new Map();
    this.authLoginCache = null;
    this.authLoginPromise = null;

    this.unsubscribeSpawn = onWorkerSupervisorEvent("spawn", (child) => {
      this.#onSpawn(child);
    });
    this.unsubscribeExit = onWorkerSupervisorEvent("exit", (info) => {
      this.#onExit(info);
    });
    this.unsubscribeReady = onWorkerSupervisorEvent("ready", () => {
      if (this.destroyed) return;
      this.handshakeCompleted = false;
      this.handshakeData = null;
      this.handshakePromise = null;
      this.ensureHandshake().catch((err) => {
        console.warn(`${LOG_PREFIX} handshake failed after ready`, err);
      });
    });

    const currentChild = getWorkerChildProcess();
    if (currentChild) {
      this.#attachChild(currentChild);
    }
  }

  #clearRpcTrace(rpcId) {
    if (rpcId === null || rpcId === undefined) return;
    this.rpcTraceById.delete(rpcId);
  }

  #recordHandshakeFailure(err) {
    const handler = this.supervisor?.recordHandshakeFailure;
    if (typeof handler !== "function") return;
    try {
      handler.call(this.supervisor, err);
    } catch (failureErr) {
      console.warn(`${LOG_PREFIX} failed to record handshake failure`, failureErr);
    }
  }

  destroy() {
    this.destroyed = true;
    this.unsubscribeSpawn?.();
    this.unsubscribeExit?.();
    this.unsubscribeReady?.();
    this.#detachChild();
    for (const pending of this.pending.values()) {
      try {
        pending.reject?.(new TransportError("transport destroyed", { retryable: true }));
      } catch {}
    }
    this.pending.clear();
    for (const context of this.contextsByRequest.values()) {
      context.reject(new TransportError("transport destroyed", { retryable: true }));
    }
    this.contextsByConversation.clear();
    this.contextsByRequest.clear();
    this.rpcTraceById.clear();
  }

  async ensureHandshake() {
    if (this.handshakeCompleted && this.handshakeData) return this.handshakeData;
    if (this.handshakePromise) return this.handshakePromise;

    const child = this.child || getWorkerChildProcess();
    if (!child || !child.stdin) {
      const err = new TransportError("worker not available", {
        code: "worker_not_ready",
        retryable: true,
      });
      this.#recordHandshakeFailure(err);
      throw err;
    }

    if (child !== this.child) {
      this.#attachChild(child);
    }

    this.handshakePromise = new Promise((resolve, reject) => {
      const rpcId = this.#nextRpcId();
      const timeout = setTimeout(() => {
        this.pending.delete(rpcId);
        this.#clearRpcTrace(rpcId);
        this.handshakePromise = null;
        const err = new TransportError("JSON-RPC handshake timed out", {
          code: "handshake_timeout",
          retryable: true,
        });
        this.#recordHandshakeFailure(err);
        reject(err);
      }, CFG.WORKER_HANDSHAKE_TIMEOUT_MS);
      this.pending.set(rpcId, {
        type: "initialize",
        timeout,
        resolve: (result) => {
          clearTimeout(timeout);
          this.handshakeCompleted = true;
          this.handshakeData = {
            raw: result,
            models: this.#extractAdvertisedModels(result),
          };
          this.pending.delete(rpcId);
          this.#clearRpcTrace(rpcId);
          this.handshakePromise = null;
          const recorder = this.supervisor?.recordHandshakeSuccess;
          if (typeof recorder === "function") {
            try {
              recorder.call(this.supervisor, this.handshakeData.raw ?? result);
            } catch (err) {
              console.warn(`${LOG_PREFIX} failed to record handshake success`, err);
            }
          }
          resolve(this.handshakeData);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this.pending.delete(rpcId);
          this.#clearRpcTrace(rpcId);
          this.handshakePromise = null;
          const normalized = err instanceof Error ? err : new TransportError(String(err));
          this.#recordHandshakeFailure(normalized);
          reject(normalized);
        },
      });

      try {
        const initParams = buildInitializeParams({
          clientInfo: DEFAULT_CLIENT_INFO,
          protocolVersion: "v2",
          capabilities: {},
        });
        const recorder = this.supervisor?.recordHandshakePending;
        if (typeof recorder === "function") {
          try {
            recorder.call(this.supervisor);
          } catch (err) {
            console.warn(`${LOG_PREFIX} failed to record handshake pending`, err);
          }
        }
        this.#write({
          jsonrpc: JSONRPC_VERSION,
          id: rpcId,
          method: "initialize",
          params: initParams,
        });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(rpcId);
        this.#clearRpcTrace(rpcId);
        this.handshakePromise = null;
        this.#recordHandshakeFailure(err);
        reject(err);
      }
    });
    return this.handshakePromise;
  }

  async createChatRequest({ requestId, timeoutMs, signal, turnParams, trace }) {
    if (this.destroyed) throw new TransportError("transport destroyed", { retryable: true });
    if (!this.child)
      throw new TransportError("worker not available", {
        code: "worker_unavailable",
        retryable: true,
      });
    if (this.activeRequests >= Math.max(1, CFG.WORKER_MAX_CONCURRENCY)) {
      throw new TransportError("worker at capacity", { code: "worker_busy", retryable: true });
    }

    await this.ensureHandshake();

    const context = new RequestContext({
      requestId,
      timeoutMs: timeoutMs ?? CFG.WORKER_REQUEST_TIMEOUT_MS,
      trace: trace || null,
      onTimeout: (ctx) =>
        this.#failContext(
          ctx,
          new TransportError("request timeout", {
            code: "worker_request_timeout",
            retryable: true,
          })
        ),
    });

    this.contextsByRequest.set(requestId, context);
    this.contextsByConversation.set(context.clientConversationId, context);
    this.activeRequests += 1;

    if (signal) {
      if (signal.aborted) {
        this.#failContext(
          context,
          new TransportError("request aborted", { code: "request_aborted", retryable: false })
        );
        throw new TransportError("request aborted", { code: "request_aborted", retryable: false });
      }
      const abortHandler = () => {
        signal.removeEventListener("abort", abortHandler);
        this.#failContext(
          context,
          new TransportError("request aborted", {
            code: "request_aborted",
            retryable: false,
          })
        );
      };
      signal.addEventListener("abort", abortHandler, { once: true });
      context.emitter.once("end", () => signal.removeEventListener("abort", abortHandler));
      context.emitter.once("error", () => signal.removeEventListener("abort", abortHandler));
    }

    try {
      await this.#ensureConversation(context, turnParams);
    } catch (err) {
      this.#failContext(
        context,
        err instanceof Error ? err : new TransportError(String(err), { retryable: true })
      );
      throw err;
    }

    this.#sendUserTurn(context, turnParams);
    return context;
  }

  async #ensureConversation(context, payload) {
    if (!context) {
      throw new TransportError("invalid context", {
        code: "invalid_context",
        retryable: false,
      });
    }
    if (context.conversationId) return context.conversationId;

    const basePayload = payload && typeof payload === "object" ? { ...(payload || {}) } : {};

    const explicitConversationId =
      basePayload.conversationId || basePayload.conversation_id || null;
    if (explicitConversationId) {
      context.conversationId = String(explicitConversationId);
      this.contextsByConversation.set(context.conversationId, context);
      return context.conversationId;
    }

    const conversationParams = buildNewConversationParams({
      model: basePayload.model ?? undefined,
      modelProvider: basePayload.modelProvider ?? basePayload.model_provider ?? undefined,
      profile: basePayload.profile ?? undefined,
      cwd: basePayload.cwd ?? undefined,
      approvalPolicy: basePayload.approvalPolicy ?? basePayload.approval_policy ?? undefined,
      sandbox: basePayload.sandboxPolicy ?? basePayload.sandbox ?? undefined,
      config: basePayload.config ?? undefined,
      compactPrompt: basePayload.compactPrompt ?? basePayload.compact_prompt ?? undefined,
      baseInstructions: basePayload.baseInstructions ?? undefined,
      developerInstructions: basePayload.developerInstructions ?? undefined,
      includeApplyPatchTool:
        basePayload.includeApplyPatchTool ?? basePayload.include_apply_patch_tool ?? undefined,
    });

    const conversationResult = await this.#callWorkerRpc({
      context,
      method: "newConversation",
      params: conversationParams,
      type: "newConversation",
    });

    const conversationId =
      conversationResult?.conversation_id ||
      conversationResult?.conversationId ||
      conversationResult?.conversation?.id;

    if (!conversationId) {
      throw new TransportError("newConversation did not return a conversation id", {
        code: "worker_invalid_response",
        retryable: true,
      });
    }

    context.conversationId = String(conversationId);
    this.contextsByConversation.set(context.conversationId, context);

    const listenerResult = await this.#callWorkerRpc({
      context,
      method: "addConversationListener",
      params: buildAddConversationListenerParams({
        conversationId: context.conversationId,
        experimentalRawEvents: false,
      }),
      type: "addConversationListener",
    });

    const subscriptionId =
      listenerResult?.subscription_id || listenerResult?.subscriptionId || null;
    if (subscriptionId) {
      context.subscriptionId = String(subscriptionId);
    }
    context.listenerAttached = true;

    return context.conversationId;
  }

  async #removeConversationListener(context) {
    if (!context?.subscriptionId) return;
    try {
      await this.#callWorkerRpc({
        context,
        method: "removeConversationListener",
        params: buildRemoveConversationListenerParams({
          subscriptionId: context.subscriptionId,
        }),
        type: "removeConversationListener",
        timeoutMs: Math.min(CFG.WORKER_REQUEST_TIMEOUT_MS, 2000),
      });
    } catch (err) {
      console.warn(`${LOG_PREFIX} failed to remove conversation listener`, err);
    } finally {
      context.subscriptionId = null;
      context.listenerAttached = false;
    }
  }

  #callWorkerRpc({
    context = null,
    method,
    params = {},
    type,
    timeoutMs = CFG.WORKER_REQUEST_TIMEOUT_MS,
  }) {
    if (!this.child) {
      return Promise.reject(
        new TransportError("worker unavailable", {
          code: "worker_unavailable",
          retryable: true,
        })
      );
    }
    const rpcId = this.#nextRpcId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(rpcId);
        this.#clearRpcTrace(rpcId);
        reject(
          new TransportError(`${method} timeout`, {
            code: "worker_request_timeout",
            retryable: true,
          })
        );
      }, timeoutMs);
      this.pending.set(rpcId, {
        type: type || method,
        context,
        timeout,
        resolve,
        reject,
      });
      if (context?.trace) {
        this.rpcTraceById.set(rpcId, context.trace);
        logBackendSubmission(context.trace, { rpcId, method, params });
      }
      try {
        this.#write({
          jsonrpc: JSONRPC_VERSION,
          id: rpcId,
          method,
          params: params && typeof params === "object" ? params : {},
        });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(rpcId);
        this.#clearRpcTrace(rpcId);
        reject(err instanceof Error ? err : new TransportError(String(err)));
      }
    });
  }

  async getAuthLoginDetails() {
    if (this.authLoginCache) return this.authLoginCache;
    if (this.authLoginPromise) return this.authLoginPromise;

    const requestPromise = (async () => {
      try {
        const result = await this.#callWorkerRpc({
          context: null,
          method: "account/login/start",
          params: { type: "chatgpt" },
          type: "account/login/start",
          timeoutMs: Math.min(CFG.WORKER_REQUEST_TIMEOUT_MS, 5000),
        });
        const resultType = typeof result?.type === "string" ? result.type.toLowerCase() : null;
        const authUrl = result?.authUrl ?? result?.auth_url ?? null;
        const loginId = result?.loginId ?? result?.login_id ?? null;
        if (!authUrl || (resultType && resultType !== "chatgpt")) {
          return null;
        }
        const details = { auth_url: authUrl, login_id: loginId ?? null };
        this.authLoginCache = details;
        return details;
      } catch {
        return null;
      } finally {
        this.authLoginPromise = null;
      }
    })();

    this.authLoginPromise = requestPromise;
    return requestPromise;
  }

  sendUserMessage(context, payload) {
    if (!context) throw new TransportError("invalid context");
    if (!this.child) {
      this.#failContext(
        context,
        new TransportError("worker unavailable", { code: "worker_unavailable", retryable: true })
      );
      return;
    }
    const messageRpcId = this.#nextRpcId();
    context.rpc.messageId = messageRpcId;
    const timeout = setTimeout(() => {
      this.pending.delete(messageRpcId);
      this.#clearRpcTrace(messageRpcId);
      this.#failContext(
        context,
        new TransportError("sendUserMessage timeout", {
          code: "worker_request_timeout",
          retryable: true,
        })
      );
    }, CFG.WORKER_REQUEST_TIMEOUT_MS);
    this.pending.set(messageRpcId, {
      type: "sendUserMessage",
      context,
      timeout,
      resolve: (result) => {
        clearTimeout(timeout);
        this.pending.delete(messageRpcId);
        this.#clearRpcTrace(messageRpcId);
        context.setResult(result);
        const finishReason = result?.finish_reason || result?.status;
        context.setFinishReason(finishReason);
        this.#scheduleCompletionCheck(context);
      },
      reject: (err) => {
        clearTimeout(timeout);
        this.pending.delete(messageRpcId);
        this.#clearRpcTrace(messageRpcId);
        this.#failContext(
          context,
          err instanceof Error ? err : new TransportError(String(err), { retryable: true })
        );
      },
    });

    const basePayload = payload && typeof payload === "object" ? { ...(payload || {}) } : {};
    const fallbackText = typeof basePayload.text === "string" ? basePayload.text : undefined;
    basePayload.items = normalizeInputItems(basePayload.items, fallbackText);
    if (!Array.isArray(basePayload.items) || basePayload.items.length === 0) {
      basePayload.items = [createUserMessageItem(fallbackText ?? "")];
    }
    if (basePayload.text !== undefined) {
      delete basePayload.text;
    }
    const params = buildSendUserMessageParams({
      ...basePayload,
      conversationId: context.conversationId ?? context.clientConversationId,
      requestId: context.clientConversationId,
    });
    if (context.trace) {
      this.rpcTraceById.set(messageRpcId, context.trace);
      logBackendSubmission(context.trace, {
        rpcId: messageRpcId,
        method: "sendUserMessage",
        params,
      });
    }
    try {
      this.#write({
        jsonrpc: JSONRPC_VERSION,
        id: messageRpcId,
        method: "sendUserMessage",
        params,
      });
    } catch (err) {
      clearTimeout(timeout);
      this.pending.delete(messageRpcId);
      this.#clearRpcTrace(messageRpcId);
      this.#failContext(
        context,
        err instanceof Error ? err : new TransportError(String(err), { retryable: true })
      );
    }
  }

  cancelContext(context, error = null) {
    if (!context) return;
    const reason =
      error instanceof TransportError
        ? error
        : new TransportError(String(error?.message || "request aborted"), {
            code: "request_aborted",
            retryable: false,
          });
    for (const [rpcId, pending] of this.pending.entries()) {
      if (pending.context !== context) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(rpcId);
      this.#clearRpcTrace(rpcId);
      try {
        pending.reject?.(reason);
      } catch (err) {
        console.warn(`${LOG_PREFIX} pending reject failed`, err);
      }
    }
    if (!context.completed) {
      this.#failContext(context, reason);
    }
  }

  #sendUserTurn(context, payload) {
    if (!this.child) {
      this.#failContext(
        context,
        new TransportError("worker unavailable", { code: "worker_unavailable", retryable: true })
      );
      return;
    }
    const turnRpcId = this.#nextRpcId();
    context.rpc.turnId = turnRpcId;
    const timeout = setTimeout(() => {
      this.pending.delete(turnRpcId);
      this.#clearRpcTrace(turnRpcId);
      this.#failContext(
        context,
        new TransportError("sendUserTurn timeout", {
          code: "worker_request_timeout",
          retryable: true,
        })
      );
    }, CFG.WORKER_REQUEST_TIMEOUT_MS);
    this.pending.set(turnRpcId, {
      type: "sendUserTurn",
      context,
      timeout,
      requestSummary: null,
      resolve: (result) => {
        clearTimeout(timeout);
        this.pending.delete(turnRpcId);
        this.#clearRpcTrace(turnRpcId);
        const serverConversationId = result?.conversation_id || result?.conversationId || null;
        if (serverConversationId) {
          context.conversationId = String(serverConversationId);
          if (serverConversationId !== context.clientConversationId) {
            this.contextsByConversation.set(context.conversationId, context);
          }
        }
        context.emitter.emit("turn", result);
      },
      reject: (err) => {
        clearTimeout(timeout);
        this.pending.delete(turnRpcId);
        this.#clearRpcTrace(turnRpcId);
        this.#failContext(
          context,
          err instanceof Error ? err : new TransportError(String(err), { retryable: true })
        );
      },
    });

    try {
      const basePayload = payload && typeof payload === "object" ? { ...(payload || {}) } : {};
      const fallbackText = typeof basePayload.text === "string" ? basePayload.text : undefined;
      basePayload.items = normalizeInputItems(basePayload.items, fallbackText);
      if (!Array.isArray(basePayload.items) || basePayload.items.length === 0) {
        basePayload.items = fallbackText !== undefined ? [createUserMessageItem(fallbackText)] : [];
      }
      if (basePayload.text !== undefined) {
        delete basePayload.text;
      }
      const params = buildSendUserTurnParams({
        ...basePayload,
        conversationId: context.conversationId ?? context.clientConversationId,
        requestId: context.clientConversationId,
      });
      const pending = this.pending.get(turnRpcId);
      if (pending) {
        pending.requestSummary = summarizeTurnParamsForLog(params);
      }
      if (context.trace) {
        this.rpcTraceById.set(turnRpcId, context.trace);
        logBackendSubmission(context.trace, {
          rpcId: turnRpcId,
          method: "sendUserTurn",
          params,
        });
      }
      this.#write({
        jsonrpc: JSONRPC_VERSION,
        id: turnRpcId,
        method: "sendUserTurn",
        params,
      });
    } catch (err) {
      clearTimeout(timeout);
      this.pending.delete(turnRpcId);
      this.#clearRpcTrace(turnRpcId);
      this.#failContext(
        context,
        err instanceof Error ? err : new TransportError(String(err), { retryable: true })
      );
    }
  }

  #attachChild(child) {
    this.#detachChild();
    this.child = child;
    if (!child?.stdout) return;
    this.stdoutReader = createInterface({ input: child.stdout });
    this.stdoutReader.on("line", (line) => this.#handleLine(line));
    this.stdoutReader.on("close", () => {
      this.stdoutReader = null;
    });
    child.stdout.on("error", (err) => {
      console.warn(`${LOG_PREFIX} stdout error`, err);
    });
    if (child.stderr) {
      this.stderrReader = createInterface({ input: child.stderr });
      this.stderrReader.on("line", (line) => {
        if (!line.trim()) return;
        console.warn(`${LOG_PREFIX} worker stderr: ${line}`);
      });
      this.stderrReader.on("close", () => {
        this.stderrReader = null;
      });
    }
    this.handshakeCompleted = false;
    this.handshakeData = null;
    this.handshakePromise = null;
  }

  #detachChild() {
    if (this.stdoutReader) {
      try {
        this.stdoutReader.removeAllListeners();
        this.stdoutReader.close();
      } catch {}
      this.stdoutReader = null;
    }
    if (this.stderrReader) {
      try {
        this.stderrReader.removeAllListeners();
        this.stderrReader.close();
      } catch {}
      this.stderrReader = null;
    }
    this.child = null;
  }

  #onSpawn(child) {
    if (this.destroyed) return;
    this.#attachChild(child);
    this.ensureHandshake().catch((err) => {
      console.warn(`${LOG_PREFIX} handshake failed after spawn`, err);
    });
  }

  #onExit(info) {
    this.#detachChild();
    this.handshakeCompleted = false;
    this.handshakeData = null;
    this.handshakePromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject?.(
        new TransportError("worker exited", { code: "worker_exited", retryable: true })
      );
    }
    this.pending.clear();
    for (const context of this.contextsByRequest.values()) {
      this.#failContext(
        context,
        new TransportError("worker exited", { code: "worker_exited", retryable: true })
      );
    }
    this.contextsByConversation.clear();
    this.contextsByRequest.clear();
    this.activeRequests = 0;
    this.rpcTraceById.clear();
    if (info && info.code !== 0) {
      console.warn(`${LOG_PREFIX} worker exit code=${info.code} signal=${info.signal}`);
    }
  }

  #handleLine(line) {
    const trimmed = line?.trim();
    if (!trimmed) return;
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch (err) {
      console.warn(`${LOG_PREFIX} unable to parse worker output`, err, trimmed);
      return;
    }
    if (payload.id !== undefined) {
      this.#handleRpcResponse(payload);
      return;
    }
    if (payload.method) {
      this.#handleNotification(payload);
      return;
    }
    console.warn(`${LOG_PREFIX} unrecognized worker message`, payload);
  }

  #handleRpcResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    const trace = pending.context?.trace || this.rpcTraceById.get(message.id);
    this.#clearRpcTrace(message.id);
    if (message.error) {
      const errMessage = message.error?.message || "JSON-RPC error";
      const error = new TransportError(errMessage, {
        code: message.error?.code || "worker_error",
        retryable: true,
      });
      if (pending.type === "sendUserTurn" && pending.requestSummary) {
        try {
          console.warn(
            `${LOG_PREFIX} sendUserTurn rejected; request summary: ${JSON.stringify(pending.requestSummary)}`
          );
        } catch (err) {
          console.warn(`${LOG_PREFIX} sendUserTurn rejected; unable to log request summary`, err);
        }
      }
      if (trace) {
        logBackendResponse(trace, {
          rpcId: message.id,
          method: pending.type || "rpc",
          error: message.error,
        });
      }
      pending.reject?.(error);
      return;
    }
    if (trace) {
      logBackendResponse(trace, {
        rpcId: message.id,
        method: pending.type || "rpc",
        result: message.result ?? null,
      });
    }
    pending.resolve?.(message.result ?? null);
  }

  #handleNotification(message) {
    const params =
      message && message.params && typeof message.params === "object" ? message.params : {};
    const context = this.#resolveContext(params);
    if (!context) return;
    if (context.trace) {
      try {
        logBackendNotification(context.trace, { method: message.method, params });
      } catch {}
    }
    try {
      context.emitter.emit("notification", message);
    } catch (err) {
      console.warn(`${LOG_PREFIX} failed to emit notification`, err);
    }
    const method = normalizeNotificationMethod(message.method);
    const payload = params.msg && typeof params.msg === "object" ? params.msg : params;
    switch (method) {
      case "agentMessageDelta":
      case "agent_message_delta":
      case "agent_message_content_delta": {
        const isContentDelta = method === "agent_message_content_delta";
        if (isContentDelta) {
          context.seenContentDelta = true;
          context.addDelta(payload);
          break;
        }

        const deltaCandidate =
          payload && typeof payload === "object"
            ? (payload.delta ?? payload.content ?? payload.text)
            : payload;
        const isStringDelta = typeof deltaCandidate === "string";
        if (context.seenContentDelta && isStringDelta) break;

        context.addDelta(payload);
        break;
      }
      case "agentMessage":
      case "agent_message":
        context.setFinalMessage(payload);
        if (payload && typeof payload === "object") {
          context.setFinishReason(payload.finish_reason ?? payload.finishReason ?? null);
        }
        this.#scheduleCompletionCheck(context);
        break;
      case "tokenCount":
      case "token_count": {
        const usagePayload =
          payload && typeof payload === "object"
            ? payload.usage && typeof payload.usage === "object"
              ? payload.usage
              : payload.token_count && typeof payload.token_count === "object"
                ? payload.token_count
                : payload
            : payload;
        context.setUsage(usagePayload);
        break;
      }
      case "response.output_item.added":
      case "response.output_item.done":
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done": {
        if (payload && typeof payload === "object" && !payload.type) {
          payload.type = method;
        }
        context.addDelta(payload);
        break;
      }
      case "requestTimeout":
        this.#failContext(
          context,
          new TransportError("worker reported timeout", {
            code: "worker_request_timeout",
            retryable: true,
          })
        );
        break;
      case "taskComplete":
      case "task_complete":
        if (payload && typeof payload === "object") {
          context.setFinishReason(payload.finish_reason ?? payload.finishReason ?? null);
        }
        context.setResult(payload);
        this.#scheduleCompletionCheck(context);
        break;
      case "item/completed":
      case "item_completed": {
        const item =
          payload && typeof payload === "object" && payload.item && typeof payload.item === "object"
            ? payload.item
            : null;
        const itemType = typeof item?.type === "string" ? item.type.toLowerCase() : "";
        const isAgentMessage = itemType === "agentmessage" || itemType === "agent_message";
        if (!isAgentMessage) break;

        if (!context.finalMessage) {
          let text = "";
          if (typeof item?.text === "string") text = item.text;
          else if (Array.isArray(item?.content)) {
            text = item.content
              .map((part) => {
                if (!part || typeof part !== "object") return "";
                if (typeof part.text === "string") return part.text;
                return "";
              })
              .join("");
          }
          if (text) context.setFinalMessage({ message: text });
        }

        if (!context.finishReason) context.setFinishReason("stop");
        context.setResult(payload);
        this.#scheduleCompletionCheck(context);
        break;
      }
      default:
        break;
    }
  }

  #scheduleCompletionCheck(context) {
    if (!context || context.completed) return;
    if (context.completionTimer) {
      clearTimeout(context.completionTimer);
      context.completionTimer = null;
    }
    const hasResult = context.result !== null && context.result !== undefined;
    const hasFinalMessage = context.finalMessage !== null && context.finalMessage !== undefined;
    if (hasResult && hasFinalMessage) {
      this.#completeContext(context);
      return;
    }
    if (hasResult) {
      context.completionTimer = setTimeout(() => {
        context.completionTimer = null;
        if (!context.completed) {
          this.#scheduleCompletionCheck(context);
        }
      }, RESULT_COMPLETION_GRACE_MS);
    }
  }

  #resolveContext(params) {
    const idCandidates = [
      params?.conversation_id,
      params?.conversationId,
      params?.conversation?.id,
      params?.context?.conversation_id,
      params?.request_id,
      params?.requestId,
    ];
    for (const candidate of idCandidates) {
      if (!candidate) continue;
      const ctx =
        this.contextsByConversation.get(candidate) || this.contextsByRequest.get(candidate);
      if (ctx) return ctx;
    }
    // Fallback: single active request
    if (this.contextsByRequest.size === 1) {
      return this.contextsByRequest.values().next().value;
    }
    return null;
  }

  #completeContext(context) {
    if (context.completed) return;
    if (context.completionTimer) {
      clearTimeout(context.completionTimer);
      context.completionTimer = null;
    }
    if (context.listenerAttached) {
      this.#removeConversationListener(context).catch((err) => {
        console.warn(`${LOG_PREFIX} remove listener (complete) failed`, err);
      });
    }
    this.contextsByConversation.delete(context.clientConversationId);
    if (context.conversationId) {
      this.contextsByConversation.delete(context.conversationId);
    }
    this.contextsByRequest.delete(context.requestId);
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const payload = {
      requestId: context.requestId,
      conversationId: context.conversationId ?? context.clientConversationId,
      result: context.result,
      finalMessage: context.finalMessage,
      deltas: context.deltas,
      usage: context.usage,
      finishReason: context.finishReason,
    };
    context.resolve(payload);
  }

  #failContext(context, error) {
    if (context.completed) return;
    if (context.completionTimer) {
      clearTimeout(context.completionTimer);
      context.completionTimer = null;
    }
    if (context.listenerAttached) {
      this.#removeConversationListener(context).catch((err) => {
        console.warn(`${LOG_PREFIX} remove listener (fail) failed`, err);
      });
    }
    this.contextsByConversation.delete(context.clientConversationId);
    if (context.conversationId) {
      this.contextsByConversation.delete(context.conversationId);
    }
    this.contextsByRequest.delete(context.requestId);
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    context.reject(error instanceof Error ? error : new TransportError(String(error)));
  }

  #write(message) {
    if (!this.child?.stdin) {
      throw new TransportError("worker stdin unavailable", {
        code: "worker_unavailable",
        retryable: true,
      });
    }
    const serialized = JSON.stringify(message);
    try {
      this.child.stdin.write(serialized + "\n");
    } catch (err) {
      throw err instanceof Error ? err : new TransportError(String(err));
    }
  }

  #nextRpcId() {
    const next = this.rpcSeq;
    this.rpcSeq += 1;
    if (this.rpcSeq > 2 ** 31) this.rpcSeq = 1;
    return next;
  }

  #extractAdvertisedModels(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.models)) return result.models;
    if (Array.isArray(result?.advertised_models)) return result.advertised_models;
    return [];
  }
}

let transportInstance;

export function getJsonRpcTransport() {
  if (!isAppServerMode()) {
    throw new TransportError("JSON-RPC transport requested while app-server mode disabled", {
      code: "app_server_disabled",
      retryable: false,
    });
  }
  if (!transportInstance) {
    ensureWorkerSupervisor();
    transportInstance = new JsonRpcTransport();
  }
  return transportInstance;
}

export function resetJsonRpcTransport() {
  if (transportInstance) {
    transportInstance.destroy();
    transportInstance = null;
  }
}

const TRANSPORT_ERROR_DETAILS = {
  worker_request_timeout: {
    statusCode: 504,
    type: "timeout_error",
    message: "app-server request timeout",
    retryable: true,
  },
  request_timeout: {
    statusCode: 504,
    type: "timeout_error",
    message: "app-server request timeout",
    retryable: true,
  },
  handshake_timeout: {
    statusCode: 503,
    type: "backend_unavailable",
    message: "app-server handshake timed out",
    retryable: true,
  },
  handshake_failed: {
    statusCode: 503,
    type: "backend_unavailable",
    message: "app-server handshake failed",
    retryable: true,
  },
  worker_unavailable: {
    statusCode: 503,
    type: "backend_unavailable",
    message: "app-server worker unavailable",
    retryable: true,
  },
  worker_not_ready: {
    statusCode: 503,
    type: "backend_unavailable",
    message: "app-server worker is not ready",
    retryable: true,
  },
  worker_exited: {
    statusCode: 503,
    type: "backend_unavailable",
    message: "app-server worker exited",
    retryable: true,
  },
  worker_busy: {
    statusCode: 429,
    type: "rate_limit_error",
    message: "app-server worker at capacity",
    retryable: true,
  },
  app_server_disabled: {
    statusCode: 500,
    type: "server_error",
    retryable: false,
  },
  transport_destroyed: {
    statusCode: 503,
    type: "backend_unavailable",
    message: "JSON-RPC transport destroyed",
    retryable: true,
  },
  worker_error: {
    statusCode: 500,
    type: "server_error",
    retryable: false,
  },
  request_aborted: {
    statusCode: 499,
    type: "request_cancelled",
    message: "request aborted by client",
    retryable: false,
  },
};

export function mapTransportError(err) {
  if (!(err instanceof TransportError)) return null;
  const rawCode = err.code ?? "transport_error";
  const normalizedCode = typeof rawCode === "string" ? rawCode : String(rawCode);
  const lookupKey = normalizedCode.toLowerCase();
  if (lookupKey === "auth_required") {
    const details = err.details ?? null;
    let codeOverride = null;
    let messageOverride = null;
    const loginMode = CFG.PROXY_AUTH_LOGIN_URL_MODE;
    if (details && typeof details === "object") {
      const authUrl = details.auth_url ?? details.authUrl ?? null;
      const loginId = details.login_id ?? details.loginId ?? null;
      if (typeof authUrl === "string" && authUrl) {
        const suffixParts = [`login_url=${authUrl}`];
        if (typeof loginId === "string" && loginId) {
          suffixParts.push(`login_id=${loginId}`);
        }
        if (loginMode === "code" || loginMode === "code+message") {
          codeOverride = ["invalid_api_key", ...suffixParts].join(" | ");
        }
        if (loginMode === "message" || loginMode === "code+message") {
          messageOverride = ["unauthorized", ...suffixParts].join(" | ");
        }
      }
    }
    return {
      statusCode: 401,
      body: authErrorBody({ details, code: codeOverride, message: messageOverride }),
    };
  }
  if (err.details?.raw_codex_error) {
    const normalized = normalizeCodexError(err.details.raw_codex_error);
    if (normalized) {
      return { statusCode: normalized.statusCode, body: normalized.body };
    }
  }
  const numericCode = Number.isFinite(Number(rawCode)) ? Number(rawCode) : null;
  if (numericCode !== null && [-32700, -32600, -32602].includes(numericCode)) {
    const normalized = normalizeCodexError({ code: numericCode, message: err.message });
    return { statusCode: normalized.statusCode, body: normalized.body };
  }
  const hasMapping = Object.prototype.hasOwnProperty.call(TRANSPORT_ERROR_DETAILS, lookupKey);
  // eslint-disable-next-line security/detect-object-injection -- lookupKey guarded by hasOwnProperty
  const mapping = hasMapping ? TRANSPORT_ERROR_DETAILS[lookupKey] : undefined;

  let retryable = err.retryable === true;
  let statusCode = retryable ? 503 : 500;
  let type = retryable ? "backend_unavailable" : "server_error";
  let message = err.message || "transport error";

  if (mapping) {
    if (typeof mapping.statusCode === "number") {
      statusCode = mapping.statusCode;
    }
    if (mapping.type) {
      type = mapping.type;
    }
    if (mapping.message) {
      message = mapping.message;
    } else if (err.message) {
      message = err.message;
    } else {
      message = "transport error";
    }
    if (mapping.retryable === true) {
      retryable = true;
    } else if (mapping.retryable === false) {
      retryable = false;
    }
  } else if (retryable) {
    type = "backend_unavailable";
    statusCode = 503;
  }

  const body = {
    error: {
      message,
      type,
      code: rawCode,
    },
  };

  if (retryable) {
    body.error.retryable = true;
  }

  return { statusCode, body };
}

export { TransportError };
