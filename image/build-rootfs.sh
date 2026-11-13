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
# Security / learning toolbox (static analysis, tracing, networking). radare2 and
# rizin aren't packaged for riscv64 in trixie.
PKGS=$PKGS,file,binutils-multiarch,xxd,strace,ltrace,gdb-minimal,yara,binwalk,hexedit,jq
PKGS=$PKGS,vim-tiny,unzip,zip,7zip,net-tools,bind9-dnsutils,tcpdump,nmap,netcat-openbsd,python3-pefile

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
  --customize-hook='printf "[global]\nbreak-system-packages = true\n# riscv64 wheels for packages PyPI lacks, served by the browser itself\nextra-index-url = http://wheels.xiaonux/simple/\ntrusted-host = wheels.xiaonux\nprefer-binary = true\n" > "$1/etc/pip.conf"' \
  --customize-hook='chroot "$1" systemctl enable serial-getty@hvc0.service' \
  --customize-hook="copy-in $REPO/image/guest/xiaonux-agent /usr/local/sbin" \
  --customize-hook="copy-in $REPO/image/guest/xiaonux-agent.service /etc/systemd/system" \
  --customize-hook='chroot "$1" systemctl enable xiaonux-agent.service' \
  --customize-hook="copy-in $REPO/image/guest/xiaonux-net /usr/local/sbin" \
  --customize-hook="copy-in $REPO/image/guest/xiaonux-net.service /etc/systemd/system" \
  --customize-hook='chroot "$1" systemctl enable xiaonux-net.service' \
  --customize-hook='rm -f "$1/etc/resolv.conf"; echo "nameserver 10.0.2.3" > "$1/etc/resolv.conf"' \
  --customize-hook='chroot "$1" systemctl mask apt-daily.timer apt-daily-upgrade.timer dpkg-db-backup.timer e2scrub_all.timer fstrim.timer 2>/dev/null || true' \
  --customize-hook='rm -rf "$1"/var/cache/apt/*.bin "$1"/var/lib/apt/lists/* "$1"/var/log/*.log' \
  "$DEBIAN_SUITE" "$ROOT" http://deb.debian.org/debian

# Package manifest for the Licenses page: name, version, source package and
# the license names declared in each package's copyright file.
chroot "$ROOT" dpkg-query -W -f='${Package}\t${Version}\t${source:Package}\t${source:Version}\n' > "$XBUILD/packages.tsv"
while IFS=$'\t' read -r pkg ver src srcver; do
  lic=$({ grep -h '^License:' "$ROOT/usr/share/doc/$pkg/copyright" 2>/dev/null || true; } | sed 's/^License: *//' | sort -u | paste -sd ';' -)
  printf '%s\t%s\t%s\t%s\t%s\n' "$pkg" "$ver" "$src" "$srcver" "${lic:-see copyright}"
done < "$XBUILD/packages.tsv" > "$REPO/build/packages.tsv"
chown "${SUDO_UID:-0}:${SUDO_GID:-0}" "$REPO/build/packages.tsv"
# License texts for tools/licenses/gen.py (the kernel and OpenSBI trees were
# unpacked here by build-kernel.sh / build-opensbi.sh).
LSRC="$REPO/build/licenses-src"
mkdir -p "$LSRC"
rm -rf "$LSRC/common-licenses"
cp -r "$ROOT/usr/share/common-licenses" "$LSRC/"
cp "$XBUILD/linux-$LINUX_VERSION/COPYING" "$LSRC/linux-COPYING" 2>/dev/null || echo "warning: no kernel tree; run make kernel first"
cp "$XBUILD/opensbi-$OPENSBI_VERSION/COPYING.BSD" "$LSRC/opensbi-COPYING.BSD" 2>/dev/null || echo "warning: no OpenSBI tree; run make firmware first"
chown -R "${SUDO_UID:-0}:${SUDO_GID:-0}" "$LSRC"

truncate -s "$IMG_SIZE" "$IMG"
mkfs.ext4 -q -F -L root -b 4096 -d "$ROOT" "$IMG"
mkdir -p "$REPO/build"
rm -f "$REPO/build/rootfs.img"
# The Mac share cannot punch holes; dd seeks over zero blocks instead.
dd if="$IMG" of="$REPO/build/rootfs.img" bs=1M conv=sparse status=none
chown "${SUDO_UID:-0}:${SUDO_GID:-0}" "$REPO/build/rootfs.img"
du -sh "$ROOT"
ls -ls "$REPO/build/rootfs.img"
