# Pinned upstream versions. Sourced by image/*.sh.
LINUX_VERSION=6.12.117
OPENSBI_VERSION=1.9
DEBIAN_SUITE=trixie
# Scratch dir inside the builder VM (native disk; much faster than the Mac share).
XBUILD=${XBUILD:-$HOME/xbuild}
CROSS_COMPILE=riscv64-linux-gnu-
