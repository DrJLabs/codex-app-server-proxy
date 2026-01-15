#!/usr/bin/env bash
set -Eeuo pipefail

# Prod smoke test for the Codex API behind Traefik/Cloudflare
# Usage:
#   DOMAIN=codex-api.example.com [KEY=sk-...] bash scripts/prod-smoke.sh
# Optional:
#   ORIGIN_HOST=127.0.0.1   # IP/host where Traefik listens (default 127.0.0.1)
#   SKIP_ORIGIN=1            # only test via public domain

# Load env quietly from repo `.env` if present to populate KEY/PROXY_API_KEY
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then . "$ROOT_DIR/.env"; fi

DOMAIN="${DOMAIN:-${APP_DOMAIN:-}}"; if [[ -z "$DOMAIN" ]]; then echo "ERROR: DOMAIN (or APP_DOMAIN in .env) is required" >&2; exit 2; fi
ORIGIN_HOST="${ORIGIN_HOST:-127.0.0.1}"
# Prefer KEY, fall back to PROXY_API_KEY (from .env or environment)
KEY="${KEY:-${PROXY_API_KEY:-}}"
BASE_CF="https://$DOMAIN"
REQUEST_TIMEOUT="${SMOKE_REQUEST_TIMEOUT:-60}"
STREAM_TIMEOUT="${SMOKE_STREAM_TIMEOUT:-120}"
METRICS_ENDPOINT="${METRICS_ENDPOINT:-http://127.0.0.1:11435/metrics}"
METRICS_TOKEN="${METRICS_TOKEN:-${PROXY_METRICS_TOKEN:-}}"
METRICS_PAYLOAD=""

pass() { printf "[PASS] %s\n" "$*"; }
fail() { printf "[FAIL] %s\n" "$*"; exit 1; }

curl_cf() { curl -sS -m "$REQUEST_TIMEOUT" -f "$@"; }
curl_origin() { curl -sS -m "$REQUEST_TIMEOUT" -f -k -H "Host: $DOMAIN" "https://$ORIGIN_HOST$1"; }
curl_metrics() {
  local url="$1"
  local header=()
  if [[ -n "$METRICS_TOKEN" ]]; then
    header=(-H "Authorization: Bearer $METRICS_TOKEN")
  fi
  curl -sS -m "$REQUEST_TIMEOUT" -f "${header[@]}" "$url"
}

IMAGE="${IMAGE:-ghcr.io/drjlabs/codex-app-server-proxy:latest}"

echo "== Prod smoke for $DOMAIN =="

if ! command -v docker >/dev/null 2>&1; then
  fail "docker binary is required for CLI availability check"
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  fail "docker image $IMAGE not present locally for CLI availability check"
fi

docker run --rm "$IMAGE" codex app-server --help >/dev/null && \
  pass "image codex app-server --help" || fail "image codex app-server --help"

if [[ "${SKIP_ORIGIN:-0}" != "1" ]]; then
  # Origin health
  curl_origin "/healthz" >/dev/null && pass "origin /healthz" || fail "origin /healthz"
  # Origin models
  curl_origin "/v1/models" | jq -e '.data[0].id=="codex-5"' >/dev/null && pass "origin /v1/models" || fail "origin /v1/models"
else
  echo "(Skipping origin checks)"
fi

if [[ "${SKIP_METRICS:-0}" != "1" ]]; then
  METRICS_PAYLOAD="$(curl_metrics "$METRICS_ENDPOINT")"
  if echo "$METRICS_PAYLOAD" | grep -q "codex_http_requests_total"; then
    pass "metrics scrape"
  else
    fail "metrics scrape (${METRICS_ENDPOINT})"
  fi
else
  echo "(Skipping metrics scrape; set SKIP_METRICS=0 and METRICS_ENDPOINT if needed)"
fi

