# OpenAI Endpoint Parity & Golden Transcripts — **Canonical Spec Companion**

[Verified][HighConf][Spec] • Last updated: 2025-10-25

> **Scope**: This document provides a **precise, canonical** description and **golden transcripts** for the OpenAI endpoints you’re most likely to proxy for compatibility:
>
> - **`POST /v1/responses`** (primary API for text, tools, streaming)
> - **`POST /v1/chat/completions`** (legacy but **still supported**)
> - **Server‑Sent Events (SSE)** streaming shapes for both
> - **Function / tool calling** envelopes
> - **Error** and **usage** objects
>
> All formats and examples are grounded in OpenAI’s **official documentation & SDKs** and are suitable as **test fixtures** for conformance.

---

## 0) Canonical sources

Use these to resolve any ambiguities; they are the primary, authoritative references cited throughout this document.

- **OpenAI Developer blog — “Why we built the Responses API”** (context, design goals, typed streaming notion). citeturn2search1
- **OpenAI product note — “New tools and features in the Responses API”** (feature set & direction). citeturn2search6
- **Help Center — Chat Completions overview** (parameters, usage notes). citeturn2search0
- **Help Center — Migrate from Chat Completions to Responses** (field mapping & guidance). citeturn2search3
- **Official SDKs (generated from OpenAPI)** — canonical request/response types & examples:
  - **openai‑node** README + API notes (responses, chat, streaming, webhooks, request IDs). citeturn5view0
  - **openai‑python** README (responses & chat usage; streaming over SSE). citeturn13view0
  - **openai‑openapi** repo (pointer to authoritative OpenAPI spec). citeturn15search1
- **Help Center — Function Calling** (tool‑calling semantics & JSON mode). citeturn17view0
- **Help Center — API Error codes** and **429 rate‑limit guidance** (error classes & handling). citeturn12view0turn11search4

> **Note**: The official SDKs are **generated from OpenAI’s OpenAPI spec**; they are dependable for parameter/shape names and are a practical ground truth for envelope structure. citeturn5view0turn13view0

---

## 1) Endpoints at a glance

| Endpoint                    | Status                 | Primary use                                                    | Notes                                                                                                               |
| --------------------------- | ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/responses`        | **Primary**            | Text generation, tools, structured output, **typed streaming** | Recommended for new builds; this proxy accepts `previous_response_id` but does not persist/echo it. citeturn2search1turn5view0 |
| `POST /v1/chat/completions` | **Supported (legacy)** | Chat messages array + function calling                         | Still widely used; OpenAI recommends starting new work on **Responses**. citeturn5view0turn2search3             |

---

## 2) **`POST /v1/responses`** — request

### 2.1 Minimum request

```jsonc
POST /v1/responses
Content-Type: application/json
Authorization: Bearer $OPENAI_API_KEY

