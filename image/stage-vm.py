#!/usr/bin/env python3
"""Stage a bootable VM for the browser into dist/vm.

Copies the WASM build, firmware and kernel, writes a TinyEMU .cfg and a
boot.json descriptor, and converts the root filesystem:
  --format chunks (default, Phase 2): Brotli chunks + manifest via chunk.py.
    Chunks are kept between runs (content-addressed), so restaging is fast.
  --format blk (Phase 1): TinyEMU HTTP block-device files; all-zero blocks
    are hard links to one file.

  --snapshot: also build the shipped machine snapshot. Boots a copy of the
    rootfs natively (read-write), logs in, waits for the guest agent, drops
    caches and saves. The disk as it was at that moment becomes the chunked
    base image, since a snapshot is only valid with its exact disk.

Usage: stage-vm.py --bios B --kernel K --rootfs R [--format chunks|blk]
                   [--snapshot] [--cmdline ...] [--ram MB] [--out DIR]
"""
import argparse, hashlib, json, os, shutil, subprocess, sys

import brotli

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("--bios", required=True)
ap.add_argument("--kernel", required=True)
ap.add_argument("--rootfs", required=True)
ap.add_argument("--cmdline", default="console=hvc0 root=/dev/vda rw earlycon=sbi nowatchdog")
ap.add_argument("--ram", type=int, default=256)
ap.add_argument("--format", choices=["chunks", "blk"], default="chunks")
ap.add_argument("--snapshot", action="store_true")
ap.add_argument("--temu", default=os.path.join(REPO, "build/emu-native/temu"))
ap.add_argument("--login", default="root:root")
ap.add_argument("--block-kb", type=int, default=256)
ap.add_argument("--wasm-dir", default=os.path.join(REPO, "build/wasm"))
ap.add_argument("--out", default=os.path.join(REPO, "dist/vm"))
a = ap.parse_args()

out = a.out
os.makedirs(out, exist_ok=True)
# Remove everything but the content-addressed chunk store and the wheel index.
for name in os.listdir(out):
    if name in ("chunks", "pypi"):
        continue
    p = os.path.join(out, name)
    shutil.rmtree(p) if os.path.isdir(p) else os.unlink(p)

for f in ("xemu.mjs", "xemu.wasm"):
    shutil.copy2(os.path.join(a.wasm_dir, f), out)
shutil.copy2(a.bios, os.path.join(out, "bios.bin"))
shutil.copy2(a.kernel, os.path.join(out, "kernel.bin"))

summary = {"out": out, "format": a.format}
rootfs = a.rootfs
snapshot = None
if a.snapshot:
    assert a.format == "chunks", "--snapshot needs the chunk format"
    work = os.path.join(REPO, "build/snap")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    disk_img = os.path.join(work, "disk.img")
    # APFS clone (instant); falls back to a plain copy elsewhere.
    if subprocess.run(["cp", "-c", a.rootfs, disk_img]).returncode != 0:
        shutil.copyfile(a.rootfs, disk_img)
    shutil.copy2(a.bios, os.path.join(work, "fw_jump.bin"))
    shutil.copy2(a.kernel, os.path.join(work, "Image"))
    with open(os.path.join(work, "build.cfg"), "w") as f:
        f.write(f'{{ version: 1, machine: "riscv64", memory_size: {a.ram}, bios: "fw_jump.bin", '
                f'kernel: "Image", cmdline: "{a.cmdline} init_on_free=1", drive0: {{ file: "disk.img" }}, '
                f'eth0: {{ driver: "user" }} }}\n')
    snap_raw = os.path.join(work, "vm.snap")
    # Leading spaces keep these out of bash history (HISTCONTROL=ignoreboth).
    cmds = [
        " until systemctl -q is-active xiaonux-agent; do sleep 0.2; done",
        " sync; echo 3 > /proc/sys/vm/drop_caches; clear",
    ]
    args = [sys.executable, os.path.join(REPO, "bench/boot-native.py"), a.temu,
            os.path.join(work, "build.cfg"), "--rw", "--quiet", "--timeout", "600",
            "--login", a.login, "--save", snap_raw]
    for c in cmds:
        args += ["--cmd", c]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("snapshot build failed:\n" + r.stdout[-2000:] + r.stderr[-2000:])
    build_info = json.loads(r.stdout.strip().splitlines()[-1])
    raw = open(snap_raw, "rb").read()
    comp = brotli.compress(raw, quality=11, lgwin=24)
    name = f"snap-{hashlib.sha256(comp).hexdigest()}.br"
    with open(os.path.join(out, name), "wb") as f:
        f.write(comp)
    snapshot = {"file": name, "raw": len(raw), "cfg": "snap.cfg"}
    summary["snapshot"] = {"file": name, "raw_mb": round(len(raw) / 2**20, 1),
                           "brotli_mb": round(len(comp) / 2**20, 1),
                           "build_boot_s": build_info.get("prompt_s")}
    rootfs = disk_img  # the disk exactly as it was when the snapshot was saved
if a.format == "chunks":
    r = subprocess.run([sys.executable, os.path.join(REPO, "image/chunk.py"), rootfs,
                        "--out", out, "--block-kb", str(a.block_kb)],
                       check=True, capture_output=True, text=True)
    info = json.loads(r.stdout)
    summary.update(info)
    boot = {"cfg": "xiaonux.cfg", "disk": info["manifest"]}
    if snapshot:
        boot["snapshot"] = snapshot
    drive_file = info["manifest"]
else:
    disk = os.path.join(out, "disk")
    os.makedirs(disk)
    bs = a.block_kb * 1024
    zero = bytes(bs)
    zero_path = os.path.join(disk, "zero.blk")
    with open(zero_path, "wb") as z:
        z.write(zero)
    n = nonzero = 0
    with open(a.rootfs, "rb") as f:
        while True:
            buf = f.read(bs)
            if not buf:
                break
            if len(buf) < bs:
                buf += bytes(bs - len(buf))
            name = os.path.join(disk, f"blk{n:09d}.bin")
            if buf == zero:
                os.link(zero_path, name)
            else:
                with open(name, "wb") as o:
                    o.write(buf)
                nonzero += 1
            n += 1
    os.unlink(zero_path)
    with open(os.path.join(disk, "blk.txt"), "w") as f:
        json.dump({"block_size": a.block_kb, "n_block": n}, f)
    summary.update({"blocks": n, "nonzero_blocks": nonzero})
    boot = {"cfg": "xiaonux.cfg"}
    drive_file = "disk/blk.txt"

cfg = f"""/* xiaonux VM (generated by image/stage-vm.py) */
{{
    version: 1,
    machine: "riscv64",
    memory_size: {a.ram},
    bios: "bios.bin",
    kernel: "kernel.bin",
    cmdline: "{a.cmdline}",
    drive0: {{ file: "{drive_file}" }},
    eth0: {{ driver: "user" }},
}}
"""
with open(os.path.join(out, "xiaonux.cfg"), "w") as f:
    f.write(cfg)
if snapshot:
    # Restoring needs the same machine (RAM size, devices) but no kernel:
    # the kernel is already in the snapshot's RAM.
    with open(os.path.join(out, "snap.cfg"), "w") as f:
        f.write(f'{{ version: 1, machine: "riscv64", memory_size: {a.ram}, bios: "bios.bin", '
                f'drive0: {{ file: "{drive_file}" }}, eth0: {{ driver: "user" }} }}\n')
with open(os.path.join(out, "boot.json"), "w") as f:
    json.dump(boot, f)
print(json.dumps(summary))
