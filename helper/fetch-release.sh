#!/usr/bin/env bash
# Point the page's helper downloads at a GitHub release built by
# .github/workflows/helper-release.yml. Writes dist/vm/helper/latest.json and
# SHA256SUMS only; latest.json's "base" makes the page link to GitHub for the
# binaries themselves.
# Usage: helper/fetch-release.sh [helper-vX.Y.Z]   (default: newest helper-v* release)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=${XIAONUX_REPO:-rosdyana/xiaonux}
OUT=dist/vm/helper
tag=${1:-}

if [ -z "$tag" ]; then
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=50" | python3 -c '
import json, sys
tags = [r["tag_name"] for r in json.load(sys.stdin)
        if r["tag_name"].startswith("helper-v") and not r["draft"] and not r["prerelease"]]
print(tags[0] if tags else "")')
  [ -n "$tag" ] || { echo "no helper-v* release in $REPO yet: push a helper-vX.Y.Z tag first" >&2; exit 1; }
fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for f in latest.json SHA256SUMS; do
  curl -fsSL -o "$tmp/$f" "https://github.com/$REPO/releases/download/$tag/$f"
done
rm -rf "$OUT"; mkdir -p "$OUT"; cp "$tmp/latest.json" "$tmp/SHA256SUMS" "$OUT/"
echo "$OUT now points at $tag"
