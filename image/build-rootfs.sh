#!/usr/bin/env bash
# Build the Debian riscv64 root filesystem -> build/rootfs.img (sparse ext4).
# Runs inside the builder VM: orb -m builder sudo image/build-rootfs.sh
# Env: ROOT_PASSWORD (default "root"), HOSTNAME_ (default "xiaonux"), IMG_SIZE (default 2G).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
. "$REPO/image/versions.sh"
XBUILD=${SUDO_USER:+/home/$SUDO_USER/xbuild}
XBUILD=${XBUILD:-$HOME/xbuild}
ROOT_PASSWORD=${ROOT_PASSWORD:-root}
HOSTNAME_=${HOSTNAME_:-xiaonux}
IMG_SIZE=${IMG_SIZE:-2G}

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ROOT="$XBUILD/rootfs"
IMG="$XBUILD/rootfs.img"
rm -rf "$ROOT" "$IMG"
mkdir -p "$ROOT"

PKGS=systemd-sysv,udev,iproute2,iputils-ping,ca-certificates,curl,python3,python3-pip,nano,less,procps

mmdebstrap --arch=riscv64 --variant=minbase --include="$PKGS" \
  --dpkgopt='path-exclude=/usr/share/man/*' \
  --dpkgopt='path-exclude=/usr/share/doc/*' \
  --dpkgopt='path-include=/usr/share/doc/*/copyright' \
  --dpkgopt='path-exclude=/usr/share/info/*' \
  --dpkgopt='path-exclude=/usr/share/locale/*' \
  --dpkgopt='path-include=/usr/share/locale/locale.alias' \
  --customize-hook='echo '"$HOSTNAME_"' > "$1/etc/hostname"' \
  --customize-hook='printf "127.0.0.1 localhost\n127.0.1.1 '"$HOSTNAME_"'\n" > "$1/etc/hosts"' \
  --customize-hook='echo "/dev/vda / ext4 rw,noatime 0 1" > "$1/etc/fstab"' \
  --customize-hook='echo "root:'"$ROOT_PASSWORD"'" | chroot "$1" chpasswd' \
  --customize-hook='printf "[global]\nbreak-system-packages = true\n" > "$1/etc/pip.conf"' \
  --customize-hook='chroot "$1" systemctl enable serial-getty@hvc0.service' \
  --customize-hook="copy-in $REPO/image/guest/xiaonux-agent /usr/local/sbin" \
  --customize-hook="copy-in $REPO/image/guest/xiaonux-agent.service /etc/systemd/system" \
  --customize-hook='chroot "$1" systemctl enable xiaonux-agent.service' \
  --customize-hook='chroot "$1" systemctl mask apt-daily.timer apt-daily-upgrade.timer dpkg-db-backup.timer e2scrub_all.timer fstrim.timer 2>/dev/null || true' \
  --customize-hook='rm -rf "$1"/var/cache/apt/*.bin "$1"/var/lib/apt/lists/* "$1"/var/log/*.log' \
  "$DEBIAN_SUITE" "$ROOT" http://deb.debian.org/debian

truncate -s "$IMG_SIZE" "$IMG"
mkfs.ext4 -q -F -L root -b 4096 -d "$ROOT" "$IMG"
mkdir -p "$REPO/build"
rm -f "$REPO/build/rootfs.img"
# The Mac share cannot punch holes; dd seeks over zero blocks instead.
dd if="$IMG" of="$REPO/build/rootfs.img" bs=1M conv=sparse status=none
chown "${SUDO_UID:-0}:${SUDO_GID:-0}" "$REPO/build/rootfs.img"
du -sh "$ROOT"
ls -ls "$REPO/build/rootfs.img"
