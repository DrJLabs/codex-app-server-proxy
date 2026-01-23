# Disable client system prompt ignore for Copilot capture (dev)

## Goals
- Allow incoming system/developer prompts to flow into Codex in the dev stack.
- Capture the updated Copilot system prompt in raw transcripts for review.

## Non-goals
- Change metadata sanitization behavior.
- Modify production defaults or release workflow.

## Design
We will keep the change scoped to the dev stack configuration. The proxy already accepts system and developer messages but drops them when `PROXY_IGNORE_CLIENT_SYSTEM_PROMPT` is true. By setting `PROXY_IGNORE_CLIENT_SYSTEM_PROMPT=false` in `.env.dev`, the request normalization path will preserve those messages and pass them as `baseInstructions` to the Codex JSON-RPC request. This approach avoids code changes and keeps the behavior limited to the dev Docker stack. The existing raw transcript capture (`PROXY_CAPTURE_CHAT_RAW_TRANSCRIPTS=true`) will record the unredacted request body, including the full `messages` array with the system prompt, under `test-results/chat-copilot/raw-unredacted/`. Data flow remains unchanged: client request -> proxy ingress -> normalization -> Codex runner -> response; the only difference is that system/developer content is retained during normalization. If the system prompt is missing or empty, normalization will continue without `baseInstructions` and the request will still succeed. We will redeploy the dev stack to apply the env change and validate capture by sending a request with `x-proxy-capture-id` so the resulting JSON is easy to locate. Testing is limited to a smoke request in the dev stack plus inspection of the raw capture file; no unit tests or schema changes are required.
