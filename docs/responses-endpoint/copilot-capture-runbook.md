# Copilot Responses Capture Runbook

Goal: capture real Obsidian Copilot `/v1/responses` requests + streams and promote them to fixtures under `tests/fixtures/obsidian-copilot/responses/`.

## Preconditions
- Proxy running with app-server backend (recommended).
- Obsidian Copilot configured to use the proxy base URL.
- No client changes required.

## Enable capture
1. Set env:
   - `PROXY_CAPTURE_RESPONSES_TRANSCRIPTS=true`
   - Optional: `PROXY_CAPTURE_RESPONSES_DIR=./test-results/responses-copilot/raw`
2. Restart the proxy.

## Capture scenarios
- Non-stream request (simple prompt, optional).
- Streaming request that triggers a tool call.

Optional: add an edge-injected header to name files deterministically:
- `x-proxy-capture-id: copilot-responses-nonstream`
- `x-proxy-capture-id: copilot-responses-stream-tool`

## Inspect raw captures
- Files land under `test-results/responses-copilot/raw/` and are gitignored.
- Each file includes sanitized request headers/body + response or stream entries.
- Confirm `metadata.output_mode_effective` is `obsidian-xml` for Copilot traffic.

## Promote to fixtures
1. Normalize captures into committed fixtures:
   - `npm run copilot:fixtures:normalize`
2. Review diffs under:
   - `tests/fixtures/obsidian-copilot/responses/`
3. The script writes stable files:
   - `responses-stream-text.json`
   - `responses-stream-tool.json`
   - `responses-nonstream.json` (optional; only when captured)

## Validation
- `npm run test:unit -- tests/unit/responses.copilot.capture.spec.js`
- `npm run test:integration -- tests/integration/responses.copilot.capture.int.test.js`

## Safety
- Raw captures are sanitized but still treated as sensitive; do not commit anything under `test-results/`.
- The capture flag is off by default and should only be enabled during controlled capture windows.
