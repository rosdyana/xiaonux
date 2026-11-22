#!/usr/bin/env bash
# xiaonux: boot an xv6 fixture on the native temu (xv6-virt machine profile).
#
# Usage: image/xv6/native-boot.sh <fixture-dir> [--usertests]
#
# Writes <fixture-dir>/xv6.cfg, boots it under bench/boot-native.py, runs `ls`
# and, with --usertests, `usertests -q`. Exits 0 only if the transcript shows
# `init` after `ls` (and "ALL TESTS PASSED" with --usertests).
set -uo pipefail

usertests=0
dir=""
for arg in "$@"; do
    case "$arg" in
        --usertests) usertests=1 ;;
        -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
        *) dir="$arg" ;;
    esac
done
if [ -z "$dir" ] || [ ! -f "$dir/kernel.bin" ] || [ ! -f "$dir/fs.img" ]; then
    echo "usage: $0 <fixture-dir> [--usertests]  (dir must hold kernel.bin and fs.img)" >&2
    exit 2
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$(cd "$dir" && pwd)"
temu="$root/build/emu-native/temu"
if [ ! -x "$temu" ]; then
    echo "missing $temu (run: make emu)" >&2
    exit 2
fi

cat > "$dir/xv6.cfg" <<'EOF'
{ version: 1, machine: "xv6-virt", memory_size: 128, bios: "kernel.bin", drive0: { file: "fs.img" } }
EOF

args=(--prompt '\$ $')
if [ "$usertests" = 1 ]; then args+=(--timeout 3600); fi
args+=(--cmd ls)
if [ "$usertests" = 1 ]; then args+=(--cmd 'usertests -q'); fi

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

start=$SECONDS
python3 "$root/bench/boot-native.py" "$temu" "$dir/xv6.cfg" "${args[@]}" 2>&1 | tee "$out"
rc=${PIPESTATUS[0]}
wall=$((SECONDS - start))

ok=1
if [ "$rc" -ne 0 ]; then
    echo "FAIL: boot-native exited $rc" >&2
    ok=0
fi
if ! tr -d '\r' < "$out" | awk '
    /(^|[ $])ls[ \t]*$/ { seen = 1; next }
    seen && /(^|[^A-Za-z0-9_])init([^A-Za-z0-9_]|$)/ { found = 1 }
    END { exit !found }'; then
    echo "FAIL: no 'init' listed after 'ls'" >&2
    ok=0
fi
if [ "$usertests" = 1 ] && ! grep -q "ALL TESTS PASSED" "$out"; then
    echo "FAIL: usertests did not print ALL TESTS PASSED" >&2
    ok=0
fi

echo "native-boot: wall ${wall}s, $( [ "$ok" = 1 ] && echo PASS || echo FAIL )" >&2
exit $(( ok ? 0 : 1 ))
