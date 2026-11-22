#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Builds the xv6 reference fixtures used by the xv6 lab:
# xv6 master and the lab `util` branches, each built with the cross gcc
# (same major version as the guest's native gcc) and booted on QEMU to prove
# the kernel and fs.img are good. Output: build/xv6/<name>/ and
# build/xv6/manifest.json (both git-ignored).
#
# Run in the builder VM:  orb -m builder sudo image/xv6/build-fixtures.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
XBUILD=${SUDO_USER:+/home/$SUDO_USER/xbuild}
XBUILD=${XBUILD:-$HOME/xbuild}
OWN="${SUDO_UID:-0}:${SUDO_GID:-0}"
TOOLPREFIX=riscv64-linux-gnu-
MASTER_SHA=fa2ddcb
OUT="$REPO/build/xv6"
SRC="$XBUILD/xv6-src"
BOOTDIR="$XBUILD/xv6-boot"

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

# 1. Toolchain and QEMU.
need=""
dpkg -s gcc-riscv64-linux-gnu >/dev/null 2>&1 || need="$need gcc-riscv64-linux-gnu"
dpkg -s qemu-system-misc >/dev/null 2>&1 || need="$need qemu-system-misc"
if [ -n "$need" ]; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends $need
fi
TC="$("${TOOLPREFIX}gcc" --version | head -1)"
echo "$TC"
qemu-system-riscv64 --version | head -1

# 2. Fetch (or update) the source trees and pin them to exact commits.
mkdir -p "$SRC" "$BOOTDIR"
sync_tree() { # name url fetch-refspec checkout-target
  local name=$1 url=$2 refspec=$3 target=$4 d="$SRC/$1"
  if [ ! -d "$d/.git" ]; then
    git init -q "$d"
    git -C "$d" remote add origin "$url"
  fi
  git -C "$d" fetch -q origin "$refspec"
  git -C "$d" checkout -q -f --detach "$target"
  git -C "$d" reset -q --hard
  git -C "$d" clean -qfdx
  git -C "$d" rev-parse HEAD
}
declare -A SHA
SHA[master]=$(sync_tree master https://github.com/mit-pdos/xv6-riscv '+refs/heads/*:refs/remotes/origin/*' "$MASTER_SHA")
case "${SHA[master]}" in "$MASTER_SHA"*) ;; *) echo "master resolved to ${SHA[master]}, expected $MASTER_SHA"; exit 1;; esac
for y in 2024 2025 2026; do
  SHA[labs-$y-util]=$(sync_tree "labs-$y-util" "git://g.csail.mit.edu/xv6-labs-$y" 'util' FETCH_HEAD)
done
echo "resolved:"; for k in "${!SHA[@]}"; do echo "  $k ${SHA[$k]}"; done

# 3. Build, extract the binary kernel, and copy the artifacts.
# The tree is cleaned by `git clean -fdx` above, so each build starts fresh.
# Source trees are the build inputs and are not copied into build/xv6.
build_tree() { # name
  local name=$1 d="$SRC/$1" o="$OUT/$1"
  rm -rf "$o"; mkdir -p "$o"
  make -C "$d" TOOLPREFIX=$TOOLPREFIX CPUS=1 kernel/kernel fs.img > "$o/build.log" 2>&1
  "${TOOLPREFIX}objcopy" -O binary "$d/kernel/kernel" "$d/kernel.bin"
  cp "$d/kernel/kernel" "$o/kernel"
  cp "$d/kernel.bin" "$o/kernel.bin"
  [ -f "$d/kernel/kernel.sym" ] && cp "$d/kernel/kernel.sym" "$o/kernel.sym" || true
  cp "$d/fs.img" "$o/fs.img"
}

# 4. Reference boot: QEMU on a scratch copy of fs.img (usertests writes to it).
# Writes boot.json (the result) and qemu.log next to the fixture.
boot_tree() { # name mode(master|lab)
  local name=$1 mode=$2 o="$OUT/$1"
  cp "$o/fs.img" "$BOOTDIR/$name-fs.img"
  python3 -I - "$o/kernel.bin" "$BOOTDIR/$name-fs.img" "$o/qemu.log" "$mode" 600 > "$o/boot.json" <<'PY'
import json, os, re, select, subprocess, sys, time
kernel, disk, log_path, mode, timeout = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5])
cmd = ["qemu-system-riscv64", "-machine", "virt", "-bios", "none", "-kernel", kernel,
       "-m", "128M", "-smp", "1", "-nographic", "-global", "virtio-mmio.force-legacy=false",
       "-drive", f"file={disk},if=none,format=raw,id=x0",
       "-device", "virtio-blk-device,drive=x0,bus=virtio-mmio-bus.0"]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
