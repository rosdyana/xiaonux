#!/usr/bin/env bash
# Build OpenSBI fw_jump.bin (generic platform) -> build/fw_jump.bin.
# Runs inside the builder VM: orb -m builder image/build-opensbi.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
. "$REPO/image/versions.sh"

mkdir -p "$XBUILD" "$REPO/build"
cd "$XBUILD"
if [ ! -d "opensbi-$OPENSBI_VERSION" ]; then
  git clone -q --depth 1 --branch "v$OPENSBI_VERSION" \
    https://github.com/riscv-software-src/opensbi "opensbi-$OPENSBI_VERSION"
fi
cd "opensbi-$OPENSBI_VERSION"
# fw_jump defaults on generic: kernel at FW_TEXT_START + 0x200000 = 0x80200000,
# which matches where TinyEMU's loader puts the kernel (2 MB aligned after bios).
make -s -j"$(nproc)" CROSS_COMPILE="$CROSS_COMPILE" PLATFORM=generic FW_JUMP=y FW_PAYLOAD=n FW_DYNAMIC=n
cp build/platform/generic/firmware/fw_jump.bin "$REPO/build/fw_jump.bin"
ls -l "$REPO/build/fw_jump.bin"
