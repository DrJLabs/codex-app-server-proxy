#!/usr/bin/env bash
set -Eeuo pipefail

require() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
require envsubst

: "${DOMAIN:?set DOMAIN}"
: "${DEV_DOMAIN:?set DEV_DOMAIN}"
: "${ZONE_NAME:?set ZONE_NAME}"

export DOMAIN DEV_DOMAIN ZONE_NAME

envsubst '$DOMAIN $DEV_DOMAIN $ZONE_NAME' < infra/cloudflare/rht.example.json > infra/cloudflare/rht.json
envsubst '$DOMAIN $DEV_DOMAIN $ZONE_NAME' < infra/cloudflare/rht_update.example.json > infra/cloudflare/rht_update.json
envsubst '$DOMAIN $DEV_DOMAIN $ZONE_NAME' < workers/cors-preflight-logger/wrangler.example.toml > workers/cors-preflight-logger/wrangler.toml

echo "Rendered infra/cloudflare/rht.json"
echo "Rendered infra/cloudflare/rht_update.json"
echo "Rendered workers/cors-preflight-logger/wrangler.toml"
