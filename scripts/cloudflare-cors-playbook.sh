#!/usr/bin/env bash
# Cloudflare Response Header Transform (CORS) Playbook
#
# Purpose
# - Manage the zone-level http_response_headers_transform ruleset used to set
#   CORS response headers (ACAO/Allow-Methods/Allow-Headers/Max-Age) for
#   your production domain (set via HOST), including adding/removing request headers from
#   Access-Control-Allow-Headers when client SDKs change (e.g., Stainless/Obsidian).
#
# Usage
#   export CLOUDFLARE_API_TOKEN=...   # User API Token with Zone:Rulesets Read/Edit
#   export ZONE_ID=65b4db3dea0fa79913f7eb1c2a0d9788
#
#   ./scripts/cloudflare-cors-playbook.sh verify
#   ./scripts/cloudflare-cors-playbook.sh show
#   ./scripts/cloudflare-cors-playbook.sh upsert-default
#   ./scripts/cloudflare-cors-playbook.sh add-header dangerously-allow-browser
#   ./scripts/cloudflare-cors-playbook.sh remove-header X-Demo-Header
#   ./scripts/cloudflare-cors-playbook.sh set-acao "*"
#   ./scripts/cloudflare-cors-playbook.sh set-methods "GET, POST, HEAD, OPTIONS"
#   ./scripts/cloudflare-cors-playbook.sh set-max-age 600
#
# Notes
# - This script never prints your token. It uses it only for Authorization.
# - The rule is identified by ref "cors_set_headers". Safe to re-run anytime.
# - Host/path/method expression is scoped to $HOST and /v1/*.
#
set -euo pipefail

require() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
require curl; require jq; require sed; require awk

CF_API_TOKEN=${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}
ZONE_ID=${ZONE_ID:-}
HOST=${HOST:-${DOMAIN:-}}
PATH_PREFIX=${PATH_PREFIX:-/v1/}

if [[ -z "$CF_API_TOKEN" || -z "$ZONE_ID" ]]; then
  echo "Set CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) and ZONE_ID env vars." >&2
  exit 2
fi

if [[ -z "$HOST" ]]; then
  echo "Set HOST (or DOMAIN) env var for the target hostname." >&2
  exit 2
fi

