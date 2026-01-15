#!/usr/bin/env bash
set -Eeuo pipefail

missing=0
for f in infra/cloudflare/rht.json infra/cloudflare/rht_update.json workers/cors-preflight-logger/wrangler.toml; do
  if [[ ! -f "$f" ]]; then
    echo "Missing generated file: $f" >&2
    missing=1
  fi
done

if rg -n "onemainarmy" --glob "!scripts/validate-domain-scrub.sh" >/dev/null 2>&1; then
  echo "Found onemainarmy.com in repo" >&2
  exit 1
fi

exit "$missing"
