#!/usr/bin/env bash
# Deploy the xiaonux relay to Cloudflare Workers (free tier) and wire it up.
#   1. wrangler deploy
#   2. SESSION_KEY secret (random, generated here, never printed)
#   3. Turnstile widget for the page's domains (created once; reused if it exists)
#      + TURNSTILE_SECRET secret
#   4. web/.env.local with VITE_RELAY_URL and VITE_TURNSTILE_SITEKEY
# Usage: relay/deploy.sh [page-domain ...]   (default: localhost)
set -euo pipefail
cd "$(dirname "$0")"
WRANGLER=./node_modules/.bin/wrangler
DOMAINS=("${@:-localhost}")

[ -x "$WRANGLER" ] || pnpm install
echo "== deploy"
out=$("$WRANGLER" deploy 2>&1) || { echo "$out"; exit 1; }
url=$(printf '%s\n' "$out" | grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' | head -n1)
[ -n "$url" ] || { echo "$out"; echo "could not find the workers.dev URL"; exit 1; }
echo "relay: $url"

echo "== SESSION_KEY"
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | "$WRANGLER" secret put SESSION_KEY >/dev/null
echo "set"

echo "== Turnstile"
account=$("$WRANGLER" whoami 2>/dev/null | grep -Eo '\b[0-9a-f]{32}\b' | head -n1)
token=$(grep -E '^oauth_token' ~/Library/Preferences/.wrangler/config/default.toml 2>/dev/null \
        || grep -E '^oauth_token' ~/.config/.wrangler/config/default.toml)
token=${token#*\"}; token=${token%\"*}
api="https://api.cloudflare.com/client/v4/accounts/$account/challenges/widgets"
existing=$(curl -fsS -H "Authorization: Bearer $token" "$api?per_page=50" |
  python3 -c 'import json,sys; r=[w for w in json.load(sys.stdin)["result"] if w["name"]=="xiaonux"]; print(r[0]["sitekey"] if r else "")')
if [ -n "$existing" ]; then
  sitekey=$existing
  secret=$(curl -fsS -X POST -H "Authorization: Bearer $token" "$api/$sitekey/rotate_secret" \
           -H 'content-type: application/json' -d '{"invalidate_immediately":true}' |
           python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["secret"])')
  echo "reusing widget $sitekey (secret rotated)"
else
  body=$(python3 -c 'import json,sys; print(json.dumps({"name":"xiaonux","mode":"managed","domains":sys.argv[1:]}))' "${DOMAINS[@]}")
  res=$(curl -fsS -X POST -H "Authorization: Bearer $token" -H 'content-type: application/json' "$api" -d "$body")
  sitekey=$(printf '%s' "$res" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["sitekey"])')
  secret=$(printf '%s' "$res" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["secret"])')
  echo "created widget $sitekey for ${DOMAINS[*]}"
fi
printf '%s' "$secret" | "$WRANGLER" secret put TURNSTILE_SECRET >/dev/null
echo "TURNSTILE_SECRET set"

cat > ../web/.env.local <<EOF
VITE_RELAY_URL=$url
VITE_TURNSTILE_SITEKEY=$sitekey
EOF
echo "== wrote web/.env.local (restart make dev to pick it up)"
