# Subtask 06 — Error Mapping, Auth Flows, and Completion Semantics (V2)

## Objective
Make error behavior consistent and v2-aware:

- Map **Codex app-server (JSON-RPC)** errors to **HTTP status codes** + **OpenAI-style error envelopes**
- Preserve special auth errors (**unauthorized / login required**) without downcasting to 500
- Ensure **streaming termination** on errors is correct (`[DONE]`, no half-written JSON)
- Ensure **completion semantics** resolve exactly once (no double-resolve race between `error` + `turn/completed`)

---

## Spec anchors (v2) — use these to confirm behavior
These are the minimum v2 behaviors the proxy should align to.

- **Turn completion is signaled by `turn/completed`** with `turn.status` in `completed | interrupted | failed`
  - See Codex App Server docs, **Turn events**: lines **560–565**
- **If a turn fails**, the server emits an **`error` notification** with `{ error: { message, codexErrorInfo?, additionalDetails? } }` *and then* finishes with `turn.status: "failed"`
  - See Codex App Server docs, **Errors**: lines **592–605**
- **Common `codexErrorInfo` values** include `ContextWindowExceeded`, `UsageLimitExceeded`, `HttpConnectionFailed`, `ResponseStreamDisconnected`, `BadRequest`, `Unauthorized`, `SandboxError`, `InternalServerError`, `Other`
  - See Codex App Server docs, **Errors**: lines **596–605**
- **Auth surface** includes `account/read`, `account/login/start`, and `account/login/completed` notifications
  - See Codex App Server docs, **Auth endpoints**: lines **679–691**

---

## Strategy (recommended)
### Core idea: normalize once, render twice
Create **one normalization function** that converts *any* app-server failure (JSON-RPC error response, `error` notification, `turn/completed` with `status=failed`, or transport/IO exception) into a single internal shape:

- `httpStatus` (number)
- `openaiError` (OpenAI error envelope)
- `category` (auth / rate_limit / invalid_request / unavailable / upstream / unknown)
- optional `retryAfterSeconds`
- optional `raw` (for logs only, never returned)

Then use that normalized error in exactly two places:

1. **Non-streaming**: set HTTP status + `res.json(openaiError)`
2. **Streaming**:
   - If headers not sent yet, set HTTP status and stream **a single** SSE `data: {error...}` then `data: [DONE]`
   - If headers already sent, stream **a single** SSE `data: {error...}` then `data: [DONE]` (cannot change status at that point)

This avoids:
- duplicated mapping logic
- mismatched envelopes between streaming / non-streaming
- double-termination bugs (`res.end()` called twice)

---

## Alternative strategies
### A) Quick patch (least invasive)
Patch only the existing `handleError` / `on("error")` handlers:
- add unauthorized mapping
- ensure `[DONE]` emitted on error
- add minimal mapping table

Downside: mapping logic stays fragmented and will regress as new error shapes appear.

### B) Full refactor (most robust, slightly more work)
Introduce a small `error/` module + state machine for streaming turns:
- deterministic once-only completion
- testable mapping surface
- consistent behavior across all endpoints

This is the preferred direction if you expect additional v2 work.

---

## Where to look in *this* repo (fill in file+line refs)
> Note: I do not have the `codex-app-server-proxy` repository contents in this workspace, so I cannot embed exact `path:line` references yet.
> Use the commands below to produce **stable file+line anchors** and paste them into this section when implementing.

### Commands to generate exact file+line references
```bash
# JSON-RPC parsing / dispatch
rg -n "JSON-RPC|jsonrpc|on\(\"message\"|handleMessage|dispatch" .

# Error normalization candidates
rg -n "codexErrorInfo|mapTransportError|TransportError|HttpError|handleError|on\(\"error\"" .

# Streaming termination ([DONE], finish, close)
rg -n "\[DONE\]|res\.end\(|finish\b|close\b|flush\b|SSE|text/event-stream" .

# Auth / login required / unauthorized
rg -n "unauthorized|Unauthorized|requiresOpenaiAuth|account/read|login|required" .
```

