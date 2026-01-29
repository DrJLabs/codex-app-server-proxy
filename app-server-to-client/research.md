# Research notes (code citations)

## Transport + tool request/output

- App-server sends tool requests as JSON-RPC server requests with `method: "item/tool/call"` and required params (callId/threadId/tool). Proxy maps this to a dynamic tool request event (`codex/event/dynamic_tool_call_request`) emitted on the per-conversation context. Source: `src/services/transport/index.js` (#handleServerRequest, respondToToolCall).
- Tool outputs are sent back to the app-server by `respondToToolCall(callId, { output, success })`, which writes a JSON-RPC response to the worker and clears `pendingToolCalls`. Source: `src/services/transport/index.js` (respondToToolCall).

## Stream event parsing + routing

- Stream lines are JSON-parsed and normalized into `{ type, payload, params, messagePayload }`, stripping `codex/event/` prefixes. Source: `src/handlers/chat/stream-event.js` (parseStreamEventLine).
- Stream event router handles `dynamic_tool_call_request` by building a tool_calls delta (name + arguments + callId) and then routes that as an agent message delta. Source: `src/handlers/chat/stream-event-router.js` (createStreamEventRouter, buildToolCallDeltaFromDynamicRequest).

## Tool call aggregation

- Aggregator merges tool fragments from tool_calls, function_call, and (fallback) text content, building canonical tool call deltas and snapshots. It tracks parallel tool call support and emits generated ids when missing. Source: `src/lib/tool-call-aggregator.js` (createToolCallAggregator, ingestDelta, ingestMessage, snapshot, supportsParallelCalls).
- Textual tool-call parsing for Obsidian uses `<use_tool>` tags and builds canonical XML from tool call records. Source: `src/lib/tool-call-aggregator.js` (extractUseToolBlocks) + `src/lib/tools/obsidianToolsSpec.js` (toObsidianXml).

## Chat endpoint output modes

- Output mode normalization maps obsidian/openai variants to canonical `obsidian-xml` or `openai-json`. Source: `src/handlers/chat/shared.js` (resolveOutputMode, OUTPUT_MODE_CANON).
- Nonstream chat builds assistant message: if tool calls present, `obsidian-xml` uses canonical XML content (or extracts text blocks), while `openai-json` clears content (tool_calls only). Source: `src/handlers/chat/nonstream.js` (buildAssistantMessage).
- Streaming chat uses `createStreamOutputCoordinator` to hold back partial `<use_tool>` tags, emit XML tool blocks from either textual content or aggregated tool calls, and optionally stop after tools. Source: `src/handlers/chat/stream-output.js` (createStreamOutputCoordinator).
- Chat SSE framing: emits `chat.completion.chunk` envelopes with `choices[].delta` and `[DONE]` termination. Source: `src/handlers/chat/stream.js` (sendChunk/buildChoiceFrames + sendSSE/finishSSE) and `src/services/sse.js` (sendSSE/finishSSE).

## Responses endpoint (stream)

- Responses stream uses `runNativeResponses` to parse stdout lines, emitting `text_delta`, `tool_calls_delta`, `tool_calls`, `function_call_delta`, `usage`, and `finish` events. Source: `src/handlers/responses/native/execute.js` (runNativeResponses).
- Stream adapter converts events into typed SSE events: `response.created`, `response.output_text.delta`, `response.output_item.added`, `response.function_call_arguments.delta/done`, `response.output_item.done`, `response.completed`, `done`. Source: `src/handlers/responses/stream-adapter.js` (writeEvent + emitToolCallDeltas/finalizeToolCalls/emitTextDelta).

## Responses endpoint (nonstream)

- Normalization captures client-provided `function_call_output` / `tool_output` items from request input; these are used to respond to app-server tool requests via JSON-RPC. Source: `src/handlers/responses/native/request.js` (appendInputItem + toolOutputs), `src/handlers/responses/nonstream.js` (respondToToolOutputs).
- Nonstream combines structured tool_calls from aggregator with parsed `<tool_call>` blocks embedded in output text. Source: `src/handlers/responses/nonstream.js` (toolCallAggregator + parseToolCallText), `src/handlers/responses/tool-call-parser.js` (parseToolCallText).
- Responses envelope builds output array with message + function_call items. Source: `src/handlers/responses/native/envelope.js` (buildResponsesEnvelope).

## Abnormalities / concerns (initial)

- Dual tool-call sources (structured + textual parsing) may double-emit calls in both chat and responses.
- Tag mismatch: chat tooling expects `<use_tool>` blocks; responses tool parser expects `<tool_call>` blocks.
- Strict tool parsing can hard-fail streams (`strict tool_call parse failure`). Source: `src/handlers/responses/stream-adapter.js` + `src/handlers/responses/tool-call-parser.js`.
- Output mode behavior differs between chat and responses (responses uses header default override; chat has copilot auto-detect). Source: `src/handlers/responses/shared.js`, `src/handlers/chat/shared.js`.