{
  "model": "gpt-4o",
  "input": "Write a one-sentence bedtime story about a unicorn."
}
```

- `model` — required model ID (e.g., `gpt-4o`). citeturn13view0
- `input` — either a **string** or an **array of content items** (for multi‑modal/structured inputs). citeturn13view0

### 2.2 Common fields (subset)

| Field                  | Type        | Purpose                                                                                           |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `instructions`         | string      | System/developer‑level steerage. citeturn5view0                                                |
| `max_output_tokens`    | int         | Upper bound on generated tokens (maps from `max_tokens` in Chat Completions). citeturn2search3 |
| `temperature`, `top_p` | number      | Sampling controls. citeturn2search0                                                            |
| `tools`                | array       | Built‑in tools or **custom functions** (JSON Schema definitions). citeturn2search6turn17view0 |
| `tool_choice`          | enum/object | `auto`/`none`/specific function selection. citeturn17view0                                     |
| `previous_response_id` | string      | Links a new turn to the last response for OpenAI server-side state; this proxy accepts it but does not persist/echo. citeturn2search1              |
| `store`                | boolean     | Opts server‑side storage in/out for tracing/evals. citeturn2search1                            |
| `stream`               | boolean     | Enable SSE **typed events** stream. citeturn5view0                                             |

> See **§6 Mapping** for field parity with Chat Completions. citeturn2search3

---

## 3) **`/v1/responses`** — non‑streaming response

### 3.1 Representative envelope

```jsonc
{
  "id": "resp_abc123",
  "status": "completed", // terminal states: completed | failed | incomplete
  "model": "gpt-4o-2024-08-06",
  "output": [
    {
      "id": "msg_123",
      "type": "message",
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "Under the soft glow of the moon, Luna the unicorn..." },
      ],
    },
  ],
  "usage": {
    "input_tokens": 12,
    "output_tokens": 24,
    "total_tokens": 36,
  },
}
```

**Notes**

- Official SDKs expose a convenience `response.output_text` which aggregates text across `output` items; use it for simple cases. Shapes are defined by the OpenAPI spec and reflected in SDK types. citeturn5view0turn13view0turn15search1

---

## 4) **`/v1/responses`** — **SSE typed streaming**

When `stream: true`, the server emits **typed events** over SSE. Clients iterate event objects (SDKs) or parse raw SSE frames.

### 4.1 Minimal JS client (SDK)

```ts
import OpenAI from "openai";
const client = new OpenAI();
const stream = await client.responses.create({ model: "gpt-4o", input: "…", stream: true });
for await (const event of stream) console.log(event);
```

citeturn5view0

### 4.2 Event taxonomy (representative)

The following event names are surfaced by official SDKs and webhooks. Handle at least **text deltas** and **terminal events**:

- `response.created` → stream begins (also used in webhooks). citeturn6view0
- `response.output_text.delta` → incremental text; concatenate in order. citeturn4search3
- `response.output_text.done` → text segment finished. citeturn4search3
- `response.completed` → final response object ready. citeturn6view0
- `error` or `response.failed` → terminal failure. citeturn6view0

### 4.3 Golden SSE transcript (text only)

```
event: response.created
data: {"type":"response.created","response":{"id":"resp_abc123","status":"in_progress"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Under the soft glow "}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"of the moon, Luna…"}

event: response.output_text.done
data: {"type":"response.output_text.done"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_abc123","status":"completed","usage":{"input_tokens":12,"output_tokens":24,"total_tokens":36}}}

event: done
data: [DONE]
```

> Webhook payloads also use `response.completed`/`response.failed` and can be signature‑verified with SDK helpers. citeturn6view0

---

## 5) **`POST /v1/chat/completions`** — request & responses

### 5.1 Minimum request

```jsonc
POST /v1/chat/completions

{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are concise." },
    { "role": "user", "content": "Say this is a test" }
  ]
}
```

- Standard chat roles; many SDK examples also show a `developer` role for system‑level steerage. citeturn13view0

### 5.2 Non‑streaming response (representative)

```jsonc
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "gpt-4o-2024-08-06",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "This is a test." },
      "finish_reason": "stop",
    },
  ],
  "usage": { "prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13 },
}
```

citeturn13view0

### 5.3 Function/tool calling (non‑streaming)

```jsonc
{
  "id": "chatcmpl-xyz",
  "object": "chat.completion",
  "created": 1730001234,
  "model": "gpt-4o-2024-08-06",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "tool_calls": [
          {
            "id": "call_001",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"Nashville\",\"unit\":\"F\"}",
            },
          },
        ],
      },
      "finish_reason": "tool_calls",
    },
  ],
  "usage": { "prompt_tokens": 37, "completion_tokens": 12, "total_tokens": 49 },
}
```

- Tool calling is supported in Chat Completions and Assistants; JSON‑mode/Structured‑Outputs notes apply. citeturn17view0

### 5.4 Streaming (SSE) — golden chunk pattern

The server emits `chat.completion.chunk` frames; the **delta** is the changing part of the assistant message. A typical chunk looks like:

```jsonc
data: {
  "id": "chatcmpl-abc123",
  "object": "chat.completion.chunk",
  "created": 1730000001,
  "model": "gpt-4o-2024-08-06",
  "choices": [{
    "index": 0,
    "delta": { "content": "Thi" },
    "finish_reason": null
  }]
}
```

…and later:

```jsonc
data: { "choices": [{ "index": 0, "delta": { "content": "s is a test." }, "finish_reason": "stop" }] }
data: [DONE]
```

- SDKs expose helpers for streaming; you can also consume raw SSE. citeturn5view0

---

## 6) **Field mapping: Chat Completions → Responses**

| Chat Completions                 | Responses                  | Notes                                                         |
| -------------------------------- | -------------------------- | ------------------------------------------------------------- |
| `messages: [{role, content}, …]` | `input: string \| items[]` | Single string or an array of typed parts. citeturn13view0  |
| `system`/`developer` message     | `instructions`             | Move steerage here. citeturn5view0                         |
| `max_tokens`                     | `max_output_tokens`        | Semantics unchanged. citeturn2search3                      |
| `tools` (functions)              | `tools` + `tool_choice`    | JSON Schema functions supported in both. citeturn17view0   |
| `stream: true`                   | `stream: true`             | SSE in both; **typed events** in Responses. citeturn5view0 |
| (n/a)                            | `previous_response_id`     | Optional OpenAI server-side conversation state (proxy accepts but is stateless). citeturn2search1  |

> For larger migrations, see the **Completions → Responses Migration Pack**. citeturn21search0

---

## 7) Errors & usage

### 7.1 Error envelope (representative)

```jsonc
HTTP/1.1 429 Too Many Requests
{
  "error": {
    "message": "Rate limit reached for gpt-4o …",
    "type": "rate_limit_error",
    "param": null,
    "code": "rate_limit_exceeded"
  }
}
```

- 429 handling & examples are documented in the Help Center; use **exponential backoff** and surface the **request ID** for support. SDKs expose `_request_id` on responses. citeturn11search4turn5view0

### 7.2 Usage object

- **Chat Completions**: `usage = { prompt_tokens, completion_tokens, total_tokens }`.
- **Responses**: `usage = { input_tokens, output_tokens, total_tokens, … }`.  
  SDK examples and types reflect these fields. citeturn13view0

---

## 8) Golden transcripts (copy-ready)

> **How to use**: Treat these as fixtures in integration tests for your proxy. The JSON is representative of **real** shapes and field names from official SDKs/spec.
> Capture scripts: `scripts/generate-chat-transcripts.mjs` and `scripts/generate-responses-transcripts.mjs` regenerate fixtures under `test-results/chat-completions/` and `test-results/responses/`, normalizing IDs/timestamps for contract tests.

### 8.1 Capture workflow (app-server only)

Use this procedure whenever you refresh fixtures for `/v1/chat/completions`:

1. **Regenerate transcripts**
   ```bash
   npm run transcripts:generate
   ```
   This writes deterministic outputs to `test-results/chat-completions/app/`, embedding metadata such as `backend`, `backend_storage`, `codex_bin`, `cli_version`, `node_version`, and the repo `commit` SHA in each file while refreshing the manifest at `test-results/chat-completions/manifest.json` with scenario coverage details.
2. **Record baseline versions** – note the Codex CLI/App Server build used for capture (the values are stamped in the `metadata` block of every transcript and summarized in `manifest.json`). Copy these into the release notes or migration runbook when updating fixtures.
3. **Smoke the stack** – execute `npm run test:integration` and `npm test` before publishing refreshed transcripts to guarantee the Epic 1 baseline remains healthy.

> Tip: If a deliberate mismatch is required for debugging, edit a single transcript to observe failure output in the integration suite, then regenerate fixtures with `npm run transcripts:generate` to restore the canonical corpus.

### GT‑1 — Responses (non‑streaming, text only)

```jsonc
REQUEST:
POST /v1/responses
{
  "model": "gpt-4o",
  "input": "Write a one-sentence bedtime story about a unicorn."
}

