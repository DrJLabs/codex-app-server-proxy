# Getting Started

This repo provides an OpenAI-compatible proxy over Codex CLI. The main endpoints are `/v1/models`, `/v1/chat/completions`, and `/v1/responses`.

## Prerequisites

- Node.js **>= 22**
- Optional: Docker + Docker Compose v2 (for stack workflows)

## Quickstart (local or Docker)

Start with the root README quick starts:

- Local Node: [`../README.md`](../README.md) (Quick start - local Node)
- Docker Compose: [`../README.md`](../README.md) (Quick start - Docker Compose)

If you are using Obsidian Copilot, follow the "Choose your client path" guidance in [`../README.md`](../README.md).

## Quickstart (local Node)

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local env file and set your bearer key:

   ```bash
   cp .env.example .env
   ```

   Update `PROXY_API_KEY` in `.env` to a value you will use for local auth.

3. Start the dev server (port 18000 by default):

   ```bash
   npm run dev
   ```

4. Verify:

   ```bash
   curl -s http://127.0.0.1:18000/healthz | jq .
   curl -s http://127.0.0.1:18000/v1/models | jq .
   ```

## No Codex install? Use the shim

`npm run dev:shim` uses the deterministic JSON-RPC shim ([`../scripts/fake-codex-jsonrpc.js`](../scripts/fake-codex-jsonrpc.js)) so you can run locally without installing Codex CLI:

```bash
npm run dev:shim
```

## Next steps

- Configuration: [`configuration.md`](configuration.md)
- Local workflows (Node vs compose vs dev stack): [`local-development.md`](local-development.md)
- API overview + runnable curl examples: [`api/overview.md`](api/overview.md)
- Deployment: [`deployment/production.md`](deployment/production.md)
- Troubleshooting: [`troubleshooting.md`](troubleshooting.md)
