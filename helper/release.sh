#!/usr/bin/env bash
# Build xiaonux-net for every platform and package it into dist/vm/helper/:
#   linux  x86_64 + aarch64 (static musl)  -> .tar.gz
#   windows x86_64                         -> .exe + .msi (wixl in the builder VM)
#   macOS  universal (arm64 + x86_64)      -> .zip
# Env: XIAONUX_ORIGIN=https://your.site bakes the published page in as the
#      default origin (localhost:5180 always stays allowed).
# Needs: zig + cargo-zigbuild (brew install zig; cargo install cargo-zigbuild),
#        rustup targets, OrbStack builder VM with wixl (apt install wixl).
set -euo pipefail
cd "$(dirname "$0")"
REPO=$(cd .. && pwd)
OUT="$REPO/dist/vm/helper"
VERSION=$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)
ORB=${ORB:-/Applications/OrbStack.app/Contents/MacOS/bin/orb}
rm -rf "$OUT"; mkdir -p "$OUT"

build() { cargo zigbuild --release --target "$1" -q; }
for t in x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-pc-windows-gnu; do build "$t"; done
cargo build --release -q --target aarch64-apple-darwin
cargo build --release -q --target x86_64-apple-darwin

readme() {
  cat <<TXT
xiaonux-net $VERSION — lets the xiaonux browser VM use this computer's internet.
Run it, keep the window open, and the pairing link opens in your browser.
It only listens on 127.0.0.1, only for the xiaonux page, needs the pairing token,
and refuses your local network (LAN/router) unless started with --allow-lan.
Options: xiaonux-net --help
TXT
}

# License notices for the bundled Rust crates, shipped in every archive
NOTICES="$REPO/build/THIRD-PARTY-NOTICES.txt"
python3 "$REPO/tools/licenses/gen.py" --out "$REPO/build/licenses.json" --helper-notices "$NOTICES" >/dev/null
docs() { readme > "$1/README.txt"; cp "$REPO/LICENSE" "$1/LICENSE.txt"; cp "$NOTICES" "$1/THIRD-PARTY-NOTICES.txt"; }

for arch in x86_64 aarch64; do
  d=$(mktemp -d); cp "target/$arch-unknown-linux-musl/release/xiaonux-net" "$d/"; docs "$d"
  COPYFILE_DISABLE=1 tar --no-xattrs --uid 0 --gid 0 --uname root --gname root -C "$d" -czf "$OUT/xiaonux-net-$VERSION-linux-$arch.tar.gz" xiaonux-net README.txt LICENSE.txt THIRD-PARTY-NOTICES.txt; rm -rf "$d"
done

d=$(mktemp -d); lipo -create -output "$d/xiaonux-net" target/aarch64-apple-darwin/release/xiaonux-net target/x86_64-apple-darwin/release/xiaonux-net
docs "$d"; (cd "$d" && zip -q "$OUT/xiaonux-net-$VERSION-macos-universal.zip" xiaonux-net README.txt LICENSE.txt THIRD-PARTY-NOTICES.txt); rm -rf "$d"

cp target/x86_64-pc-windows-gnu/release/xiaonux-net.exe "$OUT/xiaonux-net-$VERSION-windows-x86_64.exe"
# MSI: wixl (msitools) runs in the Linux builder VM
w="$REPO/build/msi"; rm -rf "$w"; mkdir -p "$w"
cp target/x86_64-pc-windows-gnu/release/xiaonux-net.exe "$w/"; cp "$REPO/LICENSE" "$w/LICENSE.txt"; cp "$NOTICES" "$w/THIRD-PARTY-NOTICES.txt"
sed "s/@VERSION@/$VERSION/" packaging/xiaonux-net.wxs > "$w/xiaonux-net.wxs"
"$ORB" -m builder bash -c "command -v wixl >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wixl >/dev/null; cd '$w' && wixl -a x64 -o xiaonux-net.msi xiaonux-net.wxs"
cp "$w/xiaonux-net.msi" "$OUT/xiaonux-net-$VERSION-windows-x86_64.msi"

(cd "$OUT" && shasum -a 256 xiaonux-net-* > SHA256SUMS)
printf '{"version":"%s","files":{' "$VERSION" > "$OUT/latest.json"
first=1; for f in "$OUT"/xiaonux-net-*; do
  n=$(basename "$f"); [ $first = 1 ] || printf ',' >> "$OUT/latest.json"; first=0
  printf '"%s":%s' "$n" "$(stat -f%z "$f")" >> "$OUT/latest.json"
done
printf '}}\n' >> "$OUT/latest.json"
ls -la "$OUT"
