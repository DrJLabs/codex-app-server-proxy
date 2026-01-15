#!/usr/bin/env bash
set -Eeuo pipefail

# Guarded Dev→Prod port helper.
# - Default: non-destructive checks; sync runs in dry-run mode.
# - Validates invariants (Traefik labels, ForwardAuth target, network), syncs `.codev → .codex-api`,
#   optional deploy, optional smoke test.
# - Creates artifacts under test-results/port-YYYYmmddHHMMSS.
#
# Usage:
#   bash scripts/port-dev-to-prod.sh [--deploy] [--smoke] [--sync|--no-sync] [--dry-run] [--domain <name>]
# Env (when --deploy):
#   CONFIRM_DEPLOY=prod         # required to actually run docker compose up
#   DOMAIN=codex-api.example    # used by --smoke if not provided via flag
#   KEY=sk-...                  # optional bearer for chat tests

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ts() { date +%Y%m%d%H%M%S; }
ART_DIR="$ROOT_DIR/test-results/port-$(ts)"
mkdir -p "$ART_DIR"

DEPLOY=0
DO_SMOKE=0
DO_SYNC=1
REQUESTED_DRY_RUN=0
DOMAIN="${DOMAIN:-}"
SMOKE_WAIT=${SMOKE_WAIT_SECONDS:-10}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy) DEPLOY=1; shift;;
    --smoke) DO_SMOKE=1; shift;;
    --sync) DO_SYNC=1; shift;;
    --no-sync) DO_SYNC=0; shift;;
    --dry-run) REQUESTED_DRY_RUN=1; shift;;
    --domain)
      if [[ -z "${2:-}" || "${2:0:1}" == "-" ]]; then
        printf "Error: --domain requires a non-flag argument.\n" >&2
        exit 2
      fi
      DOMAIN="$2"
      shift 2
      ;;
    *) printf "Unknown arg: %s\n" "$1" >&2; exit 2;;
  esac
done

# Default to dry run; only flip off when --deploy is set without --dry-run
DRY_RUN=1
if [[ "$DEPLOY" == "1" && "$REQUESTED_DRY_RUN" == "0" ]]; then
  DRY_RUN=0
fi

echo "== Port Dev→Prod: checks (artifacts: ${ART_DIR}) =="

need() { command -v "$1" >/dev/null || { printf "Missing: %s\n" "$1" >&2; exit 2; }; }
need docker
need yq

# 1) Basic repo sanity
if [[ ! -f docker-compose.yml ]] || [[ ! -f infra/compose/compose.dev.stack.yml ]]; then
  echo "Error: missing compose files (expected docker-compose.yml and infra/compose/compose.dev.stack.yml)" >&2
  exit 2
fi

# 2) Render compose for prod and save
echo "# docker compose config (prod)" | tee "$ART_DIR/docker-compose.config.yaml" >/dev/null
docker compose config >> "$ART_DIR/docker-compose.config.yaml"

# 3) Invariant checks
echo "Checking invariants…"

