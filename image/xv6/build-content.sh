#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Makes the xv6 source bundles that build-rootfs.sh ships in the Debian image:
# every branch of the MIT 6.1810 lab repos (2024-2026) and xv6-riscv master.
# The lab repos are cloned as mirrors (so --all carries every branch). xv6-riscv
# is fetched for branches and tags only: a mirror clone would also fetch its
# 479 refs/pull/* (GitHub PR refs), so that mirror is a bare repo with explicit
# refspecs, rebuilt from scratch on every run. Each bundle is verified. Output in
# ~/xbuild/xv6-content/: <name>.bundle, manifest.json and LICENSE.xv6
# (git-ignored build output).
#
# Run in the builder VM as the normal user (no sudo; git needs no root):
#   orb -m builder image/xv6/build-content.sh
set -euo pipefail
XBUILD=${XBUILD:-$HOME/xbuild}
OUT="$XBUILD/xv6-content"
MIRRORS="$XBUILD/xv6-mirrors"
# Lab repos are cloned only over git:// (https to github.com is blocked for labs).
REPOS=(
  "xv6-labs-2026 git://g.csail.mit.edu/xv6-labs-2026"
  "xv6-labs-2025 git://g.csail.mit.edu/xv6-labs-2025"
  "xv6-labs-2024 git://g.csail.mit.edu/xv6-labs-2024"
  "xv6-riscv https://github.com/mit-pdos/xv6-riscv"
)

[ "$(id -u)" != 0 ] || { echo "run as the normal user, not root"; exit 1; }
mkdir -p "$OUT" "$MIRRORS"

# Repos fetched for branches and tags only (no refs/pull/*).
BRANCHES_ONLY=(xv6-riscv)

for entry in "${REPOS[@]}"; do
  read -r name url <<<"$entry"
  m="$MIRRORS/$name.git"
  if [[ " ${BRANCHES_ONLY[*]} " == *" $name "* ]]; then
    rm -rf "$m"
    git init -q --bare "$m"
    git -C "$m" remote add origin "$url"
    git -C "$m" config remote.origin.fetch '+refs/heads/*:refs/heads/*'
    git -C "$m" config --add remote.origin.fetch '+refs/tags/*:refs/tags/*'
    git -C "$m" fetch -q origin
    # Point HEAD at the remote's default branch (a fresh bare repo may default to another name).
    default=$(git ls-remote --symref "$url" HEAD | awk '/^ref:/ { sub("refs/heads/", "", $2); print $2; exit }')
    git -C "$m" symbolic-ref HEAD "refs/heads/$default"
    # HEAD is listed explicitly so the bundle has a default branch to check out.
    git -C "$m" bundle create "$OUT/$name.bundle" --branches --tags HEAD
    prs=$(git -C "$m" for-each-ref refs/pull | wc -l)
    [ "$prs" -eq 0 ] || { echo "$name: $prs refs/pull in the mirror"; exit 1; }
  else
    if [ -d "$m" ]; then
      git -C "$m" remote update --prune >/dev/null
    else
      git clone -q --mirror "$url" "$m"
    fi
    git -C "$m" bundle create "$OUT/$name.bundle" --all
  fi
  git bundle verify -q "$OUT/$name.bundle"
  # No bundle may carry refs/pull/* (checked on the bundle itself).
  pulls=$(git bundle list-heads "$OUT/$name.bundle" | grep -c 'refs/pull/' || true)
  [ "$pulls" -eq 0 ] || { echo "$name: bundle has $pulls refs/pull/* refs"; exit 1; }
  echo "$name: $(git bundle list-heads "$OUT/$name.bundle" | grep -c refs/heads/) branches, $(git bundle list-heads "$OUT/$name.bundle" | grep -c refs/tags/) tags, $(stat -c %s "$OUT/$name.bundle") bytes"
done

# Licenses: each repo's LICENSE must be the MIT text. Ship one copy.
for entry in "${REPOS[@]}"; do
  read -r name _ <<<"$entry"
  lic=$(git -C "$MIRRORS/$name.git" show HEAD:LICENSE)
  for phrase in "Permission is hereby granted" "Massachusetts Institute of Technology"; do
    grep -q "$phrase" <<<"$lic" || { echo "$name: LICENSE is not the MIT text (missing: $phrase)"; exit 1; }
  done
done
git -C "$MIRRORS/xv6-riscv.git" show HEAD:LICENSE > "$OUT/LICENSE.xv6"

# Manifest: the commit of every branch head, per repo.
python3 - "$OUT" "$MIRRORS" "${REPOS[@]}" <<'PY'
import json, os, subprocess, sys
out, mirrors = sys.argv[1], sys.argv[2]
man = {"license": "MIT (LICENSE.xv6)", "repos": {}}
for entry in sys.argv[3:]:
    name, url = entry.split(" ", 1)
    m = os.path.join(mirrors, name + ".git")
    heads = {}
    for line in subprocess.check_output(["git", "-C", m, "for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads"], text=True).splitlines():
        sha, ref = line.split(" ", 1)
        heads[ref] = sha
    head = subprocess.check_output(["git", "-C", m, "rev-parse", "HEAD"], text=True).strip()
    man["repos"][name] = {
        "source": url,
        "bundle": name + ".bundle",
        "bundle_bytes": os.path.getsize(os.path.join(out, name + ".bundle")),
        "default_head": head,
        "branches": dict(sorted(heads.items())),
    }
with open(os.path.join(out, "manifest.json"), "w") as f:
    json.dump(man, f, indent=2)
    f.write("\n")
print(json.dumps({k: {"branches": len(v["branches"]), "bundle_bytes": v["bundle_bytes"], "default_head": v["default_head"]} for k, v in man["repos"].items()}, indent=1))
PY
ls -l "$OUT"
