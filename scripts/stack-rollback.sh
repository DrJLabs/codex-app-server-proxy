#!/usr/bin/env bash
set -Eeuo pipefail

# Roll back prod/dev by retagging the canonical tag (latest/dev)
# to a previously snapshotted image ID, then redeploy without build.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROD_COMPOSE="${PROD_COMPOSE:-$ROOT_DIR/docker-compose.yml}"
DEV_COMPOSE="${DEV_COMPOSE:-$ROOT_DIR/compose/dev-stack.yml}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.cache/codex-backups}"
APP_IMAGE_BASENAME="codex-app-server-proxy"

envs=(prod dev)
LOCK_FROM=""
ONLY_ENV=""
IMAGE_ID_OVERRIDE=""
TAG_OVERRIDE=""

LOCK_IMAGE_ID=""
LOCK_DOCKER_TAG=""
LOCK_CREATED_AT=""
LOCK_TARBALL=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [--env prod|dev|both] [--from-lock PATH] [--image-id SHA256:...] [--tag TAG]

Defaults: --env both, uses latest pointers under $BACKUP_DIR.
Examples:
  $(basename "$0") --env prod
  $(basename "$0") --from-lock <path-to-lock.json> --env dev
  $(basename "$0") --image-id sha256:abc... --env prod
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      shift; case "${1:-}" in prod|dev|both) ONLY_ENV="$1";; *) echo "--env must be prod|dev|both" >&2; exit 2;; esac; shift || true ;;
    --from-lock)
      [[ -n "${2:-}" && "${2:0:1}" != "-" ]] || die "Missing argument for --from-lock"
      LOCK_FROM="${2:-}"; shift 2 ;;
    --image-id)
      [[ -n "${2:-}" ]] || die "Missing argument for --image-id"
      IMAGE_ID_OVERRIDE="${2:-}"; shift 2 ;;
    --tag)
      [[ -n "${2:-}" ]] || die "Missing argument for --tag"
      TAG_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

log() { echo "[stack-rollback] $*"; }
warn() { echo "[stack-rollback][WARN] $*" >&2; }
die() { echo "[stack-rollback][ERROR] $*" >&2; exit 1; }

choose_envs() {
  case "$ONLY_ENV" in
    prod) envs=(prod) ;;
    dev) envs=(dev) ;;
    *) envs=(prod dev) ;;
  esac
}

