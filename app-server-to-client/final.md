# App-server → Client reverse trace (tool requests, tool outputs, and SSE shaping)

This document traces the **reverse direction**: starting from app-server tool request/output events and following how the proxy transforms them into client-visible responses. It emphasizes tool-call aggregation, obsidian-xml vs openai-json output shaping, and SSE framing differences between `/v1/chat/completions` and `/v1/responses`.

## Scope and framing

- **App-server** refers to the JSON-RPC worker spawned by the proxy.
- **Reverse trace** means we start at the worker’s tool request/output signals and follow the proxy’s transformation path to the final client response.
- **Key code citations** are inline as `path#function`.

## Reverse trace: app-server tool requests → client response

### Step A — App-server requests a tool call (JSON-RPC server request)

1. **Worker emits `item/tool/call`:** The transport layer treats JSON-RPC payloads with `method: "item/tool/call"` as server-initiated requests and validates required params (`callId`, `threadId`, `tool`). (`src/services/transport/index.js#handleServerRequest`)
2. **Proxy publishes `dynamic_tool_call_request`:** The transport layer emits a proxy-side notification event `codex/event/dynamic_tool_call_request` on the conversation context. (`src/services/transport/index.js#handleServerRequest`)

### Step B — Dynamic tool request → structured tool-call delta

3. **Stream event router maps to tool_calls delta:** When the stream router sees `dynamic_tool_call_request`, it builds a `tool_calls` delta using `buildToolCallDeltaFromDynamicRequest` and injects it as an `agent_message_delta`. (`src/handlers/chat/stream-event-router.js#createStreamEventRouter`, `src/lib/tools/dynamic-tools.js#buildToolCallDeltaFromDynamicRequest`)

### Step C — Tool-call aggregation (canonicalization)

4. **Tool-call aggregator merges fragments:** The aggregator accepts deltas from `tool_calls`, `function_call`, and (fallback) textual content. It assigns stable ids, supports parallel tool calls, and exposes `snapshot()` for final response shaping. (`src/lib/tool-call-aggregator.js#createToolCallAggregator`, `ingestDelta`, `ingestMessage`, `snapshot`, `supportsParallelCalls`)

### Step D — Endpoint-specific output shaping (client-visible)

#### /v1/chat/completions (stream)

5. **SSE envelope:** The proxy emits `chat.completion.chunk` frames with `choices[].delta` and ends with `[DONE]`. (`src/handlers/chat/stream.js#sendChunk`, `src/services/sse.js#finishSSE`)
6. **Tool-call deltas:** Aggregated tool calls can flow out as `delta.tool_calls`. (`src/handlers/chat/stream.js` toolCallAggregator usage)
7. **Obsidian XML mode (obsidian-xml):** The output coordinator detects `<use_tool>` tags in text, holds back partial tags, and emits XML tool blocks (either extracted from text or converted from structured tool calls). It can also stop streaming after tool emission. (`src/handlers/chat/stream-output.js#createStreamOutputCoordinator`, `src/handlers/chat/tool-output.js#buildCanonicalXml`)
8. **OpenAI JSON mode (openai-json):** Tool calls remain structured deltas; assistant content is not repackaged into XML. Output mode is determined by header/canonicalization logic. (`src/handlers/chat/shared.js#resolveOutputMode`)

#### /v1/chat/completions (nonstream)

9. **Assistant message construction:** The proxy builds `choices[].message` from aggregator snapshots. If tool calls exist:
   - obsidian-xml: `message.content` becomes canonical `<use_tool>` XML (or extracted blocks), with `message.tool_calls` still present.
   - openai-json: `message.content` becomes null; `message.tool_calls` carries the payload.
     (`src/handlers/chat/nonstream.js#buildAssistantMessage`, `src/handlers/chat/tool-output.js#buildCanonicalXml`)

#### /v1/responses (stream)

10. **Stream parsing → internal events:** `runNativeResponses` parses stdout into events such as `text_delta`, `tool_calls_delta`, `tool_calls`, `function_call_delta`, `usage`, and `finish`. (`src/handlers/responses/native/execute.js#runNativeResponses`)
11. **Typed SSE output:** The stream adapter writes typed SSE events: `response.created`, `response.output_text.delta`, `response.output_item.added`, `response.function_call_arguments.delta/done`, `response.output_item.done`, `response.completed`, then `done`. (`src/handlers/responses/stream-adapter.js#writeEvent`, `emitToolCallDeltas`, `finalize`)
12. **Tool-call parsing for text:** If enabled, a `<tool_call>` parser processes textual deltas and converts them into structured function calls. (`src/handlers/responses/stream-adapter.js` + `src/handlers/responses/tool-call-parser.js`)

#### /v1/responses (nonstream)

13. **Tool outputs returned to app-server:** Client request inputs can include `function_call_output` / `tool_output`. These are extracted into `toolOutputs` and immediately used to respond to pending app-server tool calls via JSON-RPC. (`src/handlers/responses/native/request.js#appendInputItem`, `src/handlers/responses/nonstream.js#respondToToolOutputs`)
14. **Final envelope:** Aggregated tool calls are combined with parsed `<tool_call>` blocks and included as function call items in the responses envelope. (`src/handlers/responses/nonstream.js`, `src/handlers/responses/native/envelope.js#buildResponsesEnvelope`)

