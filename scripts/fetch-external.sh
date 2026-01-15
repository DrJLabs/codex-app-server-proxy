#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXTERNAL_DIR=${EXTERNAL_DIR:-"$ROOT_DIR/external"}
MANIFEST_FILE="$ROOT_DIR/external/manifest.json"

fetch_repo() {
  local name=$1
  local url=$2
  local branch=$3
  local dir="$EXTERNAL_DIR/$name"

  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --depth 1 origin "$branch"
    git -C "$dir" checkout -B "$branch" "origin/$branch"
  else
    git clone --depth 1 --branch "$branch" "$url" "$dir"
  fi
}

mkdir -p "$EXTERNAL_DIR"

if [ ! -f "$MANIFEST_FILE" ]; then
  echo "Missing manifest at $MANIFEST_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to parse $MANIFEST_FILE. Please install jq." >&2
  exit 1
fi

jq -r '.repos[] | [.name, .url, .branch] | @tsv' "$MANIFEST_FILE" | while IFS=$'\t' read -r name url branch; do
  if [ -z "$name" ] || [ -z "$url" ] || [ -z "$branch" ]; then
    continue
  fi
  fetch_repo "$name" "$url" "$branch"
done

echo "External references ready in $EXTERNAL_DIR"
