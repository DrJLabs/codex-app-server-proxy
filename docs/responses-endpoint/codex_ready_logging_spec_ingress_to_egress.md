# Codex-Ready Logging Spec: Ingress-to-Egress Observability (main)

> **Update note (Dec 12, 2025):** This spec was re-evaluated against **`main`** at commit  
> **`7ad6515946b830369f3679377705b5fae6e0b2bb`** (merge of `feat/task-04-ac4` + follow-up fixes).  
> The overall strategy is unchanged, but several sections were updated to reflect new code that already
> (a) **defaults `/v1/responses` output mode to `openai-json`**, and (b) **adds Responses SSE summary logging + metrics**.
>
> **Implementation status (Dec 12, 2025):** codebase implements **P0/P1/P2/P4/P5**; **P3/P6** remain TODO.
>
> **Update note (Dec 13, 2025):** `/v1/responses` ingress logging now includes **context-contamination marker flags**
> (`has_recent_conversations_tag`, `has_use_tool_tag`, `has_tool_result_marker`) and Responses streaming emits a
> structured **`tool_call_arguments_done`** event (hashes/lengths only) to make multi-step Copilot tool loops easier to debug.
>
> **Update note (Jan 24, 2026):** `/v1/responses` now uses a **native** responses pipeline (no chat wrapper). References
> to chat rewriting or `responseTransform` are legacy; the canonical flow is `normalizeResponsesRequest` →
> `runNativeResponses` → `buildResponsesEnvelope`.

## 1) Assumptions and source anchors

### Audit-driven assumptions (what this spec is designed to observe)

Key **main-branch behaviors** that drive logging requirements:

- `/v1/responses` uses a **native JSON-RPC pipeline** (no chat wrapper):
  - `postResponsesStream()` normalizes input (`normalizeResponsesRequest`) and streams `runNativeResponses` into the typed SSE adapter.  
    (`src/handlers/responses/stream.js`, `src/handlers/responses/native/request.js`, `src/handlers/responses/native/execute.js`)
  - `postResponsesNonStream()` normalizes input and builds the envelope directly via `buildResponsesEnvelope`.  
    (`src/handlers/responses/nonstream.js`, `src/handlers/responses/native/envelope.js`)
- **New in main:** `/v1/responses` now defaults `x-proxy-output-mode` using `PROXY_RESPONSES_OUTPUT_MODE` (default `openai-json`) when the client does not provide the header.  
  (`src/handlers/responses/shared.js` → `applyDefaultProxyOutputModeHeader`; used by both responses handlers)
- **New in main:** Responses streaming already:
  - emits typed SSE with `event: <type>`, `data: <json>` (and `event: done` / `data: [DONE]`), and
  - records event counts/metrics plus a structured **`responses.sse_summary`** log at stream completion/failure.  
  (`src/handlers/responses/stream-adapter.js` → `createResponsesStreamAdapter`, `recordEvent()`, `logEventSummary()`)
- **New in main:** streaming `status` is **derived** from finish reasons (not forced):  
  - streaming adapter uses `mapFinishStatus()`  
  - non-stream converter uses `deriveStatusFromFinishReasons()`  
  (`src/handlers/responses/stream-adapter.js`, `src/handlers/responses/shared.js`)
- Existing dev-trace/proto logging exists, but it logs the **translated chat body** for `/v1/responses` unless explicitly captured earlier:
  - ingress proto logging is emitted by `logHttpRequest()` inside chat handlers.  
    (`src/dev-trace/http.js` → `logHttpRequest`; called by `src/handlers/chat/stream.js` + `nonstream.js`)
  - SSE/json egress proto logging is emitted by `sendSSE()`/`finishSSE()` and `installJsonLogger()`.  
    (`src/services/sse.js`)

Remaining **knowledge gaps** this spec closes (updated for main):

- **GAP-1:** Typed `/v1/responses` SSE frames are **not** logged per-event (main only logs `sse_summary` aggregates).  
- **GAP-2:** Raw `/v1/responses` ingress is still **lost** due to `req.body` rewrite (chat ingress logs capture the rewritten body).  
- **GAP-3 (updated):** Final `/v1/responses` **usage + finish semantics** are only partially observable:
  - status + finish reasons are logged in `sse_summary`, but
  - usage token counts and `previous_response_id` correlation are not consistently present in logs.
- **GAP-4 (updated):** `previous_response_id` is accepted but **not** echoed in Responses JSON; presence/value is **not logged deterministically** (hash-only needed).  
- **GAP-5:** Tool-call argument validity + tool-call ID continuity are not logged (needed to debug Copilot tool-call loops).  
- **GAP-ERR-STREAM (uncertainty):** Need deterministic evidence of which error path occurred:
  - chat stream error SSE vs adapter `response.failed` vs both.

