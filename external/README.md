# External references (optional)

This directory is intentionally ignored by git. Only this README and
`manifest.json` are tracked so the layout is discoverable.

Use `scripts/fetch-external.sh` to clone the upstream repos used for
compatibility checks. The script tracks `main` for each repository.

Example:

```bash
scripts/fetch-external.sh
```

After running the script, you'll have:

- `external/codex/`
- `external/obsidian-copilot/`
