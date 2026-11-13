#!/usr/bin/env python3
"""Collect the licenses of everything the xiaonux site serves.

Writes dist/vm/licenses.json for the Licenses page, and with
--helper-notices FILE a THIRD-PARTY-NOTICES.txt for the helper archives.

Inputs (all produced by the normal build):
  web/node_modules/@xterm/*            page bundle
  emu/tinyemu, emu/brotli, ~/emsdk     emulator WASM
  build/licenses-src/                  copied from the build VM: Linux
                                       COPYING, OpenSBI COPYING.BSD, Debian
                                       common-licenses, and wheel-libs.tsv +
                                       wheel-libs/*.copyright from
                                       tools/licenses/wheel-libs.sh
  build/packages.tsv                   Debian packages in the disk image
  dist/vm/pypi/files/*.whl             wheels the page serves
  helper/ (cargo metadata)             helper crates

Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
"""
import argparse, glob, hashlib, json, os, re, subprocess, sys, zipfile
from email.parser import Parser

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "image"))
LSRC = os.path.join(REPO, "build", "licenses-src")
EMSDK = os.environ.get("EMSDK", os.path.expanduser("~/emsdk"))

texts: dict[str, str] = {}


def text(body: str | None) -> str | None:
    """Store a license text once; return its key."""
    if not body:
        return None
    body = body.replace("\r\n", "\n").strip() + "\n"
    key = hashlib.sha256(body.encode()).hexdigest()[:16]
    texts[key] = body
    return key