### Key code anchors (instrumentation targets)

| Area | File | Symbol | Why it matters |
|---|---|---|---|
| Ingress req_id | `src/middleware/access-log.js` | `accessLog()` | Generates `req_id`, sets `X-Request-Id`, logs access summary. |
| Tracing | `src/middleware/tracing.js` | `tracingMiddleware()` | Sets `trace_id` / `span_id` in `res.locals`. |
| Responses routing | `src/routes/responses.js` | `responsesRouter()` | `/v1/responses` POST selects stream/non-stream based on `body.stream`. |
| Responses ingress translation | `src/handlers/responses/stream.js` | `postResponsesStream()` | Raw body exists here **before** normalization; builds JSON-RPC items and attaches typed SSE adapter. |
| Responses ingress translation | `src/handlers/responses/nonstream.js` | `postResponsesNonStream()` | Raw body exists here **before** normalization; builds the Responses envelope directly. |
| Output-mode defaulting | `src/handlers/responses/shared.js` | `applyDefaultProxyOutputModeHeader()` | New in main; changes downstream output/tool surfaces. |
| Typed Responses SSE emission | `src/handlers/responses/stream-adapter.js` | `writeEvent()` | Single choke point for all typed SSE frames. |
| Stream summary log | `src/handlers/responses/stream-adapter.js` | `logEventSummary()` | Already exists; extend to include usage + prev_response hash. |
| Chat stream wrapper | `src/handlers/chat/stream.js` | `postChatStream()` | Calls adapter hooks; contains error paths; logs translated ingress. |
| JSON response transform | `src/handlers/chat/nonstream.js` | `respondWithJson()` | Chat-only response transform; `/v1/responses` no longer relies on `responseTransform`. |
| Proto egress logs | `src/services/sse.js` | `sendSSE()`, `finishSSE()`, `installJsonLogger()` | Logs chat-style SSE/json; does not cover typed Responses SSE. |
| Proto ingress logs | `src/dev-trace/http.js` | `logHttpRequest()` | Current ingress log; caches once per request. |
| Proto emitter controls | `src/dev-logging.js` | `appendProtoEvent()` | Dev-only JSONL event sink (`PROTO_LOG_PATH`), gated by `PROXY_LOG_PROTO`. |
| Structured logger | `src/services/logging/schema.js` | `logStructured()` | Safe structured log sink (redacts `payload/body/headers/messages/response`). |

## 2) Priority-ordered logging plan (urgency-first)

### P0 — Ingress envelope + correlation IDs (request_id + copilot_trace_id)  
**Resolves:** foundational for **all GAPs** (correlates ingress↔stream↔egress)

**Goal**  
Ensure every log line can be correlated across ingress → transforms → upstream → SSE → egress, with stable IDs.

**What to log (structured keys)**
- `endpoint_mode`: `"chat_completions" | "responses"`
- `request_id`: use existing `req_id` (from `accessLog` / `ensureReqId`)
- `copilot_trace_id`: inbound header if present; else generated UUID/ID (do **not** use API key)
- `trace_id`: from tracing middleware if enabled
- `route`, `method`, `path`
- `stream` (bool)
- `output_mode_requested` (string|null), `output_mode_effective` (string|null)

**Where to instrument**
- `src/middleware/access-log.js` → `accessLog()` (augment locals only; avoid double logging)
- `src/handlers/responses/stream.js` → `postResponsesStream()` (set `endpoint_mode="responses"`)
- `src/handlers/responses/nonstream.js` → `postResponsesNonStream()` (set `endpoint_mode="responses"`)
- (Optional) `src/handlers/chat/stream.js` + `nonstream.js` (set `endpoint_mode="chat_completions"` when not overridden)

**When to emit**
- **pre-ingress (earliest entry in handlers):** create/propagate IDs into `res.locals`
- **post-header-normalization:** after output mode defaulting is applied (so `output_mode_effective` is correct)

**Code example (drop-in)**
_Add helper (no new deps) in `src/lib/request-context.js` or a new `src/lib/trace-ids.js`:_
```js
import { nanoid } from "nanoid";

const COPILOT_TRACE_KEY = Symbol.for("codex.proxy.copilotTraceId");

export function ensureCopilotTraceId(req, res) {
  if (!res.locals) res.locals = {};
  const existing = res.locals[COPILOT_TRACE_KEY] || res.locals.copilot_trace_id;
  if (existing) return existing;

  const inbound =
    req.headers["x-copilot-trace-id"] ||
    req.headers["x-trace-id"] ||
    req.headers["x-request-id"];

  const value = (typeof inbound === "string" && inbound.trim()) ? inbound.trim() : nanoid();
  res.locals[COPILOT_TRACE_KEY] = value;
  res.locals.copilot_trace_id = value;
  return value;
}
```