## Output mode: obsidian-xml vs openai-json (chat-specific)

- **Mode resolution:** The chat endpoint canonicalizes output mode to `obsidian-xml` or `openai-json`, optionally using Copilot auto-detect. (`src/handlers/chat/shared.js#resolveOutputMode`)
- **obsidian-xml:** Tool calls are rendered as `<use_tool>` blocks, with optional dedupe/limits and tool-buffer logic that holds back partial tags. (`src/handlers/chat/tool-output.js#buildCanonicalXml`, `src/handlers/chat/stream-output.js#createStreamOutputCoordinator`)
- **openai-json:** Tool calls are emitted only as structured `tool_calls`; content may be null when tool calls are present. (`src/handlers/chat/nonstream.js#buildAssistantMessage`)

## SSE shaping details (chat vs responses)

- **Chat SSE**: single `chat.completion.chunk` envelope with `choices` and `delta`, no explicit `event:` field; ends with `data: [DONE]`. (`src/handlers/chat/stream.js#sendChunk`, `src/services/sse.js#finishSSE`)
- **Responses SSE**: each event includes `event: <name>` and `data: <json>`; includes granular tool-call events and lifecycle markers. (`src/handlers/responses/stream-adapter.js#writeEvent`, `src/services/sse.js#writeSseChunk`)

## Abnormalities / concerns

1. **Double-source tool calls can duplicate results.** In responses nonstream, `aggregatedCalls` and `parsedCalls` are concatenated without dedupe. If upstream emits both structured tool calls and textual `<tool_call>` blocks, duplicates can appear. (`src/handlers/responses/nonstream.js` near `functionCalls = [...aggregatedCalls, ...parsedCalls]`)
2. **Tag mismatch across endpoints.** Chat tooling expects `<use_tool>` while responses parsing expects `<tool_call>`, making mixed outputs brittle during migration and increasing the chance of missed tool parsing. (`src/handlers/chat/tool-output.js`, `src/handlers/responses/tool-call-parser.js`)
3. **Strict parsing failures can hard-fail streams.** The responses stream adapter emits `response.failed` when strict tool parsing fails; this can terminate streams even if text output is otherwise useful. (`src/handlers/responses/stream-adapter.js#shouldFailParserErrors`, `emitFailure`)
4. **Output-mode semantics diverge.** Chat uses Copilot auto-detection and a specific canonicalization table; responses uses a simpler header/default behavior. This can lead to different output shapes for the same caller. (`src/handlers/chat/shared.js#resolveOutputMode`, `src/handlers/responses/shared.js#resolveResponsesOutputMode`)
5. **Tool outputs only wired for responses.** Only `/v1/responses` accepts `tool_output`/`function_call_output` inputs and responds to app-server tool requests; chat does not, which can complicate parity in v2. (`src/handlers/responses/native/request.js#appendInputItem`, `src/handlers/responses/nonstream.js#respondToToolOutputs`)

## Recommendations

1. **Normalize tool-call tags across endpoints.** Either accept both `<use_tool>` and `<tool_call>` in parsing or introduce a translation layer before parsing. This reduces mismatch risk during migration.
2. **Deduplicate tool calls when merging sources.** Hash by `call_id` (or name+args) before combining `aggregatedCalls` + `parsedCalls` to prevent duplicate tool calls in responses output.
3. **Guard strict parsing errors behind a header/flag.** When strict parsing fails, fall back to emitting the textual tool block instead of failing the stream outright.
4. **Align output-mode semantics.** Unify chat and responses output-mode handling (headers, defaults, copilot detection), and document differences explicitly if they must remain.
5. **Add parity tests across endpoints.** Test structured tool_calls, textual tool blocks, and dynamic tool requests flowing through both chat and responses, including SSE framing and finish-reason behavior.

## Key references

- `src/services/transport/index.js` — #handleServerRequest, respondToToolCall
- `src/handlers/chat/stream-event-router.js` — createStreamEventRouter
- `src/lib/tools/dynamic-tools.js` — buildToolCallDeltaFromDynamicRequest
- `src/lib/tool-call-aggregator.js` — createToolCallAggregator, ingestDelta/ingestMessage/snapshot
- `src/handlers/chat/tool-output.js` — buildCanonicalXml, extractTextualUseToolBlock
- `src/handlers/chat/stream-output.js` — createStreamOutputCoordinator
- `src/handlers/chat/stream.js` — sendChunk/buildChoiceFrames
- `src/services/sse.js` — writeSseChunk, finishSSE
- `src/handlers/responses/native/execute.js` — runNativeResponses
- `src/handlers/responses/stream-adapter.js` — writeEvent, emitToolCallDeltas, finalize
- `src/handlers/responses/tool-call-parser.js` — parseToolCallText
- `src/handlers/responses/native/request.js` — appendInputItem
- `src/handlers/responses/nonstream.js` — respondToToolOutputs, functionCalls merge
- `src/handlers/responses/native/envelope.js` — buildResponsesEnvelope
- `src/handlers/responses/shared.js` — resolveResponsesOutputMode
