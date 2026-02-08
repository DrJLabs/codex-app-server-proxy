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
# - does NOT build locally unless PROD_LOCAL_BUILD=1
compose_args=(
  --project-directory "$REPO_ROOT"
  -f "$REPO_ROOT/docker-compose.yml"
)

if [[ "${PROD_LOCAL_BUILD:-0}" == "1" ]]; then
  compose_args+=(-f "$REPO_ROOT/compose/prod.local-build.override.yml")
fi

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
    if [[ "${PROD_LOCAL_BUILD:-0}" == "1" ]]; then
      docker compose "${compose_args[@]}" up -d --build --force-recreate "$@"
    else
      docker compose "${compose_args[@]}" up -d --pull always --force-recreate "$@"
    fi
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
    if [[ "${PROD_LOCAL_BUILD:-0}" == "1" ]]; then
      docker compose "${compose_args[@]}" up -d --build --force-recreate "$@"
    else
      docker compose "${compose_args[@]}" up -d --pull always --force-recreate "$@"
    fi
    ;;
  *)
    cat >&2 <<'TXT'
Usage: bash scripts/prod-stack.sh {up|down|logs|config|rebuild} [args...]

Env:
  PROD_PROJECT=codex-prod          # optional compose project name (otherwise default)
  PROD_ENABLE_RESPONSES=1          # start optional `app-responses` profile
  PROD_LOCAL_BUILD=1               # build locally (uses compose/prod.local-build.override.yml)
  PROD_LOCAL_IMAGE=...             # optional image tag for local build (default codex-app-server-proxy:local)
TXT
    exit 1
    ;;
esac