fd = p.stdout.fileno()
buf = b""
res = {"boot": "fail", "ls_init": False, "usertests": "n/a", "reason": ""}
state, mark, mark2 = 0, 0, 0
start = time.time()
def send(s):
    p.stdin.write(s); p.stdin.flush()
def quit_qemu():
    try:
        send(b"\x01x")
        p.wait(timeout=10)
    except Exception:
        p.kill()
    p.wait()
while True:
    if time.time() - start > timeout:
        res["reason"] = "timeout"; p.kill(); break
    if select.select([fd], [], [], 0.5)[0]:
        chunk = os.read(fd, 65536)
        if not chunk:
            res["reason"] = res["reason"] or "qemu exited early"
            break
        buf += chunk
    if b"panic:" in buf:
        res["reason"] = "kernel panic"; quit_qemu(); break
    if state == 0:
        if b"$ " in buf:
            mark = len(buf); send(b"ls\n"); state = 1
    elif state == 1:
        i = buf.find(b"$ ", mark)
        if i >= 0:
            res["ls_init"] = bool(re.search(rb"(^|\s)init(\s|$)", buf[mark:i], re.M))
            res["boot"] = "ok" if res["ls_init"] else "fail"
            if not res["ls_init"]:
                res["reason"] = "ls did not list init"
            if mode == "master":
                mark2 = len(buf); send(b"usertests -q\n"); state = 2
            else:
                quit_qemu(); break
    elif state == 2:
        seg = buf[mark2:]
        if b"ALL TESTS PASSED" in seg:
            res["usertests"] = "pass"; quit_qemu(); break
        if b"SOME TESTS FAILED" in seg:
            res["usertests"] = "fail"; res["reason"] = "usertests reported failures"; quit_qemu(); break
    if state == 0 and time.time() - start > 120 and not buf:
        res["reason"] = "no output"; p.kill(); break
res["elapsed_s"] = round(time.time() - start, 1)
if state == 0 and res["reason"] == "":
    res["reason"] = "no shell prompt"
if mode == "master" and res["usertests"] != "pass" and res["reason"] == "":
    res["reason"] = "usertests did not finish"
open(log_path, "wb").write(buf)
print(json.dumps(res))
if res["boot"] != "ok" or (mode == "master" and res["usertests"] != "pass"):
    sys.exit(3)
PY
  rm -f "$BOOTDIR/$name-fs.img"
  # Fail the script when a fixture did not boot (the manifest still records it).
  python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["boot"]=="ok" else 1)' "$o/boot.json"
}

status=0
for name in master labs-2024-util labs-2025-util labs-2026-util; do
  echo "== $name"
  case $name in
    master) build_tree master; mode=master ;;
    *) build_tree "$name"; mode=lab ;;
  esac
  echo "${SHA[$name]}" > "$OUT/$name/commit"
  boot_tree "$name" "$mode" || { echo "  boot FAILED for $name (see $OUT/$name/boot.json)"; status=1; }
  echo "  $(cat "$OUT/$name/boot.json")"
done

# 5. Manifest.
python3 -I - "$OUT" "$TC" <<'PY' > "$OUT/manifest.json.tmp"
import hashlib, json, os, sys
out = sys.argv[1]
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()
trees = {}
for name in ["master", "labs-2024-util", "labs-2025-util", "labs-2026-util"]:
    d = os.path.join(out, name)
    boot = json.load(open(os.path.join(d, "boot.json")))
    t = {"kernel_bytes": os.path.getsize(os.path.join(d, "kernel")),
         "kernel_bin_bytes": os.path.getsize(os.path.join(d, "kernel.bin")),
         "fs_img_bytes": os.path.getsize(os.path.join(d, "fs.img")),
         "kernel_bin_sha256": sha(os.path.join(d, "kernel.bin")),
         "fs_img_sha256": sha(os.path.join(d, "fs.img")),
         "commit": open(os.path.join(d, "commit")).read().strip(),
         "boot": boot["boot"], "usertests": boot["usertests"],
         "boot_elapsed_s": boot.get("elapsed_s"), "reason": boot.get("reason", "")}
    trees[name] = t
print(json.dumps({"toolchain": sys.argv[2], "trees": trees}, indent=2))
PY
mv "$OUT/manifest.json.tmp" "$OUT/manifest.json"
chown -R "$OWN" "$OUT" "$SRC"
cat "$OUT/manifest.json"
exit $status
