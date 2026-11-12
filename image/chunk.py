#!/usr/bin/env python3
"""Split a disk image into content-addressed Brotli chunks (Phase 2 format).

Output (under --out):
  chunks/<sha256>.br        one file per distinct non-zero block; the name is
                            the SHA-256 of the *uncompressed* block, so the
                            client verifies after decoding. Immutable.
  disk-<sha256>.json        manifest, named by the hash of its own bytes:
    { "format": "xiaonux-disk-1", "block_size": 262144, "n_blocks": N,
      "hashes": [h0, h1, ...],          # distinct block hashes
      "map": [i, ...] }                 # per block: 0 = all zeros, k = hashes[k-1]

Prints a JSON summary including the manifest file name.
Usage: chunk.py IMAGE --out DIR [--block-kb 256] [--quality 11] [--jobs N]
"""
import argparse, hashlib, json, os, sys
from concurrent.futures import ProcessPoolExecutor

import brotli

ap = argparse.ArgumentParser()
ap.add_argument("image")
ap.add_argument("--out", required=True)
ap.add_argument("--block-kb", type=int, default=256)
ap.add_argument("--quality", type=int, default=11)
ap.add_argument("--jobs", type=int, default=os.cpu_count())
a = ap.parse_args()

BS = a.block_kb * 1024
chunk_dir = os.path.join(a.out, "chunks")
os.makedirs(chunk_dir, exist_ok=True)


def compress(job):
    h, data, quality = job
    path = os.path.join(chunk_dir, h + ".br")
    if os.path.exists(path):  # chunks are immutable; reuse across builds
        return h, len(data), os.path.getsize(path), False
    enc = brotli.compress(data, quality=quality, lgwin=22)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(enc)
    os.replace(tmp, path)
    return h, len(data), len(enc), True


def main():
    zero = bytes(BS)
    hashes, index, mapping, jobs = [], {}, [], []
    with open(a.image, "rb") as f:
        while True:
            buf = f.read(BS)
            if not buf:
                break
            if len(buf) < BS:
                buf += bytes(BS - len(buf))
            if buf == zero:
                mapping.append(0)
                continue
            h = hashlib.sha256(buf).hexdigest()
            if h not in index:
                hashes.append(h)
                index[h] = len(hashes)
                jobs.append((h, buf, a.quality))
            mapping.append(index[h])

    raw = comp = new = 0
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        for _, n_raw, n_comp, was_new in ex.map(compress, jobs, chunksize=4):
            raw += n_raw
            comp += n_comp
            new += was_new

    manifest = json.dumps({
        "format": "xiaonux-disk-1",
        "block_size": BS,
        "n_blocks": len(mapping),
        "hashes": hashes,
        "map": mapping,
    }, separators=(",", ":")).encode()
    mhash = hashlib.sha256(manifest).hexdigest()
    mname = f"disk-{mhash}.json"
    with open(os.path.join(a.out, mname), "wb") as f:
        f.write(manifest)
    print(json.dumps({
        "manifest": mname,
        "n_blocks": len(mapping),
        "zero_blocks": mapping.count(0),
        "distinct_chunks": len(hashes),
        "dedup_blocks": len(mapping) - mapping.count(0) - len(hashes),
        "new_chunks": new,
        "raw_mb": round(raw / 2**20, 1),
        "brotli_mb": round(comp / 2**20, 1),
        "manifest_kb": round(len(manifest) / 1024, 1),
    }))


if __name__ == "__main__":
    main()
