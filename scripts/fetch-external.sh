#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXTERNAL_DIR=${EXTERNAL_DIR:-"$ROOT_DIR/external"}

fetch_repo() {
  local name=$1
  local url=$2
  local branch=$3
  local dir="$EXTERNAL_DIR/$name"

  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --depth 1 origin "$branch"
    git -C "$dir" checkout "$branch"
    git -C "$dir" reset --hard "origin/$branch"
  else
    git clone --depth 1 --branch "$branch" "$url" "$dir"
  fi
}

mkdir -p "$EXTERNAL_DIR"

fetch_repo "codex" "https://github.com/openai/codex.git" "main"
fetch_repo "obsidian-copilot" "https://github.com/logancyang/obsidian-copilot.git" "main"

echo "External references ready in $EXTERNAL_DIR"