### Expected hot spots (typical structure)
- JSON-RPC client / transport layer (stdio process, websocket, or HTTP bridge)
- Request handler that translates OpenAI requests → app-server `turn/start`
- SSE writer / stream adapter that emits OpenAI-compatible chunks + `[DONE]`
- Central error handler middleware (if Express/Fastify)

---

## Enumerate v2 error payload shapes (what to support)
### 1) JSON-RPC response error (standard)
Typical shape:
```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "error": { "code": -32602, "message": "Invalid params", "data": { "field": "..." } }
}
```

### 2) Server notification: `error`
Codex app-server can emit an `error` event *and then* complete the turn as failed.
```json
{
  "jsonrpc": "2.0",
  "method": "error",
  "params": {
    "error": {
      "message": "Authentication required",
      "codexErrorInfo": "Unauthorized",
      "additionalDetails": { "..." : "..." }
    }
  }
}
```

### 3) `turn/completed` with `turn.status: "failed"`
Failure is also carried on the terminal `turn` object:
```json
{
  "jsonrpc": "2.0",
  "method": "turn/completed",
  "params": {
    "turn": {
      "id": "turn_123",
      "status": "failed",
      "error": {
        "message": "...",
        "codexErrorInfo": { "type": "HttpConnectionFailed", "httpStatusCode": 429 }
      }
    }
  }
}
```

### 4) Transport-layer failures (proxy ↔ app-server)
Examples:
- app-server process exits
- JSON parse errors / framing errors
- timeout waiting for stdout
- disconnect mid-stream

These must map to a coherent HTTP status + OpenAI envelope as well.

---

## Error mapping table (Codex → HTTP → OpenAI envelope)
Use case-insensitive matching for `codexErrorInfo` since some integrations emit lowercase strings.

| Source signal (any) | Map to HTTP | `error.type` | `error.code` | Notes |
|---|---:|---|---|---|
| `codexErrorInfo in ["Unauthorized", "unauthorized"]` OR message indicates login required | 401 | `authentication_error` | `unauthorized` | Preserve as auth error (no 500). Consider `WWW-Authenticate: Bearer`. |
| `codexErrorInfo == "UsageLimitExceeded"` | 429 | `rate_limit_error` | `rate_limit_exceeded` | If `additionalDetails.resetsAt` exists, consider `Retry-After`. |
| `codexErrorInfo == "ContextWindowExceeded"` | 400 | `invalid_request_error` | `context_length_exceeded` | Treat as client error. |
| JSON-RPC `error.code in [-32700,-32600,-32602]` | 400 | `invalid_request_error` | `invalid_request_error` | Parse error / invalid request / invalid params. |
| `codexErrorInfo == "BadRequest"` | 400 | `invalid_request_error` | `bad_request` | Use message from server; do not leak internals. |
| `codexErrorInfo == "SandboxError"` | 400 or 500 | `invalid_request_error` or `server_error` | `sandbox_error` | Choose 400 if user-triggered policy violation; 500 if internal sandbox failure. |
| `codexErrorInfo.type == "HttpConnectionFailed"` with `httpStatusCode` | `httpStatusCode` | infer from status | infer | If upstream status is known, reuse it. |
| `codexErrorInfo in ["ResponseStreamDisconnected","ResponseStreamConnectionFailed"]` | 502 (or 504) | `api_connection_error` | `stream_disconnected` | Upstream stream broke. Prefer 502 unless you have a real timeout. |
| worker busy / server overloaded signal | 503 | `server_error` | `service_unavailable` | Also apply to repeated retry exhaustion (`ResponseTooManyFailedAttempts`). |
| unknown / fallback | 500 | `server_error` | `internal_error` | Default. |

### Inferring `error.type` from HTTP status (simple rule)
- 400 → `invalid_request_error`
- 401/403 → `authentication_error` / `permission_error` (if you distinguish)
- 429 → `rate_limit_error`
- 500–599 → `server_error` (or `api_connection_error` when it’s transporty)

---