_Call at start of Responses handlers (before rewrite):_
```js
import { ensureCopilotTraceId, ensureReqId } from "../lib/request-context.js";

const reqId = ensureReqId(res);
const copilotTraceId = ensureCopilotTraceId(req, res);
// store endpoint_mode too
res.locals.endpoint_mode = "responses";
```

**Redaction rules**
- Never log Authorization headers or API keys.
- Do not log prompt text here; metadata only.

**Acceptance criteria**
- Every request (chat or responses) has logs containing `request_id` + `copilot_trace_id`.
- `/v1/responses` requests log `output_mode_requested` and `output_mode_effective`.

---

### P1 — Raw Responses ingress snapshot before translation  
**Resolves:** **GAP-2**, supports **GAP-4/5**

**Goal**  
Capture what the client actually sent to `/v1/responses` *before* `req.body` is rewritten.

**What to log (structured keys)**
- `event`: `responses_ingress_raw`
- `endpoint_mode="responses"`, `request_id`, `copilot_trace_id`, `trace_id`, `route`, `method`
- `stream` (bool)
- `model` (string|null)
- Shape flags (no content):
  - `has_messages`, `has_instructions`, `has_input`
  - `input_is_array`, `input_item_count` (int|null)
  - `input_item_types` (set of strings; best-effort)
  - `input_message_count` (int), `input_message_roles` (set; best-effort)
  - **Context-contamination signals (derived; no content):**
    - `has_recent_conversations_tag` (bool; detects `<recent_conversations>` blocks)
    - `has_use_tool_tag` (bool; detects `<use_tool>` tool markup)
    - `has_tool_result_marker` (bool; detects `Tool '…' result:` transcripts)
  - `has_input_item_metadata`, `input_item_metadata_keys` (keys-only; capped)
  - `has_metadata`, `metadata_keys` (keys-only; capped)
  - `has_session_like_metadata_key` (bool; detects keys like `session_id`, `conversation_id`, etc)
  - `candidate_id_fields_present` (top-level session-ish ids present; keys-only)
  - `candidate_header_keys` (headers containing session-ish hints; keys-only)
  - `has_tools`, `has_tool_choice`
  - `has_previous_response_id` (bool)
  - `has_tool_output_items` (bool) **(critical for Copilot tool loops)**
- Output-mode:
  - `output_mode_requested` (from header prior to default)
  - `output_mode_effective` (after `applyDefaultProxyOutputModeHeader`)

**Where to instrument**
- `src/handlers/responses/stream.js` → `postResponsesStream()`
- `src/handlers/responses/nonstream.js` → `postResponsesNonStream()`

**When to emit**
- **pre-transform:** immediately after reading `originalBody = req.body || {}` and before `req.body = chatBody`.

**Code example (drop-in)**
```js
import { logStructured } from "../../services/logging/schema.js";
import { ensureReqId } from "../../lib/request-context.js";
import { ensureCopilotTraceId } from "../../lib/trace-ids.js";

function summarizeResponsesIngress(body, req) {
  const input = body?.input;
  const inputItems = Array.isArray(input) ? input : (input?.content && Array.isArray(input.content) ? input.content : null);
  const itemTypes = new Set();
  let hasToolOutputItems = false;
  // Optional: collect keys-only session hints from req.headers + body.metadata + input item metadata

  if (Array.isArray(inputItems)) {
    for (const it of inputItems) {
      if (it && typeof it === "object") {
        if (typeof it.type === "string") itemTypes.add(it.type);
        if (it.type === "tool_output") hasToolOutputItems = true;
      }
    }
  }

  return {
    has_messages: Array.isArray(body?.messages) && body.messages.length > 0,
    has_instructions: typeof body?.instructions === "string" && body.instructions.trim() !== "",
    has_input: input !== undefined,
    input_is_array: Array.isArray(input),
    input_item_types: Array.from(itemTypes),
    // + session-hint fields (keys-only), see src/handlers/responses/ingress-logging.js
    has_tools: Array.isArray(body?.tools) && body.tools.length > 0,
    has_tool_choice: body?.tool_choice !== undefined,
    has_previous_response_id: typeof body?.previous_response_id === "string" && body.previous_response_id.trim() !== "",
    has_tool_output_items: hasToolOutputItems,
    model: typeof body?.model === "string" ? body.model : null,
  };
}

// inside postResponsesStream / postResponsesNonStream, before rewriting req.body:
const reqId = ensureReqId(res);
const copilotTraceId = ensureCopilotTraceId(req, res);
const before = req.headers["x-proxy-output-mode"] ? String(req.headers["x-proxy-output-mode"]) : null;

const restoreOutputMode = applyDefaultProxyOutputModeHeader(req, CFG.PROXY_RESPONSES_OUTPUT_MODE);
const after = req.headers["x-proxy-output-mode"] ? String(req.headers["x-proxy-output-mode"]) : null;

logStructured(
  { component: "responses", event: "responses_ingress_raw", level: "info", req_id: reqId, trace_id: res.locals?.trace_id, route: "/v1/responses" },
  { copilot_trace_id: copilotTraceId, stream: !!originalBody?.stream, output_mode_requested: before, output_mode_effective: after, ...summarizeResponsesIngress(originalBody, req) }
);
```