load_lock_metadata() {
  local env=$1 lock=$2
  local line=""

  LOCK_IMAGE_ID=""
  LOCK_DOCKER_TAG=""
  LOCK_CREATED_AT=""
  LOCK_TARBALL=""

  if command -v python3 >/dev/null 2>&1; then
    if ! line=$(python3 - "$lock" "$env" <<'PY'
import json, sys

path, env_name = sys.argv[1], sys.argv[2]
with open(path, 'r', encoding='utf-8') as fh:
    data = json.load(fh)

entry = None
if isinstance(data, dict):
    if 'images' in data:
        for item in data.get('images', []):
            if item.get('env') == env_name:
                entry = item
                break
    else:
        entry_env = data.get('env')
        if entry_env is None or entry_env == env_name:
            entry = data

if not entry:
    sys.exit(0)

snap = entry.get('snap_ts_utc') or entry.get('created_at') or ''
fields = [
    entry.get('image_id') or '',
    entry.get('docker_tag') or '',
    snap,
    entry.get('tarball') or '',
]
print('\t'.join(fields))
PY
    ); then
      line=""
    fi
  fi

  if [[ -z "$line" ]] && command -v jq >/dev/null 2>&1; then
    if ! line=$(jq -r --arg env "$env" '
      def pick_entry:
        if type == "object" and has("images") then
          (.images[] | select(.env == $env))
        elif type == "object" then
          if (has("env") and .env != $env) then empty else . end
        else empty end;
      pick_entry | [(.image_id // ""), (.docker_tag // ""), ((.snap_ts_utc // .created_at) // ""), (.tarball // "")] | @tsv
    ' "$lock" 2>/dev/null); then
      line=""
    fi
    if [[ "$line" == "null" ]]; then
      line=""
    fi
  fi

  if [[ -z "$line" ]]; then
    return 1
  fi

  IFS=$'\t' read -r LOCK_IMAGE_ID LOCK_DOCKER_TAG LOCK_CREATED_AT LOCK_TARBALL <<<"$line"
  return 0
}

ensure_image_present() {
  local ref=$1 env=$2 lock_ts=$3 docker_tag_hint=$4

  if [[ -z "$ref" && -n "$docker_tag_hint" ]]; then
    ref="$docker_tag_hint"
  fi

  [[ -n "$ref" ]] || die "$env: lock metadata did not provide an image reference"

  if docker image inspect "$ref" >/dev/null 2>&1; then
    return 0
  fi

  if [[ -n "$docker_tag_hint" && "$docker_tag_hint" != "$ref" ]]; then
    if docker image inspect "$docker_tag_hint" >/dev/null 2>&1; then
      return 0
    fi
  fi

  local tarpath=""
  if [[ -n "$lock_ts" ]]; then
    local candidate="$BACKUP_DIR/${APP_IMAGE_BASENAME}-${env}-${lock_ts}.tar"
    [[ -f "$candidate" ]] && tarpath="$candidate"
  fi

  if [[ -z "$tarpath" ]]; then
    local ptr="$BACKUP_DIR/codex-latest-${env}.tarpath"
    if [[ -f "$ptr" ]]; then
      tarpath="$(cat "$ptr")"
    fi
  fi

  if [[ -n "$tarpath" && -f "$tarpath" ]]; then
    log "$env: loading image from $tarpath"
    docker load -i "$tarpath"
    if docker image inspect "$ref" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$docker_tag_hint" ]]; then
      if docker image inspect "$docker_tag_hint" >/dev/null 2>&1; then
        return 0
      fi
    fi
    die "$env: loaded $tarpath but image reference '$ref' is still missing"
  fi

  die "$env: image $ref not present and no backup tar available"
}

retag_and_redeploy() {
  local env=$1 iid=$2
  local base_tag compose_file service
  if [[ "$env" == "prod" ]]; then
    base_tag="$APP_IMAGE_BASENAME:latest"
    compose_file="$PROD_COMPOSE"
    service=app
  else
    base_tag="$APP_IMAGE_BASENAME:dev"
    compose_file="$DEV_COMPOSE"
    service=app-dev
  fi

  if [[ -n "$TAG_OVERRIDE" ]]; then
    base_tag="$TAG_OVERRIDE"
  fi

  log "$env: retagging $iid -> $base_tag"
  docker tag "$iid" "$base_tag"
  log "$env: redeploying with compose (no build)"
  if [[ "$env" == "dev" ]]; then
    docker compose -p codex-dev --env-file .env.dev -f "$compose_file" up -d --no-build "$service"
  else
    docker compose -f "$compose_file" up -d --no-build "$service"
  fi
}

choose_envs

for env in "${envs[@]}"; do
  iid=""
  lock_ts=""
  docker_hint=""

  if [[ -n "$IMAGE_ID_OVERRIDE" ]]; then
    iid="$IMAGE_ID_OVERRIDE"
  elif [[ -n "$LOCK_FROM" ]]; then
    if load_lock_metadata "$env" "$LOCK_FROM"; then
      if [[ -n "$LOCK_IMAGE_ID" ]]; then
        iid="$LOCK_IMAGE_ID"
      elif [[ -n "$LOCK_DOCKER_TAG" ]]; then
        iid="$LOCK_DOCKER_TAG"
      fi
      lock_ts="$LOCK_CREATED_AT"
      docker_hint="$LOCK_DOCKER_TAG"
    else
      die "$env: could not parse lock metadata from $LOCK_FROM (missing env entry or unsupported schema)"
    fi
  else
    # use latest pointer
    ptr="$BACKUP_DIR/codex-latest-${env}.iid"
    if [[ -f "$ptr" ]]; then
      iid="$(cat "$ptr")"
    fi
  fi

  [[ -n "$iid" ]] || die "$env: could not determine image id or tag; use --from-lock or --image-id"
  ensure_image_present "$iid" "$env" "$lock_ts" "$docker_hint"
  retag_and_redeploy "$env" "$iid"
done

log "Rollback complete."
