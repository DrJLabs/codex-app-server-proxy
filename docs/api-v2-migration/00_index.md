# codex-app-server-proxy — API V2 Migration Task Pack (for agent handoff)

## Goal
Upgrade the proxy to speak **Codex app-server protocol API V2** end-to-end (not only tool-calls), while preserving **OpenAI `/v1/responses`-style** input/output behavior.

## How to use this pack
- Assign **one file per agent**.
- Each file contains: scope, concrete TODOs, “where to look” pointers, search patterns, and **proposed patch snippets**.

## Migration checklist (working order)
- [ ] 01: JSON-RPC `initialize` handshake sends `protocolVersion: "v2"` + `capabilities: {}` (plus optional v1 fallback) and passes shim compatibility checks.
- [ ] 02: `newConversation` bootstrap forwards `config` + `compactPrompt`, preserves sandbox normalization, and adds unit tests for edge cases.
- [ ] 03: Request path uses `sendUserMessage(stream:true)` explicitly for streaming, preserves non-stream behavior; **nonstream buffering fallback is optional** (enable only if upstream requires streaming), and keeps dynamic tool injection end-to-end.
- [ ] 04: Streaming notifications accept v2 `response.*` tool-call lifecycle events without dropping text deltas; **adapter raw `response.*` handling is optional** unless raw events reach the adapter; add tests for aggregator + adapter behavior.
- [ ] 05: `/v1/responses` output parity: output item typing, SSE ordering, `output_index` semantics, tool argument normalization, and policy choice for `usage`/`finish_reason`.
- [ ] 06: Error mapping + completion semantics: normalize Codex errors to OpenAI envelopes, preserve auth/rate-limit, and ensure exactly-once termination for streaming.
- [ ] Verification: run targeted unit/integration/e2e suites per doc acceptance criteria.

## Subtasks
1. [01_rpc_handshake_initialize_v2.md](01_rpc_handshake_initialize_v2.md)
2. [02_conversation_bootstrap_newConversation_params.md](02_conversation_bootstrap_newConversation_params.md)
3. [03_request_path_sendUserMessage_streaming_refactor.md](03_request_path_sendUserMessage_streaming_refactor.md)
4. [04_streaming_notifications_v2_events_and_tool_calls.md](04_streaming_notifications_v2_events_and_tool_calls.md)
5. [05_responses_output_normalization_v2_parity.md](05_responses_output_normalization_v2_parity.md)
6. [06_error_mapping_auth_and_completion_semantics_updated.md](06_error_mapping_auth_and_completion_semantics_updated.md)
7. [client-to-app-server.md](client-to-app-server.md)
8. [app-server-to-client.md](app-server-to-client.md)
9. [logging-gaps.md](logging-gaps.md)
