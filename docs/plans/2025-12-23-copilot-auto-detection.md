# Copilot Auto-Detection (proxy plan)

## Goal
Detect Obsidian Copilot requests reliably enough to switch the proxy into
`obsidian-xml` output mode for those requests only, while leaving non-Copilot
traffic in `openai-json`. The detection must be feature-flagged and use signals
already present in logs or request shapes.

## Constraints
- The Copilot system prompt is stripped before the backend; detection cannot
  depend on the system prompt content at runtime.
- Avoid logging raw content or secrets; use existing shape-only markers.
- Keep explicit `x-proxy-output-mode` override behavior intact.

## Signals available today (from code + logs)

### Headers / UA
- `user-agent` (examples observed in fixtures and logs):
  - `un/JS 6.5.0` (fixtures)
  - `obsidian/... Electron/...` (prod log example; archived locally)
  - Sources: `tests/fixtures/obsidian-copilot/responses/*`
- Optional edge-injected trace header:
  - `x-copilot-trace-id` (documented for Traefik injection)
  - Source: `docs/deployment/production.md`
- Copilot OpenRouter client headers (only when using OpenRouter provider):
  - `HTTP-Referer: https://obsidiancopilot.com`
  - `X-Title: Obsidian Copilot`
  - Source: `external/obsidian-copilot/src/LLMProviders/chatModelManager.ts`

### Content markers (already detected, shape-only)
- `<recent_conversations>` and `<saved_memories>` blocks come from Copilot memory prompt:
  - Source: `external/obsidian-copilot/src/memory/UserMemoryManager.ts`
- `<use_tool>` blocks are part of Copilot tool prompt format:
  - Source: `external/obsidian-copilot/src/LLMProviders/chainRunner/utils/modelAdapter.ts`
- Tool transcript marker: `Tool '…' result:`
  - Detected in `src/lib/ingress-guardrail.js` and `src/handlers/responses/ingress-logging.js`

### Request shape
- Copilot Responses API captures show:
  - `POST /v1/responses`
  - `input` array of `{ type:"message", role:"assistant|user", content:"..." }`
  - No explicit session identifiers or metadata keys in the capture
  - Source: `tests/fixtures/obsidian-copilot/responses/*.json`

## Proposed detection strategy (feature-flagged)

### Two-tier classifier
Use a scored classifier with a high-confidence tier and a suspected tier:

- **High confidence** (apply `obsidian-xml` output mode):
  - Any of:
    - `x-copilot-trace-id` present (edge-injected)
    - `<recent_conversations>` or `<saved_memories>` markers detected
    - Both OpenRouter headers present (`HTTP-Referer` + `X-Title`)

- **Suspected** (optional: log-only; do not change output mode):
  - UA indicates Obsidian or `un/JS`, plus one additional weak signal:
    - `<use_tool>` marker or `Tool '…' result:` transcript marker
    - Responses API input shape matches Copilot capture patterns

Rationale: the memory tags are Copilot-specific and already detectable without
recording content; UA alone is too spoofable to drive behavior.

### Feature flag
Introduce a new flag (name TBD) to gate the classifier:
- Proposal: `PROXY_COPILOT_AUTO_DETECT=true`
- When disabled, the existing UA/header heuristic stays as-is.
- When enabled, the new classifier determines Copilot detection and logs the
  reasons and confidence tier.

## Definition of done
- Detection is **feature-flagged** and off by default.
- When enabled, the proxy:
  - Applies `obsidian-xml` output mode only to high-confidence Copilot requests.
  - Leaves all other requests in the configured default output mode.
  - Continues to honor explicit `x-proxy-output-mode` overrides.
- Structured logs include a new shape-only field set:
  - `copilot_detected: boolean`
  - `copilot_detect_tier: "high"|"suspected"|null`
  - `copilot_detect_reasons: string[]` (bounded list)
- Tests cover at least:
  - `<recent_conversations>` triggers high-confidence detection.
  - OpenRouter headers trigger high-confidence detection.
  - UA-only does not trigger high-confidence detection.

## Implementation sketch (where to hook)

### 1) Shared classifier helper
Add a new helper (e.g., `detectCopilotRequestV2`) in a shared module to combine:
- Headers (including OpenRouter headers and optional `x-copilot-trace-id`)
- Marker detection (`detectIngressMarkers` on chat messages or `summarizeResponsesIngress` for responses)
- Request shape (for responses only, using existing ingress summary)

### 2) Apply to responses output mode resolution
Update `resolveResponsesOutputMode` to use the new classifier when the feature
flag is enabled. Keep the existing header override (`x-proxy-output-mode`).

### 3) Apply to chat/completions only if needed
If output mode needs to be forced for chat (future), use `detectIngressMarkers`
on `messages` before the backend call and apply output-mode decisions similarly.

### 4) Logging
Add the new detection fields to:
- `access_log` (for correlation across all routes)
- `responses_ingress_raw` (for responses-specific visibility)
- Optional: `ingress_guardrail_injected` (to see overlap with memory markers)

## Risks / edge cases
- Copilot users can disable memory; without `<recent_conversations>` markers,
  detection may fall back to weaker signals.
- Other clients could include similar XML tags or transcripts; scoring avoids
  false positives by requiring strong signals for behavior changes.

## Rollout plan
1. Implement classifier behind `PROXY_COPILOT_AUTO_DETECT`.
2. Enable in dev + staging, verify logs for false positives.
3. Enable in prod with log-only mode for suspected tier.
4. After validation, keep only high-confidence tier behavior changes.