## OpenAI error envelope (single canonical renderer)
Always respond with:
```json
{
  "error": {
    "message": "Human-readable message",
    "type": "authentication_error | invalid_request_error | rate_limit_error | server_error | api_connection_error",
    "code": "string_code"
  }
}
```

### Suggested helper
```ts
type OpenAIErrorEnvelope = {
  error: { message: string; type: string; code?: string; param?: string | null };
};

function toOpenAIError(args: {
  message: string;
  type: OpenAIErrorEnvelope["error"]["type"];
  code?: string;
  param?: string | null;
}): OpenAIErrorEnvelope {
  return { error: { message: args.message, type: args.type, code: args.code, param: args.param ?? null } };
}
```

---

## Suggested implementation snippets
### 1) Normalizing Codex errors into a single internal shape
```ts
type NormalizedProxyError = {
  httpStatus: number;
  openai: { error: { message: string; type: string; code?: string; param?: string | null } };
  category: "auth" | "rate_limit" | "invalid_request" | "unavailable" | "upstream" | "unknown";
  retryAfterSeconds?: number;
  // raw is for logs only (NEVER return it to callers)
  raw?: unknown;
};

function normalizeCodexError(input: unknown): NormalizedProxyError {
  // 1) Extract message + codexErrorInfo + httpStatusCode, regardless of shape.
  const extracted = extractCodexErrorFields(input); // implement with defensive parsing
  const info = (extracted.codexErrorInfo ?? "").toString();
  const infoLower = info.toLowerCase();

  // 2) Auth
  if (infoLower === "unauthorized" || infoLower.includes("unauthorized") || extracted.messageLower?.includes("authentication required")) {
    return {
      httpStatus: 401,
      category: "auth",
      openai: toOpenAIError({
        message: extracted.message ?? "Authentication required for Codex app-server.",
        type: "authentication_error",
        code: "unauthorized",
      }),
      raw: input,
    };
  }

  // 3) Rate limit
  if (info === "UsageLimitExceeded") {
    return {
      httpStatus: 429,
      category: "rate_limit",
      openai: toOpenAIError({
        message: extracted.message ?? "Rate limit exceeded.",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      }),
      retryAfterSeconds: extracted.retryAfterSeconds,
      raw: input,
    };
  }

  // 4) Context window exceeded
  if (info === "ContextWindowExceeded") {
    return {
      httpStatus: 400,
      category: "invalid_request",
      openai: toOpenAIError({
        message: extracted.message ?? "Context length exceeded.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      }),
      raw: input,
    };
  }

  // 5) HttpConnectionFailed w/ upstream status
  if (extracted.httpStatusCode && Number.isFinite(extracted.httpStatusCode)) {
    const status = extracted.httpStatusCode;
    return {
      httpStatus: status,
      category: status >= 500 ? "upstream" : "invalid_request",
      openai: toOpenAIError({
        message: extracted.message ?? "Upstream request failed.",
        type: status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error",
        code: status === 429 ? "rate_limit_exceeded" : status >= 500 ? "upstream_error" : "bad_request",
      }),
      raw: input,
    };
  }

  // 6) JSON-RPC invalid params etc.
  if (typeof extracted.jsonRpcCode === "number" && [-32700, -32600, -32602].includes(extracted.jsonRpcCode)) {
    return {
      httpStatus: 400,
      category: "invalid_request",
      openai: toOpenAIError({
        message: extracted.message ?? "Invalid request.",
        type: "invalid_request_error",
        code: "invalid_request_error",
      }),
      raw: input,
    };
  }

  // 7) Fallback
  return {
    httpStatus: 500,
    category: "unknown",
    openai: toOpenAIError({
      message: extracted.message ?? "Internal server error.",
      type: "server_error",
      code: "internal_error",
    }),
    raw: input,
  };
}
```

### 2) Streaming error semantics (`data: {error}` then `[DONE]`)
```ts
function writeSseData(res: import("http").ServerResponse, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseDone(res: import("http").ServerResponse) {
  res.write(`data: [DONE]\n\n`);
}

function endStreamWithError(res: import("http").ServerResponse, norm: NormalizedProxyError) {
  // If headers not sent, we can still set status + content-type.
  if (!res.headersSent) {
    res.statusCode = norm.httpStatus;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
  }

  writeSseData(res, norm.openai);
  writeSseDone(res);
  res.end();
}
```