def read(*parts: str) -> str | None:
    p = os.path.join(*parts)
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def versions() -> dict[str, str]:
    out = {}
    for line in open(os.path.join(REPO, "image", "versions.sh")):
        m = re.match(r"\s*(?:export\s+)?([A-Z_]+)=['\"]?([^'\"\s#]+)", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def page_bundle():
    items = []
    for pkg in ("@xterm/xterm", "@xterm/addon-fit"):
        d = os.path.join(REPO, "web", "node_modules", pkg)
        meta = json.load(open(os.path.join(d, "package.json")))
        items.append({"name": pkg, "version": meta["version"], "license": meta.get("license", "?"),
                      "url": "https://github.com/xtermjs/xterm.js", "text": text(read(d, "LICENSE"))})
    return {"id": "page", "title": "This page", "note": "JavaScript bundled into the page.", "items": items}


def emulator():
    em = os.path.join(EMSDK, "upstream", "emscripten")
    em_ver = (read(em, "emscripten-version.txt") or "").strip().strip('"') or None
    return {"id": "emulator", "title": "Emulator (WebAssembly)",
            "note": "Compiled into xemu.wasm. xiaonux's own emulator code is Apache-2.0; changes inside TinyEMU files keep TinyEMU's MIT license.",
            "items": [
                {"name": "TinyEMU", "version": "2019-12-21", "license": "MIT", "url": "https://bellard.org/tinyemu/",
                 "text": text(read(REPO, "emu", "tinyemu", "MIT-LICENSE.txt"))},
                {"name": "Brotli decoder", "version": "1.2.0", "license": "MIT", "url": "https://github.com/google/brotli",
                 "text": text(read(REPO, "emu", "brotli", "LICENSE"))},
                {"name": "Emscripten runtime", "version": em_ver, "license": "MIT OR NCSA", "url": "https://emscripten.org",
                 "text": text(read(em, "LICENSE"))},
                {"name": "musl libc (via Emscripten)", "license": "MIT", "url": "https://musl.libc.org",
                 "text": text(read(em, "system", "lib", "libc", "musl", "COPYRIGHT"))},
                {"name": "compiler-rt (via Emscripten)", "license": "Apache-2.0 WITH LLVM-exception", "url": "https://compiler-rt.llvm.org",
                 "text": text(read(em, "system", "lib", "compiler-rt", "LICENSE.TXT"))},
            ]}


def guest(v: dict[str, str]):
    kver = v.get("LINUX_VERSION", "")
    sbi = v.get("OPENSBI_VERSION", "")
    major = kver.split(".")[0] if kver else "6"
    return {"id": "guest", "title": "Firmware and kernel", "items": [
        {"name": "OpenSBI", "version": sbi, "license": "BSD-2-Clause", "url": "https://github.com/riscv-software-src/opensbi",
         "text": text(read(LSRC, "opensbi-COPYING.BSD"))},
        {"name": "Linux", "version": kver, "license": "GPL-2.0-only WITH Linux-syscall-note", "url": "https://kernel.org",
         "source": f"https://cdn.kernel.org/pub/linux/kernel/v{major}.x/linux-{kver}.tar.xz",
         "offer": "Built from the unmodified kernel.org release above with image/kernel.config and image/build-kernel.sh from the xiaonux repository. That source tarball, the config and the scripts are the complete corresponding source.",
         "text": text(read(LSRC, "linux-COPYING"))},
    ]}


COMMON = {  # Debian copyright license names -> /usr/share/common-licenses file
    "GPL-2": "GPL-2", "GPL-2+": "GPL-2", "GPL-2.0": "GPL-2", "GPL-2.0+": "GPL-2", "GPL-2.0-or-later": "GPL-2",
    "GPL-3": "GPL-3", "GPL-3+": "GPL-3", "GPL-3.0+": "GPL-3", "GPL-3.0-or-later": "GPL-3",
    "LGPL-2": "LGPL-2", "LGPL-2+": "LGPL-2", "LGPL-2.1": "LGPL-2.1", "LGPL-2.1+": "LGPL-2.1",
    "LGPL-3": "LGPL-3", "LGPL-3+": "LGPL-3", "Apache-2.0": "Apache-2.0", "Artistic": "Artistic",
    "MPL-2.0": "MPL-2.0", "GFDL-1.3": "GFDL-1.3", "GFDL-1.2": "GFDL-1.2", "CC0-1.0": "CC0-1.0",
}


def debian():
    tsv = os.path.join(REPO, "build", "packages.tsv")
    items, used = [], set()
    for line in open(tsv):
        pkg, ver, src, srcver, lic = (line.rstrip("\n").split("\t") + [""] * 5)[:5]
        src = src or pkg
        srcver = srcver or ver
        names = [x for x in lic.split(";") if x and x != "see copyright"]
        for n in names:
            base = re.split(r"\s+(?:with|and|or)\s+", n, flags=re.I)[0].strip()
            if base in COMMON:
                used.add(COMMON[base])
        items.append({"name": pkg, "version": ver, "license": "; ".join(names) or "see copyright file",
                      "source": f"https://snapshot.debian.org/package/{src}/{srcver}/",
                      "copyright": f"/usr/share/doc/{pkg}/copyright"})
    common = {n: text(read(LSRC, "common-licenses", n)) for n in sorted(used)}
    return {"id": "debian", "title": "Debian packages in the disk image",
            "note": "Each package's full copyright file is in the machine at /usr/share/doc/<package>/copyright. Source for every version is on snapshot.debian.org (linked). Common license texts are below.",
            "items": items, "common": {k: v for k, v in common.items() if v}}


def wheels():
    libs = {}  # vendored soname -> (Debian package, version, licenses); see wheel-libs.sh
    for line in open(os.path.join(LSRC, "wheel-libs.tsv")):
        so, pkg, ver, lic = line.rstrip("\n").split("\t")
        libs[so] = (pkg, ver, lic)
    items = []
    for whl in sorted(glob.glob(os.path.join(REPO, "dist", "vm", "pypi", "files", "*.whl"))):
        with zipfile.ZipFile(whl) as z:
            names = z.namelist()
            meta_name = next(n for n in names if n.endswith(".dist-info/METADATA"))
            meta = Parser().parsestr(z.read(meta_name).decode("utf-8", "replace"))
            lic = meta.get("License-Expression") or meta.get("License") or ""
            if len(lic) > 80 or not lic:  # some put the whole text in License:
                cls = [c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
                lic = ", ".join(cls) or (lic.splitlines()[0][:80] if lic else "see wheel")
            dist = meta_name.rsplit("/", 1)[0]
            lic_files = [n for n in names if n.startswith(dist + "/") and re.search(r"/(licenses/)?(LICEN[CS]E|COPYING|NOTICE)", n, re.I)]
            body = "\n\n".join(z.read(n).decode("utf-8", "replace") for n in lic_files)
            bundled = []
            for so in sorted({os.path.basename(n) for n in names if re.search(r"\.libs/[^/]+\.so", n)}):
                orig = re.sub(r"-[0-9a-f]{8}(\.so)", r"\1", so)
                pkg, ver, lic = libs.get(orig, ("?", "?", "unknown"))
                bundled.append({"file": orig, "package": pkg, "version": ver, "license": lic.replace(";", "; "),
                                "text": text(read(LSRC, "wheel-libs", f"{pkg}.copyright"))})
            url = meta.get("Home-page") or next((u.split(",", 1)[1].strip() for u in meta.get_all("Project-URL") or [] if "," in u), None)
            items.append({"name": meta["Name"], "version": meta["Version"], "license": lic, "url": url,
                          "bundled": bundled, "text": text(body)})
    return {"id": "wheels", "title": "Python packages served by the page",
            "note": "riscv64 wheels built by image/build-wheels.sh from the projects' own source releases. Shared libraries vendored into a wheel by auditwheel were copied from Debian 13 packages; each is listed with its package, license and copyright file.",
            "items": items}


def helper_crates():
    meta = json.loads(subprocess.check_output(["cargo", "metadata", "--format-version", "1", "--locked"],
                                              cwd=os.path.join(REPO, "helper")))
    items = []
    for p in sorted(meta["packages"], key=lambda p: (p["name"], p["version"])):
        if p["name"] == "xiaonux-net":
            continue
        d = os.path.dirname(p["manifest_path"])
        files = sorted(f for f in os.listdir(d) if re.match(r"(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)", f, re.I))
        body = "\n\n".join(f"--- {f} ---\n" + (read(d, f) or "") for f in files)
        items.append({"name": p["name"], "version": p["version"], "license": p.get("license") or "?",
                      "url": p.get("repository"), "text": text(body),
                      "texts": [k for k in (text(read(d, f)) for f in files) if k]})
    return {"id": "helper", "title": "xiaonux-net helper (Rust crates)",
            "note": "Compiled into the optional helper binaries. Each archive also contains THIRD-PARTY-NOTICES.txt.",
            "items": items}


def notices_txt(group) -> str:
    out = ["xiaonux-net third-party notices", "=" * 31, "",
           "xiaonux-net is licensed under the Apache License 2.0. It includes the",
           "following Rust crates, under the licenses shown.", ""]
    for it in group["items"]:
        out.append(f"{it['name']} {it['version']}  ({it['license']})  {it.get('url') or ''}".rstrip())
    out.append("")
    # Each crate's license files, each distinct text printed once.
    by_text: dict[str, list[str]] = {}
    for it in group["items"]:
        for key in it.get("texts", []):
            by_text.setdefault(key, []).append(f"{it['name']} {it['version']}")
    for key, crates in by_text.items():
        out += ["", "=" * 72, "License files of: " + ", ".join(crates), "=" * 72, texts[key]]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(REPO, "dist", "vm", "licenses.json"))
    ap.add_argument("--helper-notices", help="also write the helper's THIRD-PARTY-NOTICES.txt here")
    ap.add_argument("--helper-only", action="store_true",
                    help="only write --helper-notices (no build outputs needed; used by CI)")
    a = ap.parse_args()
    if a.helper_only:
        if not a.helper_notices:
            ap.error("--helper-only needs --helper-notices")
        with open(a.helper_notices, "w") as f:
            f.write(notices_txt(helper_crates()))
        print(a.helper_notices)
        return
    v = versions()
    own = {"id": "xiaonux", "title": "xiaonux", "items": [
        {"name": "xiaonux", "license": "Apache-2.0", "url": "https://github.com/rosdyana/xiaonux",
         "text": text(read(REPO, "LICENSE"))}]}
    hc = helper_crates()
    groups = [own, page_bundle(), emulator(), guest(v), debian(), wheels(), hc]
    if a.helper_notices:
        with open(a.helper_notices, "w") as f:
            f.write(notices_txt(hc))
    missing = [f"{g['id']}/{i['name']}" for g in groups for i in g["items"] if "text" in i and not i["text"]]
    for it in hc["items"]:
        it.pop("texts", None)  # per-file texts are for the notices file only
    used = {i.get("text") for g in groups for i in g["items"]}
    used |= {b.get("text") for g in groups for i in g["items"] for b in i.get("bundled", [])}
    used |= {k for g in groups for k in (g.get("common") or {}).values()}
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump({"groups": groups, "texts": {k: v for k, v in texts.items() if k in used}}, f, separators=(",", ":"))
    n = sum(len(g["items"]) for g in groups)
    print(f"{a.out}: {n} components, {len(used - {None})} license texts, {os.path.getsize(a.out) >> 10} KB")
    if missing:
        print("no license text found for: " + ", ".join(missing), file=sys.stderr)


if __name__ == "__main__":
    main()
