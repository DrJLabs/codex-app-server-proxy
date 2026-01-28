# codex-app-server-proxy — API V2 Migration Task Pack (for agent handoff)

## Goal
Upgrade the proxy to speak **Codex app-server protocol API V2** end-to-end (not only tool-calls), while preserving **OpenAI `/v1/responses`-style** input/output behavior.

## How to use this pack
- Assign **one file per agent**.
- Each file contains: scope, concrete TODOs, “where to look” pointers, search patterns, and **proposed patch snippets**.
- **Line references are intentionally expressed as `SEARCH:` patterns** because this workspace cannot currently read your repo source.  
  - After you enable GitHub repo access in this chat (or agents run locally), replace `SEARCH:` markers with **exact file paths + line ranges**.

## Subtasks
1. [01_rpc_handshake_initialize_v2.md](sandbox:/mnt/data/codex_proxy_v2_migration_tasks/01_rpc_handshake_initialize_v2.md)
2. [02_conversation_bootstrap_newConversation_params.md](sandbox:/mnt/data/codex_proxy_v2_migration_tasks/02_conversation_bootstrap_newConversation_params.md)
3. [03_request_path_sendUserMessage_streaming_refactor.md](sandbox:/mnt/data/codex_proxy_v2_migration_tasks/03_request_path_sendUserMessage_streaming_refactor.md)
4. [04_streaming_notifications_v2_events_and_tool_calls.md](sandbox:/mnt/data/codex_proxy_v2_migration_tasks/04_streaming_notifications_v2_events_and_tool_calls.md)
5. [05_responses_output_normalization_v2_parity.md](sandbox:/mnt/data/codex_proxy_v2_migration_tasks/05_responses_output_normalization_v2_parity.md)
6. [06_error_mapping_auth_and_completion_semantics.md](sandbox:/mnt/data/codex_proxy_v2_migration_tasks/06_error_mapping_auth_and_completion_semantics.md)

## Repo access note
To generate *true* line-accurate references automatically, enable repo access (ChatGPT UI: `@github` → select the repo), then I can re-run this pack with actual file/line citations.
