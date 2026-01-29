# Responses XML tool-call gating (design)

## Context
`/v1/responses` is backed by app-server JSON-RPC. The proxy currently injects XML `<tool_call>` guidance into developer instructions, which nudges the model to emit text-based tool calls instead of structured `tool_calls`.

## Goal
Default to native app-server tool calls (structured `tool_calls` / `function_call`) and keep XML parsing available only when explicitly enabled.

## Design
- Add `PROXY_RESPONSES_XML_TOOL_CALLS` (default `false`).
- When enabled:
  - Inject XML `<tool_call>` schema guidance into developer instructions.
  - Enable `<tool_call>` parsing in the responses stream adapter.
- When disabled (default):
  - Do not inject XML tool guidance.
  - Do not parse `<tool_call>` text into tool calls.

## Data flow
1. Request normalization builds `developerInstructions`.
2. If XML flag is enabled, append tool-call schema guidance.
3. App-server emits structured `tool_calls` (preferred) or text.
4. Stream adapter translates structured tool calls into OpenAI-style SSE events; XML parsing only when flag is enabled.

## Testing
- Unit: request normalization supports opt-in XML injection.
- Unit: stream adapter parses `<tool_call>` only when XML flag is enabled.

## Rollback
Set `PROXY_RESPONSES_XML_TOOL_CALLS=true` to restore legacy XML injection/parsing.
