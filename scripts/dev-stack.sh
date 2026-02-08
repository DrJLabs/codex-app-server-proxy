#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
shift || true

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

compose_args=(
  --project-directory "$REPO_ROOT"
  -p codex-dev
  -f "$REPO_ROOT/compose/dev-stack.base.yml"
  -f "$REPO_ROOT/compose/dev-stack.override.yml"
  --env-file "$REPO_ROOT/.env.dev"
)

case "$action" in
  up)
    # Disable BuildKit for dev stack compatibility; revisit if no longer needed.
    DOCKER_BUILDKIT=0 docker compose "${compose_args[@]}" up -d --build "$@"
    ;;
  down)
    docker compose "${compose_args[@]}" down -v "$@"
    ;;
  logs)
    docker compose "${compose_args[@]}" logs -f --tail=200 "$@"
    ;;
  *)
    echo "Usage: $0 {up|down|logs} [args...]" >&2
    exit 1
    ;;
esac
