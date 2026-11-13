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

cat > build/site/_headers <<'EOF'
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/vm/chunks/*
  Cache-Control: public, max-age=31536000, immutable
EOF

npm exec --yes -- wrangler@4 pages deploy build/site --project-name="$PROJECT" --branch=main --commit-dirty=true