RESPONSE 200:
{
  "id": "resp_abc123",
  "status": "completed",
  "model": "gpt-4o-2024-08-06",
  "output": [
    {
      "id": "msg_123",
      "type": "message",
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "Under the soft glow of the moon, Luna the unicorn…" }
      ]
    }
  ],
  "usage": { "input_tokens": 12, "output_tokens": 24, "total_tokens": 36 }
}
```

### GT‑2 — Responses (SSE typed streaming, text only)

```
REQUEST:  stream=true

event: response.created
data: {"type":"response.created","response":{"id":"resp_abc123","status":"in_progress"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Under the soft glow "}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"of the moon, Luna…"}

event: response.output_text.done
data: {"type":"response.output_text.done"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_abc123","status":"completed"}}

event: done
data: [DONE]
```

### GT‑3 — Chat Completions (non‑streaming with tool call)

```jsonc
REQUEST:
POST /v1/chat/completions
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "Use the weather tool when asked about weather." },
    { "role": "user", "content": "What is the weather in Nashville in F?" }
  ],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get the current weather",
      "parameters": { "type": "object", "properties": { "city": {"type":"string"}, "unit": {"type":"string"} }, "required": ["city","unit"] }
    }
  }],
  "tool_choice": "auto"
}

RESPONSE 200:
{
  "id": "chatcmpl-xyz",
  "object": "chat.completion",
  "created": 1730001234,
  "model": "gpt-4o-2024-08-06",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_001",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"Nashville\",\"unit\":\"F\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": { "prompt_tokens": 37, "completion_tokens": 12, "total_tokens": 49 }
}
```

### GT‑4 — Chat Completions (SSE streaming, text only)

```
REQUEST:  stream=true

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1730000001,"model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{"content":"Thi"},"finish_reason":null}]}
data: {"choices":[{"index":0,"delta":{"content":"s is a test."},"finish_reason":"stop"}]}
data: [DONE]
```

---

## 9) Implementation checklist for **OpenAI‑compatible proxies**

- **HTTP**: Support JSON body POST; set/forward `Authorization: Bearer` header; preserve and pass through `x-request-id` for diagnostics. citeturn5view0
- **Streaming**:
  - Chat: emit **SSE** frames using the `chat.completion.chunk` delta pattern, terminating with `[DONE]`.
  - Responses: emit **typed SSE** events (`response.*`) and terminate with `event: done` / `[DONE]`. citeturn5view0turn6view0
- **Tool calls**: Preserve envelope (`tool_calls` in Chat; `tools` + `tool_choice` in requests; stream function **arguments** when applicable). citeturn17view0
- **Usage**: Populate `usage` with token counts matching the endpoint’s field names. citeturn13view0
- **Errors**: Return OpenAI‑style `{ "error": { message, type, param, code } }` with proper HTTP status; apply **exponential backoff** on 429. Expose/log request IDs. citeturn11search4turn5view0

---

## 10) Quick test commands (mutually‑exclusive; pick one per test)

**cURL — Chat (non‑streaming)**

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "model":"gpt-4o", "messages":[{"role":"user","content":"Say this is a test"}] }'
```

**cURL — Chat (streaming)**

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "model":"gpt-4o", "stream":true, "messages":[{"role":"user","content":"Say this is a test"}] }'
```

**cURL — Responses (non‑streaming)**

```bash
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "model":"gpt-4o", "input":"Say this is a test" }'
```

**cURL — Responses (streaming)**

```bash
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "model":"gpt-4o", "input":"Say this is a test", "stream":true }'
```

---

## 11) Versioning & model notes

- **Chat Completions** remains supported; **Responses** is the default recommendation going forward. Prefer **Responses** for new integrations and for advanced tool/streaming workflows. citeturn5view0turn2search1
- The SDKs are **generated from OpenAPI**; when in doubt, check SDK types or the OpenAPI spec linked from `openai-openapi`. citeturn5view0turn15search1

---

### Appendix A — Webhook verification (Responses)

Use `client.webhooks.unwrap()` (Node SDK) to verify signatures and parse events like `response.completed` / `response.failed`. citeturn6view0

---

**End of spec companion.**
