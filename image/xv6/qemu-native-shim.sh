#!/bin/sh
# Test-only stand-in for qemu-system-riscv64, so the MIT labs grader
# (gradelib, `make grade`) can drive the native xv6-virt machine (temu).
# Put it on PATH as qemu-system-riscv64. Browser transport: Phase 3.
#
# Env: XN_TEMU        Linux temu binary (required)
#      XN_OBJCOPY     objcopy for riscv64 (default riscv64-linux-gnu-objcopy)
# Handles the options the labs Makefile passes: -kernel, -drive file=,
# -gdb tcp::PORT, -S, -m, and ignores the rest. -S starts temu halted
# until gdb sends c or s. The drive is opened read-write (QEMU semantics).
set -eu

case "${1:-}" in
    --version) echo "QEMU emulator version 10.0.0 (xiaonux native shim)"; exit 0 ;;
    -help|--help) echo "-gdb dev       accept gdb connections on a TCP port (native shim)"; exit 0 ;;
esac

kernel=""; drive=""; gdbport=""; halt=0; mem=128
while [ $# -gt 0 ]; do
    case "$1" in
        -kernel) kernel="$2"; shift 2 ;;
        -drive)
            drive="$(printf '%s' "$2" | sed -n 's/.*file=\([^,]*\).*/\1/p')"
            shift 2 ;;
        -gdb) gdbport="$(printf '%s' "$2" | sed 's/.*://')"; shift 2 ;;
        -S) halt=1; shift ;;
        -m) mem="$(printf '%s' "$2" | sed 's/[Mm]$//')"; shift 2 ;;
        -machine|-bios|-smp|-global|-device|-netdev|-object) shift 2 ;;
        *) shift ;;
    esac
done

if [ -z "${XN_TEMU:-}" ] || [ ! -x "$XN_TEMU" ]; then
    echo "qemu-native-shim: set XN_TEMU to a Linux temu binary" >&2; exit 2
fi
if [ -z "$kernel" ] || [ -z "$drive" ]; then
    echo "qemu-native-shim: need -kernel and -drive file=" >&2; exit 2
fi

kdir="$(cd "$(dirname "$kernel")" && pwd)"
kbin="$kdir/kernel.native.bin"
"${XN_OBJCOPY:-riscv64-linux-gnu-objcopy}" -O binary "$kernel" "$kbin"
fs="$(cd "$(dirname "$drive")" && pwd)/$(basename "$drive")"

cfg="$kdir/native-shim.cfg"
cat > "$cfg" <<CFG
{ version: 1, machine: "xv6-virt", memory_size: $mem, bios: "$kbin", drive0: { file: "$fs" } }
CFG

if [ -n "$gdbport" ]; then
    export XIAONUX_GDB_PORT="$gdbport"
fi
if [ "$halt" = 1 ]; then
    export XIAONUX_GDB_WAIT=1
fi
# exec: make's SIGTERM on kill then reaches temu itself.
exec "$XN_TEMU" -rw "$cfg"