**Redaction rules**
- Do not log `instructions`/`input`/`messages` content.
- If you must identify `previous_response_id`, log **hash only** (see Section 5 helper).

**Acceptance criteria**
- For every `/v1/responses` request, logs show `responses_ingress_raw` with correct shape flags and effective output mode.
- Requests containing `input` blocks with tool outputs are detectable via `has_tool_output_items=true`.

---

### P2 — Typed Responses SSE egress: per-event logging with monotonic seq  
**Resolves:** **GAP-1**

**Goal**  
Log **every typed Responses SSE event** emitted by `createResponsesStreamAdapter()` with a monotonic sequence number, without logging raw content by default.

> **Main-branch note:** `createResponsesStreamAdapter()` already records event counts/metrics and emits a final `responses.sse_summary`.  
> This priority adds **per-event** observability (sequence + sizes) needed to debug ordering/shape mismatches.

**What to log (structured keys)**
- `event`: `responses_sse_out`
- `endpoint_mode="responses"`
- `request_id`, `copilot_trace_id`, `trace_id`, `route`
- `stream=true`, `stream_protocol="sse"`
- `stream_event_seq`: int (monotonic per request)
- `stream_event_type`: string (SSE `event:` value)
- `delta_bytes`: int|null (for delta events)
- `event_bytes`: int|null (serialized bytes; optional)
- `response_shape_version`: string (e.g., `responses_v0_typed_sse_openai_json`)

**Where to instrument**
- `src/handlers/responses/stream-adapter.js` → `createResponsesStreamAdapter()` → `writeEvent(event, payload)`

**When to emit**
- **per SSE event**, just before/after `res.write(...)`.

**Code example (drop-in)**
```js
import { appendProtoEvent } from "../../dev-logging.js";
import { ensureReqId } from "../../lib/request-context.js";

function getDeltaBytes(payload) {
  if (!payload || typeof payload !== "object") return null;
  const delta =
    (typeof payload.delta === "string" && payload.delta) ? payload.delta :
    (typeof payload.arguments === "string" && payload.arguments) ? payload.arguments :
    null;
  return delta ? Buffer.byteLength(delta, "utf8") : null;
}

// inside createResponsesStreamAdapter()
state.eventSeq = 0;

const writeEvent = (event, payload) => {
  if (res.writableEnded) return;

  state.eventSeq += 1;
  const reqId = ensureReqId(res);

  // NOTE: appendProtoEvent is dev-only (gated by PROXY_LOG_PROTO)
  appendProtoEvent({
    phase: "responses_sse_out",
    req_id: reqId,
    route: res.locals?.routeOverride || "/v1/responses",
    mode: res.locals?.modeOverride || "responses_stream",
    endpoint_mode: "responses",
    copilot_trace_id: res.locals?.copilot_trace_id || null,
    trace_id: res.locals?.trace_id || null,
    stream: true,
    stream_protocol: "sse",
    stream_event_seq: state.eventSeq,
    stream_event_type: event,
    delta_bytes: getDeltaBytes(payload),
    response_shape_version: "responses_v0_typed_sse_openai_json",
  });

  // existing write path
  const data = event === "done" && payload === "[DONE]" ? "[DONE]" : JSON.stringify(payload);
  res.write(`event: ${event}\ndata: ${data}\n\n`);
  recordEvent(event);
};
```

**Redaction rules**
- Do not include `payload` in proto events (or if included, use key `payload` so schema redacts it).
- If verbose mode is enabled, only allow a **truncated preview** of delta fields (never tool outputs).

**Acceptance criteria**
- Streaming `/v1/responses` runs produce `responses_sse_out` lines for:
  - `response.created` → deltas → `response.completed` → `done`
- `stream_event_seq` is strictly increasing from 1 per request.

---

### P3 — Streaming error-path determinism (chat error vs responses.failed)  
**Resolves:** **GAP-ERR-STREAM**