api() {
  # $1 method, $2 path, $3 data-file(optional)
  local m="$1"; shift
  local p="$1"; shift
  local url="https://api.cloudflare.com/client/v4${p}"
  if [[ $# -gt 0 ]]; then
    curl -sS -X "$m" -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' "$url" --data @"$1"
  else
    curl -sS -X "$m" -H "Authorization: Bearer $CF_API_TOKEN" "$url"
  fi
}

verify_token() {
  api GET "/user/tokens/verify" | jq -r '.success as $s | if $s then "ok" else (.errors|tostring) end'
}

get_ruleset_id() {
  local id
  id=$(api GET "/zones/$ZONE_ID/rulesets/phases/http_response_headers_transform/entrypoint" | jq -r '.result.id // empty')
  if [[ -z "$id" ]]; then
    id=$(api GET "/zones/$ZONE_ID/rulesets" | jq -r '.result[]? | select(.phase=="http_response_headers_transform").id' | head -n1)
  fi
  echo "$id"
}

fetch_ruleset() {
  local id; id=$(get_ruleset_id)
  if [[ -z "$id" ]]; then echo ""; return; fi
  api GET "/zones/$ZONE_ID/rulesets/$id"
}

write_tmp() { local f; f=$(mktemp); cat > "$f"; echo "$f"; }

cors_rule_json() {
  cat << JSON
{
  "action": "rewrite",
  "ref": "cors_set_headers",
  "description": "CORS for $HOST",
  "enabled": true,
  "expression": "(http.host eq \"$HOST\") and (http.request.method in {\"GET\" \"POST\" \"HEAD\" \"OPTIONS\"}) and starts_with(http.request.uri.path, \"$PATH_PREFIX\")",
  "action_parameters": {
    "headers": {
      "Access-Control-Allow-Origin":  { "operation": "set", "value": "*" },
      "Access-Control-Allow-Methods": { "operation": "set", "value": "GET, POST, HEAD, OPTIONS" },
      "Access-Control-Allow-Headers": { "operation": "set", "value": "Authorization, Content-Type, Accept, OpenAI-Organization, OpenAI-Beta, X-Requested-With, X-Stainless-OS, X-Stainless-Lang, X-Stainless-Arch, X-Stainless-Runtime, X-Stainless-Runtime-Version, X-Stainless-Package-Version, X-Stainless-Timeout, X-Stainless-Retry-Count, dangerously-allow-browser" },
      "Access-Control-Max-Age":      { "operation": "set", "value": "600" }
    }
  }
}
JSON
}

upsert_rule() {
  local rs resp ok out
  rs=$(fetch_ruleset)
  if [[ -z "$rs" ]]; then
    # create ruleset with our rule
    local body; body=$(jq -n --argjson rule "$(cors_rule_json)" '{name:"zone-rht", description:"Response header transforms", kind:"zone", phase:"http_response_headers_transform", rules:[$rule]}')
    resp=$(write_tmp <<< "$body"); out=$(api POST "/zones/$ZONE_ID/rulesets" "$resp"); rm -f "$resp"
    echo "$out" | jq -r '.success, (.errors // empty)'
    return
  fi
  # update existing
  local rule; rule=$(cors_rule_json)
  local tmp; tmp=$(write_tmp <<< "$rs")
  local upd; upd=$(jq --slurpfile new <(printf '%s' "$rule") '
    .result | .rules = ( .rules
      | (map(select(.ref=="cors_set_headers").ref) | length) as $has
      | if $has>0 then map(if .ref=="cors_set_headers" then $new[0] else . end) else . + $new end )
    | {name, description, kind, phase, rules}' "$tmp")
  rm -f "$tmp"
  local id; id=$(printf '%s' "$rs" | jq -r '.result.id')
  local j; j=$(write_tmp <<< "$upd"); out=$(api PUT "/zones/$ZONE_ID/rulesets/$id" "$j"); rm -f "$j"
  echo "$out" | jq -r '.success, (.errors // empty)'
}

show() {
  local rs; rs=$(fetch_ruleset)
  if [[ -z "$rs" ]]; then echo "no ruleset"; exit 1; fi
  echo "$rs" | jq -r '.result.rules[] | select(.ref=="cors_set_headers").action_parameters.headers'
}

patch_headers_field() {
  local field="$1"; shift
  local value="$1"; shift
  local rs; rs=$(fetch_ruleset)
  [[ -n "$rs" ]] || { echo "no ruleset"; exit 1; }
  local id; id=$(echo "$rs" | jq -r '.result.id')
  local upd; upd=$(echo "$rs" | jq --arg f "$field" --arg v "$value" '
    .result | .rules = (.rules | map(if .ref=="cors_set_headers" then (.action_parameters.headers[$f].value=$v) else . end))
    | {name, description, kind, phase, rules}
  ')
  local j; j=$(write_tmp <<< "$upd"); out=$(api PUT "/zones/$ZONE_ID/rulesets/$id" "$j"); rm -f "$j"
  echo "$out" | jq -r '.success, (.errors // empty)'
}

add_header() {
  local name="$1"
  local rs; rs=$(fetch_ruleset)
  [[ -n "$rs" ]] || { echo "no ruleset"; exit 1; }
  local val; val=$(echo "$rs" | jq -r '.result.rules[] | select(.ref=="cors_set_headers").action_parameters.headers["Access-Control-Allow-Headers"].value')
  if echo "$val" | tr 'A-Z' 'a-z' | grep -q "\b$(echo "$name" | tr 'A-Z' 'a-z')\b"; then echo "already present"; return; fi
  local newv; newv=$(printf '%s%s%s' "$val" ", " "$name" | sed 's/^, //')
  patch_headers_field "Access-Control-Allow-Headers" "$newv"
}

remove_header() {
  local name="$1"
  local rs; rs=$(fetch_ruleset)
  [[ -n "$rs" ]] || { echo "no ruleset"; exit 1; }
  local val; val=$(echo "$rs" | jq -r '.result.rules[] | select(.ref=="cors_set_headers").action_parameters.headers["Access-Control-Allow-Headers"].value')
  local newv; newv=$(echo "$val" | awk -v rm="$name" 'BEGIN{IGNORECASE=1; FS=", *"} {for(i=1;i<=NF;i++){if(tolower($i)!=tolower(rm)) a[++n]=$i} } END{for(i=1;i<=n;i++){printf i==n? "%s" : "%s, ", a[i]}}')
  patch_headers_field "Access-Control-Allow-Headers" "$newv"
}

cmd=${1:-}
case "$cmd" in
  verify)
    verify_token ;;
  show)
    show ;;
  upsert-default)
    upsert_rule ;;
  add-header)
    shift; add_header "${1:?header name required}" ;;
  remove-header)
    shift; remove_header "${1:?header name required}" ;;
  set-acao)
    shift; patch_headers_field "Access-Control-Allow-Origin" "${1:?origin required}" ;;
  set-methods)
    shift; patch_headers_field "Access-Control-Allow-Methods" "${1:?methods string}" ;;
  set-max-age)
    shift; patch_headers_field "Access-Control-Max-Age" "${1:?seconds}" ;;
  *)
    echo "Usage: $0 {verify|show|upsert-default|add-header NAME|remove-header NAME|set-acao VALUE|set-methods VALUE|set-max-age SECONDS}" >&2
    exit 64 ;;
esac
