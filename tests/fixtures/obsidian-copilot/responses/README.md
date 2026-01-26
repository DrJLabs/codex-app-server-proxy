# Obsidian Copilot Responses Fixtures

Purpose: capture real `/v1/responses` request shapes from Obsidian Copilot and replay them in proxy tests.

Notes:

- Fixtures in this directory are sanitized and safe to commit.
- Raw captures live under `test-results/responses-copilot/raw` and are ignored by git.
- Regenerate fixtures by running the capture runbook in `docs/responses-endpoint/copilot-capture-runbook.md`.

Current fixtures:

- `responses-stream-text.json` — streaming request shape without tool events.
- `responses-stream-tool.json` — streaming request shape with tool events.
