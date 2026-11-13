#!/usr/bin/env bash
# Build the page and publish it plus dist/vm to Cloudflare Pages.
set -euo pipefail
PROJECT=xiaonux
cd "$(git rev-parse --show-toplevel)"

test -f dist/vm/boot.json || { echo "dist/vm is missing: run make stage-snapshot first"; exit 1; }
make web

rm -rf build/site && mkdir -p build/site
cp -R web/dist/. build/site/
cp -R dist/vm build/site/vm

# The relay URL is baked into the build from web/.env.local; the policy must allow it.
RELAY_URL=$(grep -E '^VITE_RELAY_URL=' web/.env.local 2>/dev/null | cut -d= -f2- | tr -d "\"'\r" || true)
CSP=$(node web/csp.mjs "$RELAY_URL")
test -n "$CSP" || { echo "empty Content-Security-Policy"; exit 1; }

cat > build/site/_headers <<EOF
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: $CSP

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/vm/chunks/*
  Cache-Control: public, max-age=31536000, immutable
EOF

npm exec --yes -- wrangler@4 pages deploy build/site --project-name="$PROJECT" --branch=main --commit-dirty=true
