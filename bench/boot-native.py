#!/usr/bin/env python3
"""Boot a TinyEMU config natively under a pty, wait for a prompt, run commands.

Usage: boot-native.py TEMU CFG [--prompt REGEX] [--login USER[:PASS]]
                      [--timeout SEC] [--cmd CMD ...]

Prints the console transcript and, on the last line, a JSON summary with the
time to first prompt. Exit code 0 when every step matched, 1 otherwise.
"""
import argparse, json, os, pty, re, select, signal, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("temu")
ap.add_argument("cfg")
ap.add_argument("--prompt", default=r"[#$] $")
ap.add_argument("--login", default=None, help="USER or USER:PASS")
ap.add_argument("--timeout", type=float, default=300)
ap.add_argument("--cmd", action="append", default=[])
ap.add_argument("--quiet", action="store_true")
ap.add_argument("--save", help="after the commands, SIGUSR1-save a snapshot to this path")
ap.add_argument("--restore", help="restore this snapshot instead of booting")
ap.add_argument("--rw", action="store_true", help="write guest disk changes to the image file")
a = ap.parse_args()
a.temu = os.path.abspath(a.temu)

env = dict(os.environ)
if a.save:
    env["XIAONUX_SNAPSHOT_OUT"] = os.path.abspath(a.save)
if a.restore:
    env["XIAONUX_RESTORE"] = os.path.abspath(a.restore)
pid, fd = pty.fork()
if pid == 0:
    os.environ.clear()
    os.environ.update(env)
    os.chdir(os.path.dirname(os.path.abspath(a.cfg)))
    os.execv(a.temu, [a.temu] + (["-rw"] if a.rw else []) + [os.path.basename(a.cfg)])

t0 = time.monotonic()
buf = b""

def out(b):
    if not a.quiet:
        sys.stdout.write(b.decode("utf-8", "replace"))
        sys.stdout.flush()

def expect(pattern, timeout):
    global buf
    rx = re.compile(pattern.encode(), re.M)
    end = time.monotonic() + timeout
    while True:
        m = rx.search(buf)
        if m:
            buf = buf[m.end():]
            return True
        left = end - time.monotonic()
        if left <= 0:
            return False
        r, _, _ = select.select([fd], [], [], min(left, 0.5))
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            out(chunk)
            buf += chunk

def send(s):
    for ch in s.encode():
        os.write(fd, bytes([ch]))
        time.sleep(0.002)

result = {"ok": False}
try:
    if a.restore:
        # A restored guest sits at its prompt: poke it to print a fresh one.
        if not expect(r"restored", 60):
            raise SystemExit
        send("\r")
    elif a.login:
        user, _, pw = a.login.partition(":")
        if not expect(r"login: ?$", a.timeout):
            raise SystemExit
        result["login_prompt_s"] = round(time.monotonic() - t0, 2)
        send(user + "\r")
        if pw:
            if not expect(r"[Pp]assword: ?$", 60):
                raise SystemExit
            send(pw + "\r")
    if not expect(a.prompt, a.timeout):
        raise SystemExit
    result["prompt_s"] = round(time.monotonic() - t0, 2)
    cmd_times = []
    for c in a.cmd:
        t1 = time.monotonic()
        send(c + "\r")
        if not expect(a.prompt, a.timeout):
            raise SystemExit
        cmd_times.append(round(time.monotonic() - t1, 2))
    result["cmd_s"] = cmd_times
    if a.save:
        t1 = time.monotonic()
        os.kill(pid, signal.SIGUSR1)
        if not expect(r"snapshot saved: .*\((\d+) bytes\)", 120):
            raise SystemExit
        result["save_s"] = round(time.monotonic() - t1, 2)
        result["snapshot_bytes"] = os.path.getsize(a.save)
    result["ok"] = True
except SystemExit:
    pass
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    print("\n" + json.dumps(result))
sys.exit(0 if result["ok"] else 1)
