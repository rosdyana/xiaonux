#!/bin/sh
# Run in the build VM: map the shared libraries auditwheel vendored into our
# wheels back to the Debian packages they were copied from (in the wheel
# build chroot) and print: soname, package, version, licenses.
# Usage: wheel-libs.sh <chroot> <soname>...
# Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
set -eu
CH=$1; shift
for so in "$@"; do
  path=$(find "$CH/usr/lib" "$CH/lib" -name "$so" 2>/dev/null | head -1)
  [ -n "$path" ] || { printf '%s\t?\t?\tnot found\n' "$so"; continue; }
  pkg=$(chroot "$CH" dpkg -S "${path#$CH}" 2>/dev/null | head -1 | cut -d: -f1) || pkg=
  [ -n "$pkg" ] || pkg=$(chroot "$CH" dpkg -S "$so" 2>/dev/null | head -1 | cut -d: -f1)
  ver=$(chroot "$CH" dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || echo ?)
  lic=$({ grep -h '^License:' "$CH/usr/share/doc/$pkg/copyright" 2>/dev/null || true; } | sed 's/^License: *//' | sort -u | paste -sd ';' -)
  printf '%s\t%s\t%s\t%s\n' "$so" "$pkg" "$ver" "${lic:-see copyright}"
done
