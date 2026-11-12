#!/usr/bin/env bash
# Build riscv64 wheels for popular packages that PyPI doesn't ship for riscv64.
# Runs inside the builder VM (qemu-user riscv64 chroot; slow but exact):
#   orb -m builder sudo image/build-wheels.sh [package ...]
# Output: build/wheels/*.whl  (linux_riscv64, for the xiaonux Debian 13 image)
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
. "$REPO/image/versions.sh"
XBUILD=${SUDO_USER:+/home/$SUDO_USER/xbuild}
XBUILD=${XBUILD:-$HOME/xbuild}
CHROOT="$XBUILD/wheel-chroot"
OUT="$REPO/build/wheels"
PKGS=("$@")
[ ${#PKGS[@]} -gt 0 ] || PKGS=(numpy pyyaml psutil cffi pillow cryptography orjson pandas)

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
mkdir -p "$OUT"

if [ ! -x "$CHROOT/usr/bin/python3" ]; then
  echo "== riscv64 build chroot"
  mmdebstrap --arch=riscv64 --variant=buildd \
    --include=python3-dev,python3-pip,python3-venv,pkg-config,ninja-build,cmake,patchelf,\
libffi-dev,libssl-dev,libyaml-dev,libjpeg-dev,zlib1g-dev,libpng-dev,libfreetype-dev,\
rustc,cargo,ca-certificates,curl \
    "$DEBIAN_SUITE" "$CHROOT" http://deb.debian.org/debian
  printf '[global]\nbreak-system-packages = true\n' > "$CHROOT/etc/pip.conf"
fi

cp /etc/resolv.conf "$CHROOT/etc/resolv.conf"
mkdir -p "$CHROOT/wheels" "$CHROOT/proc" "$CHROOT/dev"
mountpoint -q "$CHROOT/proc" || mount -t proc proc "$CHROOT/proc"
mountpoint -q "$CHROOT/dev" || mount --bind /dev "$CHROOT/dev"
trap 'umount "$CHROOT/proc" "$CHROOT/dev" 2>/dev/null || true' EXIT

for p in "${PKGS[@]}"; do
  if ls "$CHROOT/wheels" | grep -qi "^${p//-/_}-"; then
    echo "== $p: already built"
    continue
  fi
  echo "== $p ($(date +%T))"
  t0=$(date +%s)
  # --find-links: later builds (pandas) pick up our numpy instead of compiling it again
  chroot "$CHROOT" env CARGO_NET_GIT_FETCH_WITH_CLI=true MAKEFLAGS=-j"$(nproc)" \
    python3 -m pip wheel --no-deps --no-binary=":none:" --find-links /wheels -w /wheels "$p" \
    > "$XBUILD/wheel-$p.log" 2>&1 || { echo "   FAILED (see $XBUILD/wheel-$p.log)"; tail -5 "$XBUILD/wheel-$p.log"; continue; }
  echo "   ok in $(( $(date +%s) - t0 ))s"
done

cp -u "$CHROOT"/wheels/*.whl "$OUT/" 2>/dev/null || true
chown -R "${SUDO_UID:-0}:${SUDO_GID:-0}" "$OUT"
ls -la "$OUT"
