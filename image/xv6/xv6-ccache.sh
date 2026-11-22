# /etc/profile.d/xv6-ccache.sh (xiaonux)
# Put ccache's compiler wrappers first on PATH, so the xv6 Makefiles'
# gcc / riscv64-linux-gnu-gcc calls use the cache pre-warmed in
# /root/.cache/ccache by guest-setup.sh.
case ":$PATH:" in
  *:/usr/lib/ccache:*) ;;
  *) export PATH=/usr/lib/ccache:$PATH ;;
esac
