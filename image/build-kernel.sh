#!/usr/bin/env bash
# Build Linux (riscv64) -> build/Image (raw image TinyEMU can load) + build/kernel.config.
# Runs inside the builder VM: orb -m builder image/build-kernel.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
. "$REPO/image/versions.sh"

mkdir -p "$XBUILD" "$REPO/build"
cd "$XBUILD"
SRC="linux-$LINUX_VERSION"
if [ ! -d "$SRC" ]; then
  curl -fsSLO "https://cdn.kernel.org/pub/linux/kernel/v6.x/$SRC.tar.xz"
  tar -xf "$SRC.tar.xz"
  rm "$SRC.tar.xz"
fi
cd "$SRC"
export ARCH=riscv CROSS_COMPILE
make -s defconfig
scripts/kconfig/merge_config.sh -m .config "$REPO/image/kernel.config" >/dev/null
make -s olddefconfig
# Fail loudly if a fragment option didn't stick (dependency pulled it back).
missing=0
while read -r line; do
  case "$line" in
    CONFIG_*=*) grep -qx "$line" .config || { echo "not applied: $line"; missing=1; } ;;
    "# CONFIG_"*" is not set")
      opt=${line#\# }; opt=${opt%% *}
      grep -q "^$opt=" .config && { echo "still set: $opt"; missing=1; } ;;
  esac
done < "$REPO/image/kernel.config"
[ "$missing" = 0 ] || echo "warning: some fragment options were overridden (see above)"

make -s -j"$(nproc)" Image
cp arch/riscv/boot/Image "$REPO/build/Image"
cp .config "$REPO/build/kernel.config"
ls -l "$REPO/build/Image"