**Goal**  
When streaming fails, make it unambiguous whether the client received:
- chat-style `error` event,
- adapter-emitted `response.failed`,
- and what done sentinel was written.

**What to log (structured keys)**
- `event`: `stream_error_detected`
- `endpoint_mode`, `request_id`, `copilot_trace_id`, `trace_id`, `route`, `mode`
- `adapter_present` (bool)
- `adapter_failed_emitted` (bool|null)
- `http_status_upstream` (if available)
- `error_type` (normalized), `error_code` (string|int|null)
- `done_sentinel_written`: `"chat_done" | "responses_done" | "none" | "unknown"`

**Where to instrument**
- `src/handlers/chat/stream.js` → `postChatStream()` (all catch blocks and early error returns)
- `src/handlers/responses/stream-adapter.js` → `emitFailure()` (set a marker in `res.locals`)

**When to emit**
- At first detection of any stream-fatal error (before writing any error SSE).
- Once at stream termination (finalize), if error occurred.

**Code example (drop-in)**
```js
// in responses/stream-adapter.js emitFailure()
res.locals = res.locals || {};
res.locals.adapter_failed_emitted = true;

// in chat/stream.js, inside a catch(error) or error return path:
logStructured(
  { component: "stream", event: "stream_error_detected", level: "error", req_id: reqId, trace_id: res.locals?.trace_id, route, },
  {
    endpoint_mode: res.locals?.endpoint_mode || "chat_completions",
    copilot_trace_id: res.locals?.copilot_trace_id || null,
    mode,
    adapter_present: !!streamAdapter,
    adapter_failed_emitted: res.locals?.adapter_failed_emitted ?? null,
    error_type: normalizedType,
    error_code: normalizedCode,
    done_sentinel_written: streamAdapter ? "responses_done" : "chat_done",
  }
);
```

**Redaction rules**
- Error messages may contain user content; log only `error_type`/`error_code` unless `PROXY_DEBUG_WIRE=1`.

**Acceptance criteria**
- Every failed stream produces exactly one `stream_error_detected` with `adapter_present` and `done_sentinel_written`.

---

### P4 — Finalization: status/finish_reasons/usage + previous_response_id observability  
**Resolves:** **GAP-3**, **GAP-4**

**Goal**  
Record final emitted semantics for `/v1/responses` without relying on payload inspection.

> **Main-branch note:** streaming already logs `responses.sse_summary` with `status` and `finish_reasons`.  
> This priority extends summary logging to include **usage tokens** and a **hash-only previous_response_id**.

**What to log (structured keys)**
- Streaming: extend existing `responses.sse_summary` extras to include:
  - `usage_input_tokens`, `usage_output_tokens`, `usage_total_tokens`
  - `previous_response_id_hash` (sha256)
  - `output_mode_effective`
  - `response_shape_version`
- Non-stream: add a single summary event:
  - `event`: `responses_nonstream_summary`
  - `status_emitted`, `usage_*`, `previous_response_id_hash`, `output_mode_effective`

**Where to instrument**
- Streaming:
  - `src/handlers/responses/stream-adapter.js` → `logEventSummary()` call sites (`completed` + `failed`)
- Non-stream:
  - `src/handlers/responses/nonstream.js` → `transform(payload, statusCode)` (after conversion)

**When to emit**
- Streaming: once per stream completion/failure (already happens).
- Non-stream: once per non-stream successful response transform (statusCode < 400).

**Code example (drop-in)**
```js
import crypto from "node:crypto";

const sha256 = (s) =>
  crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");

// streaming: in logEventSummary(outcome, extra)
const prev = requestBody?.previous_response_id;
const usage = state.usage;
logStructured(
  { component: "responses", event: "sse_summary", level: outcome === "failed" ? "error" : "debug", ... },
  {
    outcome,
    events,
    finish_reasons: Array.from(state.finishReasons),
    usage_input_tokens: usage?.prompt_tokens ?? null,
    usage_output_tokens: usage?.completion_tokens ?? null,
    usage_total_tokens: usage?.total_tokens ?? null,
    previous_response_id_hash: prev ? sha256(prev) : null,
    output_mode_effective: String(res.getHeader?.("x-proxy-output-mode") || "") || null,
    response_shape_version: "responses_v0_typed_sse_openai_json",
  }
);
```

**Redaction rules**
- Never log `previous_response_id` raw; hash only.
- Never log text output; counts only.

**Acceptance criteria**
- Streaming `/v1/responses` emits `sse_summary` with usage tokens when upstream includes usage.
- Non-stream `/v1/responses` emits `responses_nonstream_summary` with status + usage (when present).

---

