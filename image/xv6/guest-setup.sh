set -eu
X=/usr/share/xv6
LOGIN_PATH=/usr/lib/ccache:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Run with the environment a root login shell on hvc0 gets: no locale
# (ccache hashes LANG/LC_* into cache keys, so a different locale here would
# make every student compile a miss), and PATH with /usr/lib/ccache first
# (see /etc/profile.d/xv6-ccache.sh).
if [ -z "${XV6_CLEAN_ENV:-}" ]; then
  exec env -i XV6_CLEAN_ENV=1 HOME=/root TERM=linux LOGNAME=root USER=root \
    PATH="$LOGIN_PATH" sh "$0"
fi
cd /root
echo "guest-setup env:"
env | sort

git clone -q -b util "$X/xv6-labs-2026.bundle" xv6-labs-2026
git -C xv6-labs-2026 remote set-url origin "$X/xv6-labs-2026.bundle"
cd xv6-labs-2026
ccache -M 500M
# Python 3 (gradelib, run by make grade) sets LC_CTYPE=C.UTF-8 in the environment
# of every child it starts (PEP 538). ccache hashes LC_* by default, so without
# this every compile under make grade is a miss. Compiler output does not depend
# on the locale here, so ignore it.
ccache -o sloppiness=locale

# Pre-warm the cache with every supported lab, built exactly as `make grade`
# builds it (plain make, no TOOLPREFIX override), in the same path students use.
for b in util syscall pgtbl traps cow mmap; do
  if ! git rev-parse -q --verify "origin/$b" >/dev/null; then
    echo "warm: skip $b (no such branch in the bundle)"
    continue
  fi
  make clean >/dev/null
  git checkout -q --detach "origin/$b"
  echo "warm: building $b"
  # Best effort: -k keeps going past a failing object, so what compiles is
  # cached. Labs that need the student's own syscall stubs (mmap's mmaptest.c
  # calls mmap() before user.h declares it) do not build unsolved under GCC 14.
  if make -k kernel/kernel fs.img; then
    echo "warm: $b built"
  else
    echo "warm-up: $b does not build unsolved (expected for labs that need your syscall stubs); cached what compiled"
  fi
done

# End on util (the pre-built tree students get). Proof: a clean util build
# must be almost all cache hits.
make clean >/dev/null
git checkout -q util
if [ -n "$(git status --porcelain)" ]; then
  echo "tree not clean after checkout"
  exit 1
fi
ccache -z >/dev/null
# Same path as gradelib: a Python subprocess runs plain make.
python3 -c 'import subprocess, sys; sys.exit(subprocess.call(["make", "kernel/kernel", "fs.img"]))'
echo "ccache stats for the util build (clean tree, plain make via python3 subprocess):"

ccache -s
stats=$(ccache --print-stats)
hits=$(echo "$stats" | awk '$1=="direct_cache_hit"||$1=="preprocessed_cache_hit"{h+=$2} END{print h+0}')
misses=$(echo "$stats" | awk '$1=="cache_miss"{m+=$2} END{print m+0}')
echo "ccache hits=$hits misses=$misses"
if [ "$hits" -eq 0 ]; then
  echo "ccache has no hits: the pre-warm did not work"
  exit 1
fi
echo "ccache size: $(du -sh /root/.cache/ccache | cut -f1)"

rc=0
err=$(make -q kernel/kernel fs.img 2>&1) || rc=$?
if [ -n "$err" ] || [ "$rc" -ne 0 ]; then
  echo "plain make -q kernel/kernel fs.img: rc=$rc"
  echo "$err"
  exit 1
fi
test -s kernel/kernel && test -s fs.img
echo "guest build ok: plain make -q is clean"

cat > /root/xv6-README.txt <<'EOF'
xv6 in xiaonux
==============

The MIT 6.1810 xv6 labs run here on an emulated xv6 machine. The lab
Makefiles and graders are the unmodified course ones.

Start (the lab is already cloned in ~/xv6-labs-2026, branch util):

    cd ~/xv6-labs-2026
    make qemu            xv6 boots in this terminal; Ctrl-A x quits
    make qemu-gdb        waits for gdb; in a second tab (+ above the terminal)
                         run gdb (see below)
    make grade           runs the grader (make clean first, then the tests)

Note: `make qemu` makes a new fs.img every time (that is the lab's
Makefile), so files written in xv6 are lost at the next `make qemu`. Use
`make qemu-fs` to keep them.

Debugging with gdb (second tab, + above the terminal):

    gdb -nx -ex 'set architecture riscv:rv64' \
        -ex "target remote 127.0.0.1:$(make print-gdbport)" \
        -ex 'symbol-file kernel/kernel' -ex 'break main' -ex continue

Other years (bundles are in /usr/share/xv6):

    git clone /usr/share/xv6/xv6-labs-2025.bundle xv6-labs-2025
    git clone /usr/share/xv6/xv6-labs-2024.bundle xv6-labs-2024
    git -C xv6-labs-2025 checkout util

The xv6-riscv master repository is /usr/share/xv6/xv6-riscv.bundle.

Supported labs: util, syscall, pgtbl, traps, cow, mmap.
Not supported here: fs (needs a 200 MB disk), lock (needs 4 CPUs), net
(needs a network card). The machine has 1 CPU and 128 MB of RAM.
EOF
du -sh /root/xv6-labs-2026 /usr/share/xv6 /usr/share/xv6/*.bundle
echo "xv6 setup done"
