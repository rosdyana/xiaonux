#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Builds a THROWAWAY measurement image for the xv6 lab build-time measurements.
# It is the guest rootfs plus gcc, make, libc6-dev, bc and git, with two xv6
# master trees: /root/xv6-clean (sources only) and /root/xv6-built (built
# natively in the chroot, under qemu-user). Never shipped. The real image
# change happens later, after plan 014 is deployed.
#
# Needs build/xv6/ from image/xv6/build-fixtures.sh (for the master source).
# Run in the builder VM:  orb -m builder sudo image/xv6/build-probe-image.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
XBUILD=${SUDO_USER:+/home/$SUDO_USER/xbuild}
XBUILD=${XBUILD:-$HOME/xbuild}
OWN="${SUDO_UID:-0}:${SUDO_GID:-0}"
BASE="$XBUILD/rootfs.img"
IMG="$XBUILD/rootfs-xv6probe.img"
MNT="$XBUILD/xv6probe-mnt"
SRCTREE="$XBUILD/xv6-src/master"
RESOLV_SAVE="$XBUILD/xv6probe-resolv.orig"

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f "$BASE" ] || { echo "missing $BASE (run image/build-rootfs.sh first)"; exit 1; }
[ -d "$SRCTREE/.git" ] || { echo "missing $SRCTREE (run image/xv6/build-fixtures.sh first)"; exit 1; }

cleanup() {
  # Idempotent: unmount in reverse order, only what is mounted, then the dir.
  set +e
  mountpoint -q "$MNT/dev" && umount "$MNT/dev"
  mountpoint -q "$MNT/proc" && umount "$MNT/proc"
  mountpoint -q "$MNT" && umount "$MNT"
  if mountpoint -q "$MNT/dev" || mountpoint -q "$MNT/proc" || mountpoint -q "$MNT"; then
    echo "WARNING: $MNT still mounted; not removing it" >&2
  else
    rmdir "$MNT" 2>/dev/null
  fi
  set -e
}
trap cleanup EXIT

rm -f "$IMG"
cp --sparse=always "$BASE" "$IMG"
mkdir -p "$MNT"
mount -o loop "$IMG" "$MNT"

# Keep the guest's own resolv.conf so it can be restored afterwards.
cp -L "$MNT/etc/resolv.conf" "$RESOLV_SAVE"
mount --bind /dev "$MNT/dev"
mount -t proc proc "$MNT/proc"
cp -L /etc/resolv.conf "$MNT/etc/resolv.conf"

chroot "$MNT" /bin/sh -c 'apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends gcc make libc6-dev bc git && rm -rf /var/lib/apt/lists/*'

# Restore the guest's resolv.conf (nameserver 10.0.2.3 from build-rootfs.sh).
cp "$RESOLV_SAVE" "$MNT/etc/resolv.conf"
grep -q '^nameserver 10.0.2.3$' "$MNT/etc/resolv.conf"

# Two trees from the pinned master commit, no .git and no build output.
for d in xv6-clean xv6-built; do
  rm -rf "$MNT/root/$d"
  mkdir -p "$MNT/root/$d"
  git -C "$SRCTREE" archive HEAD | tar -x -C "$MNT/root/$d"
done
chroot "$MNT" /bin/sh -c 'cd /root/xv6-clean && make clean >/dev/null 2>&1; cd /root/xv6-built && make TOOLPREFIX= CPUS=1 kernel/kernel fs.img > /root/xv6-built.log 2>&1 && test -s kernel/kernel && test -s fs.img'

cleanup
trap - EXIT

# Verify the image. e2fsck -n exits non-zero on any error.
e2fsck -fn "$IMG"
ROOTLS=$(debugfs -R 'ls /root' "$IMG" 2>/dev/null)
echo "$ROOTLS"
grep -q xv6-clean <<<"$ROOTLS"
grep -q xv6-built <<<"$ROOTLS"
MOUNTS=$(mount)
if grep -q xv6probe <<<"$MOUNTS"; then echo "leftover xv6probe mount"; exit 1; fi

mkdir -p "$REPO/build"
rm -f "$REPO/build/rootfs-xv6probe.img"
dd if="$IMG" of="$REPO/build/rootfs-xv6probe.img" bs=1M conv=sparse status=none
chown "$OWN" "$REPO/build/rootfs-xv6probe.img"
ls -ls "$REPO/build/rootfs-xv6probe.img"
echo "mounts left for xv6probe: $(grep -c xv6probe <<<"$(mount)" || true)"
