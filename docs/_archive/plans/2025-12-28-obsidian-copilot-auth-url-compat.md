# Obsidian Copilot Auth URL Compatibility Plan

```markdown
## Goal
- Surface the app-server login URL to Obsidian Copilot users without changing the client code.
- Preserve OpenAI-compatible error shapes for all other clients by default.
- Avoid logging the auth URL or login_id in proxy logs/captures.

## Assumptions / constraints
- Obsidian Copilot cannot be modified; server-side behavior must adapt.
- Obsidian Copilot surfaces `error.code` for nonstream errors and falls back to
  `error.message` when the streaming error lacks `response.data`.
- Keep the current `error.details` payload for clients that parse it.
- Guard any compatibility behavior behind a feature flag.

## Research (current state)
- Relevant files/entrypoints:
  - `src/lib/errors.js` (auth error body shape)
  - `src/services/transport/index.js` (TransportError, mapTransportError)
  - `src/services/transport/child-adapter.js` (auth_required detection + login URL retrieval)
  - `src/dev-trace/sanitize.js` (client SSE logging sanitization)
  - `src/lib/capture/sanitize.js` (capture sanitization)
  - `external/obsidian-copilot/src/LLMProviders/chainRunner/BaseChainRunner.ts`
  - `external/obsidian-copilot/src/utils.ts`
- Existing patterns to follow:
  - Proxy uses `authErrorBody()` → `mapTransportError()` for nonstream + SSE.
  - Obsidian Copilot’s `BaseChainRunner.handleError()` uses
    `error.response.data.error.code` (or `err2String`) as the display string.
  - Obsidian Copilot’s `getApiErrorMessage()` and `err2String()` ignore
    `error.details`, so `error.details.auth_url` is not displayed.

## Analysis
### Options
1) **Inline login URL into `error.code` under a compatibility flag.**
   - Pros: Obsidian Copilot displays `error.code` as-is, so the URL shows.
   - Cons: Nonstandard `error.code` string; risk to other clients if enabled broadly.
2) Inline login URL into `error.message` only.
   - Pros: Keeps code stable.
   - Cons: Obsidian Copilot ignores `error.message` when `code` exists.
3) Remove `error.code` so client falls back to `error.message`.
   - Pros: URL can appear in message.
   - Cons: Breaks OpenAI error conventions and other clients relying on `code`.

### Decision
- Chosen: Option 1 (inline into `error.code`), **behind a flag**.
- Update: add `code+message` mode to also embed the login URL into `error.message`
  for streaming clients that surface only `message`.

### Risks / edge cases
- Error codes containing URLs may be logged; must redact in sanitizers.
- Very long URLs could exceed log size limits or UI clipping.
- Other clients might parse `error.code` strictly; keep default off.
- Ensure streaming and nonstreaming paths both use the same code formatting.

### Open questions
- Exact inline format for `error.code` (delimiter, label names).
- Whether to also include a short, human-readable prompt in `error.message`.

## Q&A (answer before implementation)
- Confirm desired `error.code` format, e.g.:
  - `invalid_api_key|login_url=<url>|login_id=<id>`
  - `invalid_api_key (login_url=<url>, login_id=<id>)`
- Should we also append a short instruction to `error.message`, or keep it unchanged?

## Implementation plan
1) **Config & format**
   - Add `PROXY_AUTH_LOGIN_URL_MODE=code` (default empty/false).
   - Add `PROXY_AUTH_LOGIN_URL_FORMAT` or a fixed format string to build the inline code.
2) **Error body shaping**
   - In `src/lib/errors.js`, allow optional `formatAuthErrorDetails()` to:
     - Return `error.details` as today.
     - Optionally override `error.code` (and/or message) when mode=code.
   - In `src/services/transport/index.js`, pass through `TransportError.details`
     and any `auth_code_override`.
3) **Redaction for logs**
   - Update `src/dev-trace/sanitize.js` to redact `auth_url` and `login_id` keys.
   - Add a string scrubber to redact `login_url=` or `auth.openai.com/oauth` patterns
     when inline format is enabled.
   - Update `src/lib/capture/sanitize.js` similarly so capture logs never include URL.
4) **Streaming parity**
   - Ensure SSE error payload uses the same code formatting as nonstream.
5) **Tests**
   - Unit: `authErrorBody` inline mode sets `error.code` and preserves `details`.
   - Unit: sanitizer redacts `auth_url` and inline URL strings.
   - Integration: when `PROXY_AUTH_LOGIN_URL_MODE=code`, verify
     `error.code` includes the URL for both stream and nonstream.
6) **Dev enablement**
   - Add `PROXY_AUTH_LOGIN_URL_MODE=code` to `.env.dev` (local only).
   - If needed, add env wiring in `infra/compose/compose.dev.stack.yml`.

## Tests to run
- `npx vitest run tests/unit/services/json-rpc-transport.spec.js`
- `npx vitest run tests/unit/services/json-rpc-child-adapter.spec.js`
- `npx vitest run tests/unit/dev-trace-sanitize.spec.js` (new, if added)
- `npx vitest run tests/integration/json-rpc-transport.int.test.js`
```
