#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
shift || true

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

# Defaults:
# - uses docker-compose.yml in the repo root
# - uses repo `.env` if present
# - does NOT pin a project name unless PROD_PROJECT is set
# - does NOT start the optional `app-responses` profile unless PROD_ENABLE_RESPONSES=1
compose_args=(
  --project-directory "$REPO_ROOT"
  -f "$REPO_ROOT/docker-compose.yml"
)

if [[ -f "$REPO_ROOT/.env" ]]; then
  compose_args+=(--env-file "$REPO_ROOT/.env")
fi

if [[ -n "${PROD_PROJECT:-}" ]]; then
  compose_args+=(-p "$PROD_PROJECT")
fi

if [[ "${PROD_ENABLE_RESPONSES:-0}" == "1" ]]; then
  compose_args+=(--profile responses)
fi

case "$action" in
  up)
    docker compose "${compose_args[@]}" up -d --pull always --force-recreate "$@"
    ;;
  down)
    docker compose "${compose_args[@]}" down --remove-orphans "$@"
    ;;
  logs)
    docker compose "${compose_args[@]}" logs -f --tail=200 "$@"
    ;;
  config)
    docker compose "${compose_args[@]}" config "$@"
    ;;
  rebuild)
    docker compose "${compose_args[@]}" down --remove-orphans
    docker compose "${compose_args[@]}" up -d --pull always --force-recreate "$@"
    ;;
  *)
    cat >&2 <<'TXT'
Usage: bash scripts/prod-stack.sh {up|down|logs|config|rebuild} [args...]

Env:
  PROD_PROJECT=codex-prod          # optional compose project name (otherwise default)
  PROD_ENABLE_RESPONSES=1          # start optional `app-responses` profile
TXT
    exit 1
    ;;
esac
