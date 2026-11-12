#!/usr/bin/env python3
"""Publish built wheels as a static PEP 503 index under dist/vm/pypi/.

  pypi/simple/index.html               project list
  pypi/simple/<project>/index.html     links: ../../files/<wheel>#sha256=<hash>
  pypi/files/<wheel>

The guest reaches it as http://wheels.xiaonux/simple/ (served by the worker).
Usage: wheel-index.py [--wheels build/wheels] [--out dist/vm/pypi]
"""
import argparse, hashlib, html, os, re, shutil

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("--wheels", default=os.path.join(REPO, "build/wheels"))
ap.add_argument("--out", default=os.path.join(REPO, "dist/vm/pypi"))
a = ap.parse_args()

norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()
files = os.path.join(a.out, "files")
shutil.rmtree(a.out, ignore_errors=True)
os.makedirs(files)
projects = {}
for w in sorted(os.listdir(a.wheels)):
    if not w.endswith(".whl"):
        continue
    shutil.copy2(os.path.join(a.wheels, w), files)
    h = hashlib.sha256(open(os.path.join(files, w), "rb").read()).hexdigest()
    projects.setdefault(norm(w.split("-")[0]), []).append((w, h))

page = lambda title, body: f"<!DOCTYPE html><html><head><meta name=\"pypi:repository-version\" content=\"1.0\"><title>{title}</title></head><body>{body}</body></html>\n"
os.makedirs(os.path.join(a.out, "simple"))
with open(os.path.join(a.out, "simple", "index.html"), "w") as f:
    f.write(page("xiaonux wheels", "".join(f'<a href="{p}/">{p}</a><br>' for p in sorted(projects))))
for p, ws in projects.items():
    d = os.path.join(a.out, "simple", p)
    os.makedirs(d)
    with open(os.path.join(d, "index.html"), "w") as f:
        f.write(page(p, "".join(f'<a href="../../files/{html.escape(w)}#sha256={h}">{html.escape(w)}</a><br>' for w, h in ws)))
print(f"{len(projects)} projects, {sum(len(v) for v in projects.values())} wheels -> {a.out}")
