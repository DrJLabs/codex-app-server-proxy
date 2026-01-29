# Responses (openai-json) client entry -> app-server JSON-RPC handoff

## Scope
This trace documents the `/v1/responses` path when running **openai-json output mode** and sending traffic to the Codex app-server JSON-RPC backend. It focuses on how the proxy translates client input into app-server schema fields (`dynamicTools`, `developerInstructions`, `items`) and where the JSON-RPC handoff happens. Schema references are based on `docs/reference/app-server-schema-0.92-full.md`.

## High-level flow (request path)
1. **Ingress + middleware**
   - Express app wiring + global middleware (`metrics`, `tracing`, CORS, access log, JSON body parsing). See `src/app.js` and `src/middleware/access-log.js`.
   - Access log establishes request ids and Copilot trace detection via `ensureCopilotTraceContext` and header-only `detectCopilotRequest`. (`src/middleware/access-log.js`, `src/lib/trace-ids.js`, `src/lib/copilot-detect.js`).

2. **Route entrypoint**
   - `POST /v1/responses` is handled by `responsesRouter`, which enforces strict auth, optional title/summary intercept, and routes to stream/non-stream handlers. (`src/routes/responses.js`, `src/handlers/responses/title-summary-intercept.js`).

3. **Output mode selection (openai-json)**
   - Output mode is resolved from `x-proxy-output-mode` header or `PROXY_RESPONSES_OUTPUT_MODE` default. (`src/handlers/responses/shared.js`, `src/handlers/responses/stream.js`, `src/handlers/responses/nonstream.js`).
   - `createResponsesStreamAdapter` and non-stream response builders emit openai-json shapes (see `src/handlers/responses/stream-adapter.js`, `src/handlers/responses/nonstream.js`).

4. **Ingress summary + capability checks**
   - The request body is summarized/logged via `summarizeResponsesIngress` and `logResponsesIngressRaw`, then checked for tool capabilities with `ensureResponsesCapabilities`. (`src/handlers/responses/ingress-logging.js`, `src/handlers/responses/native/capabilities.js`).

5. **Normalization to JSON-RPC turn/message**
   - `normalizeResponsesRequest()` converts `/v1/responses` input into:
     - `inputItems` (`InputItem[]`) suitable for JSON-RPC `sendUserTurn` / `sendUserMessage`.
     - `developerInstructions` (built from `instructions` + system/developer messages inside `input` items).
     - `tools`, `toolChoice`, `parallelToolCalls`, `finalOutputJsonSchema`, etc.
   - See `src/handlers/responses/native/request.js`.

6. **JSON-RPC handoff**
   - Handlers build `turn` + `message` payloads and pass them to `createJsonRpcChildAdapter()`. (`src/handlers/responses/stream.js`, `src/handlers/responses/nonstream.js`, `src/services/transport/child-adapter.js`).
   - Adapter calls transport to:
     - `newConversation` + `sendUserTurn` (conversation-scoped params)
     - `sendUserMessage` (per-message params)
   - Transport uses schema builders (see `docs/reference/app-server-schema-0.92-full.md` for field definitions; implementation in `src/lib/json-rpc/schema.ts`).

## Translation to app-server schema

### Mapping overview
| Client/source | Normalized field | JSON-RPC param | Implementation |
| --- | --- | --- | --- |
| `input` (string) | `inputItems` (text item) | `sendUserTurn.items`, `sendUserMessage.items` | `normalizeResponsesRequest()` -> `{ type: "text", data: { text } }` (`src/handlers/responses/native/request.js`) |
| `input` (array of `message` items) | `inputItems` (text/image items + role anchors) | `sendUserTurn.items`, `sendUserMessage.items` | `appendInputItem()` + `appendMessageContent()` (`src/handlers/responses/native/request.js`) |
| `instructions` and system/developer messages inside `input` | `developerInstructions` | `newConversation.developerInstructions` | `developerInstructionsParts` -> `turn.developerInstructions` (`src/handlers/responses/native/request.js`, `src/handlers/responses/stream.js`, `src/handlers/responses/nonstream.js`) |
| `tools[]` (type=function only) + `tool_choice` | `dynamicTools` | `newConversation.dynamicTools` | `splitResponsesTools()` + `buildDynamicTools()` -> `turn.dynamicTools` (`src/handlers/responses/shared.js`, `src/lib/tools/dynamic-tools.js`, `src/handlers/responses/stream.js`) |
| `text.format` / `response_format` inputs | `responseFormat`, `finalOutputJsonSchema` | `sendUserMessage.responseFormat`, `sendUserMessage.finalOutputJsonSchema` | `normalizeResponseFormat()` in `normalizeResponsesRequest()` -> `message.*` (`src/handlers/responses/native/request.js`, `src/lib/json-rpc/schema.ts`) |

