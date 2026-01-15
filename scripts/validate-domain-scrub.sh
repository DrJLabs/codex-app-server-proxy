#!/usr/bin/env bash
set -Eeuo pipefail

missing=0
for f in infra/cloudflare/rht.json infra/cloudflare/rht_update.json workers/cors-preflight-logger/wrangler.toml; do
  if [[ ! -f "$f" ]]; then
    echo "Missing generated file: $f" >&2
    missing=1
  fi
done

mapfile -t tracked_files < <(git ls-files)

if rg -n "onemainarmy" --glob "!scripts/validate-domain-scrub.sh" -- "${tracked_files[@]}" >/dev/null 2>&1; then
  echo "Found onemainarmy.com in tracked files" >&2
  exit 1
fi

if rg -n "example.com" \
  -g '!docs/**' \
  -g '!**/*.md' \
  -g '!**/*.example.*' \
  -g '!.env.example' \
  -g '!.env.dev.example' \
  -g '!scripts/validate-domain-scrub.sh' \
  -- "${tracked_files[@]}" >/dev/null 2>&1; then
  echo "Found example.com in tracked files" >&2
  exit 1
fi

exit "$missing"