# ForwardAuth address must be host loopback:18080 (prod)
FA_LABEL=$(yq -r '.services.app.labels[]? | select(test("^traefik.http.middlewares.codex-forwardauth.forwardauth.address="))' docker-compose.yml || true)
if [[ -z "$FA_LABEL" ]] || [[ "$FA_LABEL" == *$'
'* ]]; then
  echo "[FAIL] Expected exactly one 'traefik.http.middlewares.codex-forwardauth.forwardauth.address' label in docker-compose.yml." | tee "$ART_DIR/invariants.txt"
  exit 3
fi
FA_ADDR=${FA_LABEL#*=}
if [[ "$FA_ADDR" != "http://127.0.0.1:18080/verify" ]]; then
  echo "[FAIL] ForwardAuth address in docker-compose.yml is not 127.0.0.1:18080/verify: $FA_ADDR" | tee "$ART_DIR/invariants.txt"
  exit 3
fi

# Required routers present
required=(codex-api codex-preflight codex-models codex-health)
missing=()
for r in "${required[@]}"; do
  if ! yq -e ".services.app.labels[]? | select(test(\"^traefik.http.routers.${r}.rule=\"))" docker-compose.yml >/dev/null; then
    missing+=("$r")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "[FAIL] Missing routers: ${missing[*]}" | tee -a "$ART_DIR/invariants.txt"
  exit 3
fi

# Traefik network label present
if ! yq -e '.services.app.labels[]? | . == "traefik.docker.network=traefik"' docker-compose.yml >/dev/null; then
  echo "[FAIL] traefik.docker.network=traefik not set on app service" | tee -a "$ART_DIR/invariants.txt"
  exit 3
fi

# External network exists locally (best-effort)
if ! docker network ls --format '{{.Name}}' | grep -qx traefik; then
  echo "[WARN] Docker network 'traefik' not found locally; ensure it exists on prod host" | tee -a "$ART_DIR/invariants.txt"
fi

# .codex-api mapped (writable by default)
if ! yq -e '.services.app.volumes[]? | . == "./.codex-api:/app/.codex-api"' docker-compose.yml >/dev/null; then
  echo "[FAIL] .codex-api volume not mounted in prod compose" | tee -a "$ART_DIR/invariants.txt"
  exit 3
fi

echo "[PASS] Invariants OK" | tee -a "$ART_DIR/invariants.txt"

# 3b) Presence of required Codex HOME seed files
missing_seed=()
for f in config.toml AGENTS.md; do
  [[ -f ".codex-api/$f" ]] || missing_seed+=("$f")
done
if [[ ${#missing_seed[@]} -gt 0 ]]; then
  echo "[WARN] Missing files in .codex-api/: ${missing_seed[*]}" | tee -a "$ART_DIR/invariants.txt"
  echo "      Hint: run 'npm run port:sync-config' to seed from .codev/." | tee -a "$ART_DIR/invariants.txt"
fi

# 3c) Sync Codex config + AGENTS from .codev to .codex-api (default on, dry-run)
if [[ "$DO_SYNC" == "1" ]]; then
  echo "Syncing Codex HOME from .codev → .codex-api (config.toml, AGENTS.md)..."
  if [[ "$DRY_RUN" == "1" ]]; then
    bash "$ROOT_DIR/scripts/sync-codex-config.sh" --dry-run 2>&1 | tee "$ART_DIR/sync-dry-run.txt"
  else
    bash "$ROOT_DIR/scripts/sync-codex-config.sh" --force 2>&1 | tee "$ART_DIR/sync.log"
  fi
fi

# 4) Suggest next steps
cat >"$ART_DIR/NEXT_STEPS.txt" <<'TXT'
Next steps to deploy on production host:

1) Build and (re)create containers:
   docker compose up -d --build --force-recreate

2) Smoke test via Cloudflare (set your domain and optional KEY):
   DOMAIN=codex-api.example.com npm run smoke:prod
   # With auth for chat tests:
   DOMAIN=codex-api.example.com KEY=sk-... npm run smoke:prod

3) Optional live E2E (requires KEY in .env or environment):
   LIVE_BASE_URL=https://codex-api.example.com npm run test:live

4) If issues arise, inspect logs:
   docker compose logs -f
TXT

echo "Wrote next steps to: $ART_DIR/NEXT_STEPS.txt"

# 5) Optional deploy (guarded)
if [[ "$DEPLOY" == "1" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY RUN: would deploy: docker compose up -d --build --force-recreate" | tee -a "$ART_DIR/deploy.log"
  else
    if [[ "${CONFIRM_DEPLOY:-}" != "prod" ]]; then
      echo "Refusing to deploy: set CONFIRM_DEPLOY=prod to proceed." >&2
      exit 4
    fi
    echo "Deploying: docker compose up -d --build --force-recreate" | tee -a "$ART_DIR/deploy.log"
    docker compose up -d --build --force-recreate 2>&1 | tee -a "$ART_DIR/deploy.log"
    echo "Deployment complete. Run: DOMAIN=your.domain npm run smoke:prod"
  fi
fi

echo "All checks complete. Artifacts: $ART_DIR"

# 6) Optional smoke test via Cloudflare
if [[ "$DO_SMOKE" == "1" ]]; then
  if [[ -z "$DOMAIN" ]]; then
    echo "Warning: --smoke set but no domain provided (use --domain or DOMAIN=...). Skipping smoke." | tee -a "$ART_DIR/smoke.txt"
  else
    if [[ "$SMOKE_WAIT" =~ ^[0-9]+$ ]] && [[ "$SMOKE_WAIT" -gt 0 ]]; then
      echo "Waiting ${SMOKE_WAIT}s before smoke to allow edge warm-up..." | tee -a "$ART_DIR/smoke.txt"
      sleep "$SMOKE_WAIT"
    fi
    echo "Running smoke against https://$DOMAIN ..." | tee -a "$ART_DIR/smoke.txt"
    DOMAIN="$DOMAIN" KEY="${KEY:-}" bash "$ROOT_DIR/scripts/prod-smoke.sh" 2>&1 | tee -a "$ART_DIR/smoke.txt"
  fi
fi
