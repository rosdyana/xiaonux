#!/usr/bin/env python3
"""Build a prefetch bundle from a recorded chunk access order.

Records come from a browser run with ?record (bench/browser-boot.mjs prints
stats.disk.fetchOrder: manifest hash indexes in first-fetch order). The
bundle concatenates those chunks in that order into prefetch-<sha256>.bin,
and boot.json gets { prefetch: { file, index: [[hash, offset, len], ...] } }.

Usage: prefetch.py --vm dist/vm --order order.json
"""
import argparse, hashlib, json, os

ap = argparse.ArgumentParser()
ap.add_argument("--vm", required=True)
ap.add_argument("--order", required=True, help="JSON list of hash indexes")
a = ap.parse_args()

boot_path = os.path.join(a.vm, "boot.json")
boot = json.load(open(boot_path))
manifest = json.load(open(os.path.join(a.vm, boot["disk"])))
order = json.load(open(a.order))

seen, parts, index, off = set(), [], [], 0
for i in order:
    h = manifest["hashes"][i]
    if h in seen:
        continue
    seen.add(h)
    b = open(os.path.join(a.vm, "chunks", h + ".br"), "rb").read()
    parts.append(b)
    index.append([h, off, len(b)])
    off += len(b)

blob = b"".join(parts)
name = f"prefetch-{hashlib.sha256(blob).hexdigest()}.bin"
for f in os.listdir(a.vm):  # drop older bundles
    if f.startswith("prefetch-") and f != name:
        os.unlink(os.path.join(a.vm, f))
with open(os.path.join(a.vm, name), "wb") as f:
    f.write(blob)
boot["prefetch"] = {"file": name, "index": index}
with open(boot_path, "w") as f:
    json.dump(boot, f)
print(json.dumps({"file": name, "chunks": len(index), "mb": round(len(blob) / 2**20, 2)}))
