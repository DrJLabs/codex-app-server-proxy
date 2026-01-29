# App-server → Client reverse trace (draft)

## Scope

This doc traces the reverse path from app-server tool request/output events through proxy transformations to the client response, focusing on tool-call aggregation, obsidian-xml vs openai-json handling, and SSE shaping. Code citations are inline by file path + key function.

## Reverse trace overview (app-server → proxy → client)

### 1) App-server emits tool call request (JSON-RPC server request)

- The worker sends a JSON-RPC server request with `method: "item/tool/call"` and params containing `callId`, `threadId`, and tool info. The transport handler validates the params and then emits a proxy-side notification `codex/event/dynamic_tool_call_request` via the per-conversation context emitter. (Ref: `src/services/transport/index.js` #handleServerRequest)

### 2) Proxy maps dynamic tool requests to tool-call deltas

- Stream event routing recognizes `dynamic_tool_call_request` and converts it to a `tool_calls` delta using `buildToolCallDeltaFromDynamicRequest`, then routes it as an `agent_message_delta`. This effectively injects a structured tool-call delta into downstream handlers. (Ref: `src/handlers/chat/stream-event-router.js` createStreamEventRouter; `src/lib/tools/dynamic-tools.js` buildToolCallDeltaFromDynamicRequest)

### 3) Tool-call aggregation normalizes and snapshots

- The tool-call aggregator merges fragments across event types (`tool_calls`, `function_call`, textual content) into canonical tool-call snapshots and deltas. It assigns ids when missing, detects parallel tool support, and exposes `snapshot()` for final response shaping. (Ref: `src/lib/tool-call-aggregator.js` createToolCallAggregator/ingestDelta/ingestMessage/snapshot)

### 4) Client response shaping differs by endpoint + output mode

#### /v1/chat/completions (stream)

- **SSE envelope:** The stream emits `chat.completion.chunk` with `choices[].delta` payloads; stream finishes with `[DONE]`. (Ref: `src/handlers/chat/stream.js` sendChunk/buildChoiceFrames, `src/services/sse.js` sendSSE/finishSSE)
- **Tool-call path:** Structured tool-call deltas from the aggregator are emitted as `tool_calls` entries in `delta` frames. Textual `<use_tool>` blocks are detected and optionally forwarded as XML in obsidian mode; the stream output coordinator holds back partial tool tags and can stop after tools. (Ref: `src/handlers/chat/stream-output.js` createStreamOutputCoordinator; `src/handlers/chat/stream.js` toolCallAggregator usage)
- **Obsidian XML vs OpenAI JSON:** Output mode (obsidian-xml vs openai-json) influences whether assistant content is XML `<use_tool>` blocks or null content with tool_calls. (Ref: `src/handlers/chat/shared.js` resolveOutputMode, `src/handlers/chat/stream-output.js`)

#### /v1/chat/completions (nonstream)

- **Tool-call summary:** Tool-call aggregator snapshots are used to build the assistant message. If tool calls are present and output mode is obsidian-xml, content is canonical XML derived from tool calls or extracted `<use_tool>` blocks; openai-json output sets content null (tool_calls only). (Ref: `src/handlers/chat/nonstream.js` buildAssistantMessage, `src/handlers/chat/tool-output.js` buildCanonicalXml/extractTextualUseToolBlock)

#### /v1/responses (stream)

- **SSE envelope:** The responses stream adapter emits typed events (`response.created`, `response.output_text.delta`, `response.output_item.added`, `response.function_call_arguments.delta/done`, `response.output_item.done`, `response.completed`, `done`). (Ref: `src/handlers/responses/stream-adapter.js` writeEvent/emitTextDelta/emitToolCallDeltas/finalize)
- **Tool-call path:** `runNativeResponses` parses worker lines into events (text/tool_calls/function_call/usage/finish). The stream adapter uses tool-call aggregation and a `<tool_call>` parser for text deltas when enabled. (Ref: `src/handlers/responses/native/execute.js` runNativeResponses; `src/handlers/responses/stream-adapter.js` handleEvent + toolCallParser)

#### /v1/responses (nonstream)

- **Tool output responses:** Client can pass `function_call_output` / `tool_output` in request input; these are converted into `toolOutputs` and immediately used to respond to pending app-server tool calls via JSON-RPC. (Ref: `src/handlers/responses/native/request.js` appendInputItem; `src/handlers/responses/nonstream.js` respondToToolOutputs)
- **Tool-call summary:** Nonstream combines aggregator snapshots with parsed `<tool_call>` blocks embedded in output text; these are put into `output` as `function_call` items in the responses envelope. (Ref: `src/handlers/responses/nonstream.js` toolCallAggregator + parseToolCallText; `src/handlers/responses/tool-call-parser.js`)

## Abnormalities / concerns

- **Dual sources can double emit tool calls.** Both structured tool_calls and textual parsing are merged; in responses nonstream, the code concatenates `aggregatedCalls + parsedCalls` without dedupe. This can produce duplicates if upstream emits both. (Ref: `src/handlers/responses/nonstream.js` around `functionCalls = [...aggregatedCalls, ...parsedCalls]`)
- **Tag mismatch between chat and responses.** Chat expects `<use_tool>` blocks for obsidian-xml, while responses text parser expects `<tool_call>` tags. Mixed usage may lead to missed parsing or duplicated content during migration. (Ref: `src/handlers/chat/tool-output.js`, `src/handlers/responses/tool-call-parser.js`)
- **Strict tool parsing can fail streams.** The responses stream adapter can hard-fail on strict tool-call parse errors, emitting `response.failed`/`done` prematurely. (Ref: `src/handlers/responses/stream-adapter.js` shouldFailParserErrors/emitFailure)
- **Output-mode semantics diverge.** Chat uses copilot auto-detect and output-mode canonicalization; responses uses a default header override without copilot auto-detect. This creates different behavior for the same headers in v2. (Ref: `src/handlers/chat/shared.js` resolveOutputMode; `src/handlers/responses/shared.js` resolveResponsesOutputMode)
- **Tool outputs wired only for responses.** Tool outputs (`function_call_output`/`tool_output`) are parsed and returned to app-server only in responses flow; chat flow has no equivalent path, so parity may be limited. (Ref: `src/handlers/responses/native/request.js` + `src/handlers/responses/nonstream.js` respondToToolOutputs)

## Recommendations

1. **Unify tool-call text conventions** across endpoints (choose `<use_tool>` or `<tool_call>` and accept both for migration) to avoid missing tool calls. Consider a shared parser or tag translation layer.
2. **Deduplicate tool calls** when merging structured and textual sources. Use call-id/name+args hashing before combining snapshots.
3. **Harden strict parsing failure handling** by logging + fallback to textual content rather than failing the stream outright, or gate strict mode behind an explicit header.
4. **Align output-mode semantics** between chat and responses (headers, defaults, copilot auto-detect) to avoid migration surprises.
5. **Add parity tests** for mixed tool-call sources and SSE shaping: structured tool_calls + textual blocks + dynamic_tool_call_request should yield identical output across endpoints.