### Schema anchors (app-server 0.92)
Use `docs/reference/app-server-schema-0.92-full.md` to validate the JSON-RPC fields referenced above:
- `NewConversationParams` for `dynamicTools`, `developerInstructions`, and conversation-scoped config.
- `SendUserTurnParams` and `SendUserMessageParams` for `items`, `responseFormat`, `finalOutputJsonSchema`, etc.

## Abnormalities / concerns
1. **`instructions` are not passed as `baseInstructions`**
   - `normalizeResponsesRequest()` stores `instructions` but the handlers only forward `developerInstructions` into the JSON-RPC turn. There is no `baseInstructions` assignment for `/v1/responses`. (`src/handlers/responses/native/request.js`, `src/handlers/responses/stream.js`, `src/handlers/responses/nonstream.js`).
   - Risk: `instructions` are effectively treated as developer instructions and may not match upstream expectations if `baseInstructions` is required in app-server 0.92.

2. **Role + tool items are flattened into text (lossy + irreversible)**
   - `input` items of type `message`, `function_call`, and `tool_output` are converted into *plain text lines* like `[role] ...` or `[function_call ...]`, then aggregated into `InputItem` text blocks via `flushText()`. (`src/handlers/responses/native/request.js`).
   - Images are emitted as standalone `InputItem` images after injecting a role anchor line (e.g., `[user]`), which **drops the original message container** and any structured fields.
   - **Impact:** the app-server never sees structured message boundaries, tool-call objects, or tool-output objects; it only sees a flattened transcript. This is irreversible—there is no way for the app-server to reconstruct the original `/v1/responses` `input[]` structure.
   - **Risk:** tooling, audit, or safety logic that expects structured `message` / `tool_output` items will be blind to those structures, and any downstream tooling that parses text to recover tool calls is inherently brittle.

3. **Native (non-function) tools are not forwarded**
   - Only function tools are converted into `dynamicTools`; non-function tools are kept as "native" and used for capability checks, but not sent in JSON-RPC `dynamicTools`. (`src/handlers/responses/shared.js`, `src/handlers/responses/stream.js`).
   - Risk: app-server never sees non-function tool definitions even if the client requests them.

4. **Schema version mismatch**
   - Code currently uses `src/lib/json-rpc/schema.ts` (generated from older protocol) while the reference doc is `app-server-schema-0.92-full.md`. (`src/lib/json-rpc/schema.ts`, `docs/reference/app-server-schema-0.92-full.md`).
   - Risk: fields or validation rules could drift; confirm `developerInstructions`/`dynamicTools` semantics are unchanged in 0.92.

## Recommendations
1. **Confirm `instructions` routing against 0.92 schema**
   - If 0.92 expects `baseInstructions` for system-level guidance, add explicit mapping (or document why `developerInstructions` is the intended target).

2. **Document the lossy `input` flattening contract**
   - Add a note in `docs/api/responses.md` or cross-link here explaining how `/v1/responses` inputs become text `InputItem` entries.

3. **Clarify non-function tool behavior**
   - If native tools should reach app-server, extend mapping to forward them or surface a validation error when present.

4. **Align schema references**
   - Regenerate `src/lib/json-rpc/schema.ts` from the 0.92 bundle or explicitly document the delta between the local schema and `docs/reference/app-server-schema-0.92-full.md`.
