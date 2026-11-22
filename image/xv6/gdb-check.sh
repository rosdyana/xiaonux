#!/bin/bash
# gdb remote check for the native xv6-virt machine (temu's XIAONUX_GDB_PORT).
# Starts temu halted (XIAONUX_GDB_WAIT=1), runs gdb-multiarch in batch mode
# over RSP, and checks the expected stops. `kill` must make temu exit.
#
# usage: gdb-check.sh <temu> <fixture-dir> [port]
# Needs gdb-multiarch. Set GDB_DEBUG_REMOTE=1 to log the RSP traffic.
set -uo pipefail

if [ $# -lt 2 ]; then
    sed -n '2,7p' "$0"; exit 2
fi
temu="$1"
dir="$(cd "$2" && pwd)"
port="${3:-26000}"
for f in kernel kernel.bin fs.img; do
    if [ ! -f "$dir/$f" ]; then echo "missing $dir/$f" >&2; exit 2; fi
done
if ! command -v gdb-multiarch >/dev/null; then
    echo "gdb-multiarch not found (sudo apt-get install -y gdb-multiarch)" >&2; exit 2
fi

cat > "$dir/xv6.cfg" <<'CFG'
{ version: 1, machine: "xv6-virt", memory_size: 128, bios: "kernel.bin", drive0: { file: "fs.img" } }
CFG

work="$(mktemp -d)"
out="$work/temu.out"
fifo="$work/stdin"
gdbcmds="$work/gdb.cmds"
gdbout="$work/gdb.out"
trap 'kill $temu_pid 2>/dev/null; kill $hold_pid 2>/dev/null; rm -rf "$work"' EXIT

# temu's console reads stdin; keep a writer open so it never sees EOF.
mkfifo "$fifo"
sleep 900 > "$fifo" &
hold_pid=$!

XIAONUX_GDB_PORT="$port" XIAONUX_GDB_WAIT=1 "$temu" "$dir/xv6.cfg" < "$fifo" > "$out" 2>&1 &
temu_pid=$!

# Wait for the listen line; do not connect to the port (the stub takes one
# client, and EOF from a probe would detach and resume the machine).
for _ in $(seq 1 100); do
    grep -q "gdb stub listening" "$out" 2>/dev/null && break
    kill -0 "$temu_pid" 2>/dev/null || break
    sleep 0.1
done
if ! grep -q "gdb stub listening" "$out"; then
    echo "FAIL: temu did not start the gdb stub" >&2; cat "$out" >&2; exit 1
fi

{
    echo "set pagination off"
    echo "set confirm off"
    if [ -n "${GDB_DEBUG_REMOTE:-}" ]; then echo "set debug remote 1"; fi
    echo "set architecture riscv:rv64"
    echo "target remote 127.0.0.1:$port"
    echo "symbol-file $dir/kernel"
    echo "set riscv use-compressed-breakpoints yes"
    echo "info registers pc"
    echo "break main"
    echo "continue"
    echo "bt"
    echo "stepi"
    echo "x/2i \$pc"
    echo "print cpus[0].noff"
    echo "break userinit"
    echo "continue"
    echo "delete"
    echo "kill"
} > "$gdbcmds"

gdb-multiarch -batch -nx -x "$gdbcmds" > "$gdbout" 2>&1
gdb_rc=$?
cat "$gdbout"

ok=1
expect() {
    if ! grep -Eq "$1" "$gdbout"; then
        echo "FAIL: gdb output has no line matching: $1" >&2
        ok=0
    fi
}
[ "$gdb_rc" -eq 0 ] || { echo "FAIL: gdb exited $gdb_rc" >&2; ok=0; }
expect '^pc +0x1000'
expect '^Breakpoint 1 at 0x[0-9a-f]+'
expect '^Breakpoint 1, main '
expect '^#0 +main'
expect '^=> 0x[0-9a-f]+'
expect '^\$[0-9]+ = [0-9]+'
expect '^Breakpoint 2, userinit'

# `kill` sends k: temu must exit on its own.
exited=0
for _ in $(seq 1 100); do
    if ! kill -0 "$temu_pid" 2>/dev/null; then exited=1; break; fi
    sleep 0.1
done
if [ "$exited" = 0 ]; then
    echo "FAIL: temu still running 10s after kill" >&2; ok=0
else
    wait "$temu_pid"; echo "temu exit status: $?"
fi
echo "--- temu output (tail)"; tail -n 5 "$out"

if [ "$ok" = 1 ]; then echo "gdb-check: PASS"; exit 0; fi
echo "gdb-check: FAIL" >&2
exit 1
