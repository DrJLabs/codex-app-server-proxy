#!/usr/bin/env bash
set -Eeuo pipefail

# Usage:
#   DEV_DOMAIN=codex-dev.example.com [KEY=sk-dev-...] bash scripts/dev-smoke.sh
# Optional:
#   ORIGIN_HOST=127.0.0.1    # where Traefik listens (host loopback), default 127.0.0.1
#   SKIP_ORIGIN=1            # only test via public domain

# Load env quietly from repo `.env.dev` if present to populate KEY/PROXY_API_KEY
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env.dev" ]]; then . "$ROOT_DIR/.env.dev"; fi

DOMAIN="${DEV_DOMAIN:-${DOMAIN:-}}"; [[ -n "$DOMAIN" ]] || { echo "ERROR: DEV_DOMAIN or DOMAIN is required" >&2; exit 2; }
ORIGIN_HOST="${ORIGIN_HOST:-127.0.0.1}"
# Prefer KEY, fall back to PROXY_API_KEY (from .env.dev or environment)
KEY="${KEY:-${PROXY_API_KEY:-}}"
# shellcheck disable=SC1090
. "$ROOT_DIR/scripts/lib/model-helpers.sh"
# Allow .env.dev to control the model; default to codex low-effort alias.
MODEL_RAW="${MODEL:-${SMOKE_MODEL:-gpt-5.2-codex-low}}"
MODEL="$(normalize_model "$MODEL_RAW")"
MODEL_EFFORT="$(infer_reasoning_effort "$MODEL_RAW")"
BASE_CF="https://$DOMAIN"
REQUEST_TIMEOUT="${SMOKE_REQUEST_TIMEOUT:-60}"
STREAM_TIMEOUT="${SMOKE_STREAM_TIMEOUT:-120}"
METRICS_ENDPOINT="${METRICS_ENDPOINT:-http://127.0.0.1:11435/metrics}"
METRICS_TOKEN="${METRICS_TOKEN:-${PROXY_METRICS_TOKEN:-}}"
METRICS_PAYLOAD=""
METRICS_ENABLED="$(printf "%s" "${PROXY_ENABLE_METRICS:-}" | tr '[:upper:]' '[:lower:]')"

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

if ! command -v docker >/dev/null 2>&1; then
  fail "docker binary is required for CLI availability check"
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  fail "docker image $IMAGE not present locally for CLI availability check"
fi

docker run --rm "$IMAGE" codex app-server --help >/dev/null && \
  pass "image codex app-server --help" || fail "image codex app-server --help"

echo "== Dev smoke for $DOMAIN =="

if [[ "${SKIP_ORIGIN:-0}" != "1" ]]; then
  curl_origin "/healthz" >/dev/null && pass "origin /healthz" || fail "origin /healthz"
  curl_origin "/v1/models" | jq -e '.object=="list"' >/dev/null && pass "origin /v1/models" || fail "origin /v1/models"
else
  echo "(Skipping origin checks)"
fi

if [[ "${SKIP_METRICS:-0}" != "1" ]]; then
  if [[ "$METRICS_ENABLED" != "true" && "${REQUIRE_METRICS:-0}" != "1" ]]; then
    echo "(Skipping metrics scrape; PROXY_ENABLE_METRICS is not true. Set REQUIRE_METRICS=1 to force.)"
  else
    METRICS_PAYLOAD="$(curl_metrics "$METRICS_ENDPOINT")"
    if echo "$METRICS_PAYLOAD" | grep -q "codex_http_requests_total"; then
      pass "metrics scrape"
    else
      fail "metrics scrape (${METRICS_ENDPOINT})"
    fi
  fi
else
  echo "(Skipping metrics scrape; set SKIP_METRICS=0 and METRICS_ENDPOINT if needed)"
fi

curl_cf -D- -o /dev/null "$BASE_CF/healthz" | grep -q " 200 " && pass "cf /healthz" || fail "cf /healthz"
curl_cf "$BASE_CF/v1/models" | jq -e '.object=="list"' >/dev/null && pass "cf /v1/models" || fail "cf /v1/models"
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
  BASE_PAYLOAD=$(jq -c -n \
    --arg model "$MODEL" \
    --arg content "Say hello." \
    --arg effort "$MODEL_EFFORT" \
    '({model: $model, messages: [{role: "user", content: $content}]})
     | if $effort != "" then . + {reasoning: {effort: $effort}} else . end')
  PAY=$(jq -c '. + {stream: false}' <<<"$BASE_PAYLOAD")
  curl_cf -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "$PAY" "$BASE_CF/v1/chat/completions" | jq -e '.choices[0].message.content|length>0' >/dev/null \
    && pass "cf POST /v1/chat/completions (non-stream)" || fail "cf POST /v1/chat/completions (non-stream)"

  SSE_OUT=$(mktemp)
  STREAM_PAY=$(jq -c '. + {stream: true}' <<<"$BASE_PAYLOAD")
  curl -sN --max-time "$STREAM_TIMEOUT" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "$STREAM_PAY" \
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
  TOOL_SMOKE_MODEL="${TOOL_SMOKE_MODEL:-$MODEL}"
  TOOL_SMOKE_TIMEOUT_MS="${TOOL_SMOKE_TIMEOUT_MS:-30000}"
  TOOL_SMOKE_ENDPOINT="${TOOL_SMOKE_ENDPOINT:-responses}"
  TOOL_SMOKE_MODES="${TOOL_SMOKE_MODES:-textual}"
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

echo "All dev smoke checks passed."