### P5 — Tool lifecycle: tool call detect + tool-result submit observability  
**Resolves:** **GAP-5** (and supports Copilot tool-call debugging)

**Goal**  
Make tool-call IDs, names, and argument validity observable without logging raw tool args by default.

**What to log (structured keys)**
- `event`: `tool_call_detected` / `tool_call_arguments_done`
- `endpoint_mode="responses"`, `request_id`, `copilot_trace_id`, `trace_id`, `route`
- Tool fields:
  - `tool_call_id` (string)
  - `tool_name` (string)
  - `tool_args_bytes` (int)
  - `tool_args_json_valid` (bool)
  - (Optional, safe) `tool_args_hash` (sha256 of args JSON string)
  - (Optional, safe) `tool_args_query_len` (int|null) + `tool_args_query_hash` (sha256|null)
  - (Optional, safe) `tool_args_chat_history_len` (int|null)
- Ingress-only (Responses):
  - `has_tool_output_items` (bool)
  - `tool_output_bytes_total` (int|null; best-effort)

**Where to instrument**
- Streaming Responses:
  - `src/handlers/responses/stream-adapter.js` → `finalizeToolCalls()` at `response.function_call_arguments.done` emission point
- Non-stream Responses:
  - `src/handlers/responses/nonstream.js` → response transform after conversion (count tool_use nodes)
- Ingress:
  - `src/handlers/responses/stream.js` + `nonstream.js` (reuse P1 shape capture)

**When to emit**
- Once per tool call when arguments are finalized (`arguments.done`), and once per request for ingress.

**Code example (drop-in)**
```js
const args = argumentsText || "";
const argsBytes = Buffer.byteLength(args, "utf8");
let jsonValid = false;
try { JSON.parse(args); jsonValid = true; } catch { jsonValid = false; }

appendProtoEvent({
  phase: "tool_call_arguments_done",
  endpoint_mode: "responses",
  req_id: ensureReqId(res),
  copilot_trace_id: res.locals?.copilot_trace_id || null,
  route: "/v1/responses",
  tool_call_id: existing.id,
  tool_name: existing.name,
  tool_args_bytes: argsBytes,
  tool_args_json_valid: jsonValid,
});
```

**Redaction rules**
- Do not log tool args content; only bytes and validity.
- In verbose mode, allow small preview of args *only* if JSON invalid (to debug truncation), capped.

**Acceptance criteria**
- Tool-call streams emit at least one `tool_call_arguments_done` per tool with stable `tool_call_id`.
- `tool_args_json_valid=false` is observable when upstream sends invalid JSON args.

---

### P6 — Upstream boundary logs (request start + response end)  
**Resolves:** supports diagnosis for **all GAPs**

**Goal**  
Record upstream target and status/latency with correlation to `request_id` and `endpoint_mode`.

**What to log (structured keys)**
- `event`: `upstream_request_start` / `upstream_response_end`
- `endpoint_mode`, `request_id`, `copilot_trace_id`, `route`
- `upstream_mode`: `"child" | "app_server" | "unknown"`
- `http_status_upstream`: int|null
- `latency_ms`: int|null
- `retry_count`, `backoff_ms`

**Where to instrument**
- Wherever the worker/backend invocation occurs in chat handlers (same as prior audit).  
  _No main-branch change was detected that alters this strategy._

**Redaction rules**
- Never log upstream auth headers or request body (covered by P1 hashes/flags).

**Acceptance criteria**
- Every request yields exactly one `upstream_request_start` and one `upstream_response_end` with matching `request_id`.

---

## 3) Canonical log schema (stable JSON)

### Required keys (must be present on all new events)
- `timestamp` (string ISO) or `ts_ms` (int) (logger may add automatically)
- `endpoint_mode`: `"chat_completions" | "responses"`
- `request_id` (or `req_id`): string
- `copilot_trace_id`: string
- `trace_id`: string|null
- `route`: string
- `mode`: string|null
- `method`: string
- `stream`: bool
- `stream_protocol`: `"sse" | null`
- `output_mode_requested`: string|null
- `output_mode_effective`: string|null
- `response_shape_version`: string

### Optional keys (only when relevant)
- `http_status_inbound`: int
- `http_status_upstream`: int|null
- `error_type`: string|null
- `error_code`: string|int|null
- `retry_count`: int
- `backoff_ms`: int
- `finish_reason`: string|null
- `stop_reason`: string|null
- `status_emitted`: string|null
- `finish_reasons`: string[]|null
- Usage:
  - `usage_input_tokens`: int|null
  - `usage_output_tokens`: int|null
  - `usage_total_tokens`: int|null
- Streaming:
  - `stream_event_seq`: int
  - `stream_event_type`: string
  - `delta_bytes`: int|null
  - `event_bytes`: int|null