# Cloudflare health/models
curl_cf -D- -o /dev/null "$BASE_CF/healthz" | grep -q " 200 " && pass "cf /healthz" || fail "cf /healthz"
curl_cf "$BASE_CF/v1/models" | jq -e '.data[0].id=="codex-5"' >/dev/null && pass "cf /v1/models" || fail "cf /v1/models"
READY_PAYLOAD="$(curl_cf "$BASE_CF/readyz")" || fail "cf /readyz"
READY_OK="$(echo "$READY_PAYLOAD" | jq -r '.health.readiness.ready')"
READY_RESTARTS="$(echo "$READY_PAYLOAD" | jq -r '.health.readiness.details.restarts_total')"
READY_BACKOFF="$(echo "$READY_PAYLOAD" | jq -r '.health.readiness.details.next_restart_delay_ms')"
if [[ "$READY_OK" == "true" ]] && [[ "$READY_RESTARTS" =~ ^[0-9]+$ ]] && [[ "$READY_BACKOFF" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
  pass "cf /readyz (ready with restart/backoff metadata)"
else
  echo "$READY_PAYLOAD" | jq .
  fail "cf /readyz"
fi

if [[ -n "$METRICS_PAYLOAD" ]]; then
  METRIC_RESTARTS="$(awk '/^codex_worker_restarts_total/{print $2; exit}' <<<"$METRICS_PAYLOAD")"
  METRIC_BACKOFF="$(awk '/^codex_worker_backoff_ms/{print $2; exit}' <<<"$METRICS_PAYLOAD")"
  if [[ -n "$METRIC_RESTARTS" && "$METRIC_RESTARTS" == "$READY_RESTARTS" ]]; then
    pass "metrics restart count matches /readyz (${METRIC_RESTARTS})"
  else
    fail "metrics restart count mismatch (/readyz=$READY_RESTARTS metrics=${METRIC_RESTARTS:-missing})"
  fi
  if [[ -n "$METRIC_BACKOFF" ]]; then
    pass "metrics backoff gauge present (${METRIC_BACKOFF} ms)"
  fi
fi

if [[ -n "$KEY" ]]; then
  # Non-stream chat
  PAY='{"model":"codex-5","stream":false,"reasoning":{"effort":"low"},"messages":[{"role":"user","content":"Say hello."}]}'
  curl_cf -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "$PAY" "$BASE_CF/v1/chat/completions" | jq -e '.choices[0].message.content|length>0' >/dev/null \
    && pass "cf POST /v1/chat/completions (non-stream)" || fail "cf POST /v1/chat/completions (non-stream)"

  # Streaming chat (SSE) — require at least one content delta and [DONE]
  SSE_OUT=$(mktemp)
  curl -sN --max-time "$STREAM_TIMEOUT" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d '{"model":"codex-5","stream":true,"reasoning":{"effort":"low"},"messages":[{"role":"user","content":"Say hello."}]}' \
    "$BASE_CF/v1/chat/completions" | sed '/^data: \[DONE\]$/q' > "$SSE_OUT" || true
  if grep -q '^data: \[DONE\]$' "$SSE_OUT" && \
     grep -q '"object":"chat.completion.chunk"' "$SSE_OUT" && \
     grep -q '"delta":{' "$SSE_OUT"; then
    pass "cf POST /v1/chat/completions (stream)"
  else
    echo "--- SSE capture ---"; sed -n '1,120p' "$SSE_OUT"; echo "-------------------"
    fail "cf POST /v1/chat/completions (stream)"
  fi
  rm -f "$SSE_OUT"

  # Tool-call streaming smoke (structured + optional modes)
  TOOL_SMOKE_MODEL="${TOOL_SMOKE_MODEL:-codex-5}"
  TOOL_SMOKE_TIMEOUT_MS="${TOOL_SMOKE_TIMEOUT_MS:-30000}"
  TOOL_SMOKE_ENDPOINT="${TOOL_SMOKE_ENDPOINT:-responses}"
  TOOL_SMOKE_MODES="${TOOL_SMOKE_MODES:-structured}"
  run_tool_smoke() {
    local mode="$1"; shift
    local flags=("$@")
    local out
    out=$(mktemp)
    if BASE_URL="$BASE_CF" MODEL="$TOOL_SMOKE_MODEL" KEY="$KEY" TIMEOUT_MS="$TOOL_SMOKE_TIMEOUT_MS" \
      TOOL_SMOKE_ENDPOINT="$TOOL_SMOKE_ENDPOINT" \
      node "$ROOT_DIR/scripts/smoke/stream-tool-call.js" "${flags[@]}" >"$out" 2>&1; then
      pass "cf tool-call smoke (${mode})"
      cat "$out"
    else
      echo "--- tool-call smoke output (${mode}) ---"; cat "$out"; echo "------------------------------------"
      rm -f "$out"
      fail "cf tool-call smoke (${mode})"
    fi
    rm -f "$out"
  }

  IFS=',' read -ra MODES <<<"$TOOL_SMOKE_MODES"
  for mode in "${MODES[@]}"; do
    case "$mode" in
      structured|"")
        run_tool_smoke "structured" ${TOOL_SMOKE_FLAGS:-}
        ;;
      disconnect)
        if [[ "$TOOL_SMOKE_ENDPOINT" == "responses" ]]; then
          echo "(Skipping tool-call disconnect mode for responses endpoint)"
          continue
        fi
        run_tool_smoke "disconnect" --disconnect-after-first-tool --allow-single ${TOOL_SMOKE_FLAGS:-}
        ;;
      textual)
        run_tool_smoke "textual" --expect-xml --allow-single ${TOOL_SMOKE_FLAGS:-}
        ;;
      *)
        echo "(Skipping unknown tool-call smoke mode: $mode)"
        ;;
    esac
  done
else
  echo "(Skipping auth chat tests; set KEY=...)"
fi

echo "All smoke checks passed."
