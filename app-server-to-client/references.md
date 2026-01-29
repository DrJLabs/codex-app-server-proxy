# References (code)

- `src/services/transport/index.js` — #handleServerRequest, respondToToolCall
- `src/handlers/chat/stream-event.js` — parseStreamEventLine
- `src/handlers/chat/stream-event-router.js` — createStreamEventRouter (dynamic_tool_call_request)
- `src/lib/tools/dynamic-tools.js` — buildToolCallDeltaFromDynamicRequest
- `src/lib/tool-call-aggregator.js` — createToolCallAggregator, ingestDelta, ingestMessage, snapshot, supportsParallelCalls
- `src/lib/tools/obsidianToolsSpec.js` — toObsidianXml
- `src/handlers/chat/shared.js` — resolveOutputMode, OUTPUT_MODE_CANON
- `src/handlers/chat/tool-output.js` — buildCanonicalXml, extractTextualUseToolBlock
- `src/handlers/chat/stream-output.js` — createStreamOutputCoordinator
- `src/handlers/chat/stream.js` — sendChunk/buildChoiceFrames, toolCallAggregator usage
- `src/services/sse.js` — sendSSE, finishSSE, writeSseChunk
- `src/handlers/responses/native/execute.js` — runNativeResponses
- `src/handlers/responses/stream-adapter.js` — writeEvent, emitToolCallDeltas, finalize
- `src/handlers/responses/native/request.js` — appendInputItem (tool_output/function_call_output)
- `src/handlers/responses/nonstream.js` — respondToToolOutputs, parseToolCallText merge
- `src/handlers/responses/tool-call-parser.js` — parseToolCallText
- `src/handlers/responses/native/envelope.js` — buildResponsesEnvelope
- `src/handlers/responses/shared.js` — resolveResponsesOutputMode