- Tool calls:
  - `tool_call_id`: string|null
  - `tool_name`: string|null
  - `tool_args_json_valid`: bool|null
  - `tool_args_bytes`: int|null
  - `tool_output_bytes_total`: int|null
- Redaction:
  - `previous_response_id_hash`: string|null
  - `prompt_hash`: string|null
  - `content_truncated`: bool
  - `content_preview_len`: int

### Enumerations

**endpoint_mode**
- `chat_completions`
- `responses`

**response_shape_version** (recommended)
- `responses_v0_typed_sse_openai_json`
- `responses_v0_nonstream_openai_json`
- `chat_v0_sse_openai_json`
- `chat_v0_sse_obsidian_xml`

**stream_event_type taxonomy (Responses typed SSE)**
- `response.created`
- `response.output_text.delta`
- `response.output_text.done`
- `response.output_item.added`
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.output_item.done`
- `response.completed`
- `response.failed`
- `done`

**error_type normalization**
- `auth_error`
- `rate_limited`
- `timeout`
- `invalid_request`
- `upstream_error`
- `internal_error`

## 4) Instrumentation map (ingress → egress)

| Stage | Event name | File | Symbol | Emitted keys (minimum) | Notes |
|---|---|---|---|---|---|
| Ingress received | `responses_ingress_raw` | `src/handlers/responses/{stream,nonstream}.js` | `postResponsesStream/NonStream` | ids + output_mode + shape flags | Must run **before** `req.body` rewrite. |
| Transform start | `responses_transform_start` | `src/handlers/responses/{stream,nonstream}.js` | same | ids + stream + model | Optional, for latency profiling. |
| Upstream request start | `upstream_request_start` | _(backend callsite)_ | _(from audit)_ | ids + upstream_mode | No main change. |
| Streaming: per SSE event (Responses out) | `responses_sse_out` | `src/handlers/responses/stream-adapter.js` | `writeEvent()` | seq + type + delta_bytes | New per-event logs. |
| Tool args finalized | `tool_call_arguments_done` | `src/handlers/responses/stream-adapter.js` | `finalizeToolCalls()` | tool_call_id + json_valid | Emit once per tool. |
| Finalize (stream) | `responses.sse_summary` (extended) | `src/handlers/responses/stream-adapter.js` | `logEventSummary()` | status + finish_reasons + usage | Already exists; extend fields. |
| Finalize (non-stream) | `responses_nonstream_summary` | `src/handlers/responses/nonstream.js` | `transform()` | status + usage | Add once per success. |
| Egress sent | existing `client_json` / `client_sse` | `src/services/sse.js` | `logJsonResponse` / `sendSSE` | sanitized payload | Does not cover typed Responses SSE. |

## 5) Dev-only verbose mode (safe defaults)

### Env flag
- **Existing:** `PROXY_LOG_PROTO` (dev-only; default true in `PROXY_ENV=dev`) controls proto JSONL emission.  
  (`src/dev-logging.js`)
- **Add (recommended):** `PROXY_DEBUG_WIRE=1` to allow *small*, *truncated* previews of deltas/tool args for debugging.

### What it enables (only when `PROXY_DEBUG_WIRE=1`)
- `delta_preview` (max 160 chars) for `response.output_text.delta`
- `args_preview` (max 160 chars) only when `tool_args_json_valid=false`

### Guardrails
- Never log:
  - Authorization headers
  - API keys
  - full prompts, messages, tool outputs
- Always cap previews and indicate truncation.

### Helper code snippet (add to `src/services/logging/schema.js`)
```js
import crypto from "node:crypto";

export const shouldLogVerbose = () =>
  String(process.env.PROXY_DEBUG_WIRE || "").trim() === "1";

export const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");