### 3) Exactly-once completion guard (prevents double resolve)
```ts
function once<T extends (...args: any[]) => any>(fn: T): T {
  let called = false;
  return ((...args: any[]) => {
    if (called) return;
    called = true;
    return fn(...args);
  }) as T;
}
```

Use this to wrap the terminalizer that:
- finishes the response
- resolves/rejects the awaiting promise
- closes transports

---

## Completion semantics (v2)
### What to use as “done”
Use `turn/completed` as the authoritative end-of-turn signal.

- `turn.status: "completed"` → produce successful OpenAI completion
- `turn.status: "failed"` → map error (prefer `turn.error` payload)
- `turn.status: "interrupted"` → map to a cancellation error (client cancel / timeout); decide between 499/408/500 based on your existing semantics

### Race to handle
Because the app-server can emit:
1) `error` notification
2) then `turn/completed` with `status: "failed"`

…you must ensure only one of them causes response termination. Recommended rule:
- first terminal event wins (guarded by `once()`)

---

## Acceptance criteria
### Error mapping
- [ ] **Unauthorized** / login-required errors return **HTTP 401** with OpenAI envelope `{ error: { type: "authentication_error", code: "unauthorized" } }` (streaming + non-streaming).
- [ ] **Rate limit** errors return **HTTP 429** with OpenAI envelope `{ type: "rate_limit_error" }`.
- [ ] **Bad request** / schema errors return **HTTP 400** with OpenAI envelope `{ type: "invalid_request_error" }`.
- [ ] **Worker busy / service unavailable** returns **HTTP 503** with OpenAI envelope `{ type: "server_error" }`.
- [ ] Unknown errors default to **HTTP 500**, no internal stack traces or raw `error.data` leakage.

### Streaming semantics
- [ ] If an error occurs **mid-stream**, the proxy emits exactly:
  1) one SSE `data: { "error": ... }`
  2) one SSE `data: [DONE]`
  3) then closes the connection
- [ ] No extra chunks after the error.
- [ ] If an error occurs **before any body is written**, status code is correct and no partial JSON is sent.

### Completion semantics
- [ ] Request resolves exactly once (no double `res.end()`, no double promise settle), even if both `error` and `turn/completed` are observed.
- [ ] `turn/completed` is the authoritative success termination.

---

## Suggested tests
> Adjust test tooling to match the repo (Jest/Vitest + Supertest/Fastify inject). The key is **behavioral coverage**.

### Unit tests: normalization
- `normalizeCodexError()`:
  - Unauthorized (`codexErrorInfo: "Unauthorized"` and `"unauthorized"`)
  - Usage limit exceeded
  - Context window exceeded
  - JSON-RPC invalid params (`-32602`)
  - HttpConnectionFailed with `httpStatusCode: 429` and `503`
  - Unknown fallback

### Unit tests: streaming writer
- Given a mocked `ServerResponse`:
  - `endStreamWithError()` writes `data: {error}` then `data: [DONE]` then ends
  - If `headersSent=true`, it does not attempt to mutate headers but still emits error + done

### Integration tests: endpoint behavior
- Non-streaming request → app-server emits `turn/completed` failed:
  - verify HTTP status + JSON envelope
- Streaming request → app-server emits some deltas then `error`:
  - verify output ordering ends with `{error}` then `[DONE]`
- Race test:
  - app-server emits `error` then `turn/completed failed`
  - assert response terminates once (no duplicated `[DONE]`, no extra writes)

### Regression tests: no leakage
- Ensure returned payload never includes:
  - stack traces
  - raw JSON-RPC frames
  - internal transport exceptions

---

## Deliverable
- A centralized error mapping/normalization utility + call-site wiring
- Updated streaming termination + completion semantics (v2)
- Tests covering normalization + streaming + exactly-once termination