export const preview = (value, maxLen = 160) => {
  const s = String(value || "");
  if (s.length <= maxLen) return { preview: s, truncated: false };
  return { preview: s.slice(0, maxLen - 1) + "…", truncated: true };
};
```

## 6) Minimal JSONL examples (end-to-end sequences)

> Examples assume `PROXY_LOG_PROTO=true` and show **new** events introduced by this spec.  
> (`request_id` = proxy req_id; `copilot_trace_id` propagated/created)

### A) Streaming text-only Responses request

```jsonl
{"event":"responses_ingress_raw","endpoint_mode":"responses","request_id":"req_01","copilot_trace_id":"cpt_01","route":"/v1/responses","method":"POST","stream":true,"output_mode_requested":null,"output_mode_effective":"openai-json","has_input":true,"has_tools":false}
{"event":"responses_sse_out","endpoint_mode":"responses","request_id":"req_01","copilot_trace_id":"cpt_01","route":"/v1/responses","stream":true,"stream_event_seq":1,"stream_event_type":"response.created","delta_bytes":null,"response_shape_version":"responses_v0_typed_sse_openai_json"}
{"event":"responses_sse_out","endpoint_mode":"responses","request_id":"req_01","copilot_trace_id":"cpt_01","route":"/v1/responses","stream":true,"stream_event_seq":2,"stream_event_type":"response.output_text.delta","delta_bytes":12,"response_shape_version":"responses_v0_typed_sse_openai_json"}
{"event":"responses_sse_out","endpoint_mode":"responses","request_id":"req_01","copilot_trace_id":"cpt_01","route":"/v1/responses","stream":true,"stream_event_seq":3,"stream_event_type":"response.completed","delta_bytes":null,"response_shape_version":"responses_v0_typed_sse_openai_json"}
{"event":"responses_sse_out","endpoint_mode":"responses","request_id":"req_01","copilot_trace_id":"cpt_01","route":"/v1/responses","stream":true,"stream_event_seq":4,"stream_event_type":"done","delta_bytes":null,"response_shape_version":"responses_v0_typed_sse_openai_json"}
{"event":"sse_summary","component":"responses","endpoint_mode":"responses","request_id":"req_01","copilot_trace_id":"cpt_01","route":"/v1/responses","status_emitted":"completed","finish_reasons":["stop"],"usage_input_tokens":120,"usage_output_tokens":34,"usage_total_tokens":154}
```

### B) Streaming Responses request with tool call + tool-result submission attempt

```jsonl
{"event":"responses_ingress_raw","endpoint_mode":"responses","request_id":"req_02","copilot_trace_id":"cpt_02","route":"/v1/responses","stream":true,"has_tools":true,"has_tool_output_items":true,"tool_output_bytes_total":512}
{"event":"responses_sse_out","endpoint_mode":"responses","request_id":"req_02","copilot_trace_id":"cpt_02","route":"/v1/responses","stream":true,"stream_event_seq":1,"stream_event_type":"response.output_item.added"}
{"event":"responses_sse_out","endpoint_mode":"responses","request_id":"req_02","copilot_trace_id":"cpt_02","route":"/v1/responses","stream":true,"stream_event_seq":2,"stream_event_type":"response.function_call_arguments.delta","delta_bytes":48}
{"event":"tool_call_arguments_done","endpoint_mode":"responses","request_id":"req_02","copilot_trace_id":"cpt_02","route":"/v1/responses","tool_call_id":"call_abc","tool_name":"search","tool_args_bytes":96,"tool_args_json_valid":true}
{"event":"responses_sse_out","endpoint_mode":"responses","request_id":"req_02","copilot_trace_id":"cpt_02","route":"/v1/responses","stream":true,"stream_event_seq":9,"stream_event_type":"response.completed"}
{"event":"responses_sse_out","endpoint_mode":"responses","request_id":"req_02","copilot_trace_id":"cpt_02","route":"/v1/responses","stream":true,"stream_event_seq":10,"stream_event_type":"done"}
{"event":"sse_summary","component":"responses","endpoint_mode":"responses","request_id":"req_02","copilot_trace_id":"cpt_02","route":"/v1/responses","status_emitted":"completed","finish_reasons":["tool_calls"],"usage_input_tokens":210,"usage_output_tokens":88,"usage_total_tokens":298}
```

## 7) Implementation checklist for Codex

- [x] **P0:** Ensure `request_id` (`req_id`) + `copilot_trace_id` exist in `res.locals` for all handlers.
- [x] **P1:** Add `responses_ingress_raw` in both Responses handlers **before** rewriting `req.body`.
- [x] **P1:** Log `output_mode_requested` + `output_mode_effective` (after `applyDefaultProxyOutputModeHeader`).
- [x] **P2:** Add per-event `responses_sse_out` logging in Responses stream adapter `writeEvent()` with `stream_event_seq`.
- [ ] **P3:** Add a single `stream_error_detected` log in chat stream error paths; set `adapter_failed_emitted` marker from adapter.
- [x] **P4:** Extend `responses.sse_summary` to include `usage_*` + `previous_response_id_hash`.
- [x] **P4:** Add `responses_nonstream_summary` in Responses non-stream transform after successful conversion.
- [x] **P5:** Emit `tool_call_arguments_done` once per tool call at `response.function_call_arguments.done`.
- [x] **P5:** In ingress summary, detect `tool_output` blocks and log `has_tool_output_items`.
- [ ] **P6:** (If not already present) add upstream request/response boundary logs; keep payload out.
- [x] Add **dev-only** verbose preview support behind `PROXY_DEBUG_WIRE=1` with strict caps.
