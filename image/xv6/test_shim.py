# Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
"""Host tests for the xv6 QEMU shim (qemu-system-riscv64).

Run from the repo root: python3 -m unittest image/xv6/test_shim.py

The argument lists are the QEMUOPTS / QEMUGDB lines of the xv6 master and the
xv6 labs 2024 and 2025 Makefiles. The handshake test runs the shim in this
process against a fake page on a unix socket, so the protocol is exercised
without a browser.
"""
import base64
import importlib.machinery
import importlib.util
import os
import shutil
import signal
import socket
import struct
import tempfile
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM_PATH = os.path.join(HERE, "qemu-system-riscv64")
FIXTURE = os.path.abspath(os.path.join(HERE, "..", "..", "build", "xv6", "master"))

_loader = importlib.machinery.SourceFileLoader("qemu_shim", SHIM_PATH)
shim = importlib.util.module_from_spec(importlib.util.spec_from_loader("qemu_shim", _loader))
_loader.exec_module(shim)

# QEMUOPTS from the labs' Makefiles ($K/kernel and fs.img expanded, CPUS as the Makefile sets it).
BASE = ["-machine", "virt", "-bios", "none", "-kernel", "kernel/kernel", "-m", "128M",
        "-smp", "3", "-nographic", "-global", "virtio-mmio.force-legacy=false",
        "-drive", "file=fs.img,if=none,format=raw,id=x0",
        "-device", "virtio-blk-device,drive=x0,bus=virtio-mmio-bus.0"]
GDB = ["-S", "-gdb", "tcp::25000"]  # qemu-gdb: QEMUOPTS -S $(QEMUGDB)
NET_LAB = ["-netdev", "user,id=net0,hostfwd=udp::25999-:2000,hostfwd=udp::30999-:2001",
           "-object", "filter-dump,id=net0,netdev=net0,file=packets.pcap",
           "-device", "e1000,netdev=net0,bus=pcie.0"]


def cpus(n):
    return BASE[:BASE.index("-smp") + 1] + [str(n)] + BASE[BASE.index("-smp") + 2:]


class ParseArgs(unittest.TestCase):
    def test_master_and_labs_2024_2025(self):
        # xv6 master: CPUS 3. Labs: CPUS 3, the fs lab CPUS 1, the lock lab CPUS 4.
        for argv in (BASE, cpus(1), cpus(4)):
            o = shim.parse_args(argv)
            self.assertEqual(o.kernel, "kernel/kernel")
            self.assertEqual(o.ram_mb, 128)
            self.assertEqual(o.drive, "fs.img")
            self.assertIsNone(o.gdb_port)
            self.assertFalse(o.halt)

    def test_qemu_gdb(self):
        o = shim.parse_args(BASE + GDB)
        self.assertEqual(o.gdb_port, 25000)
        self.assertTrue(o.halt)

    def test_gdb_forms(self):
        self.assertEqual(shim.parse_args(["-gdb", "tcp:127.0.0.1:2"]).gdb_port, 2)
        self.assertEqual(shim.parse_args(["-s"]).gdb_port, 1234)
        for bad in ("tcp:example.com:1", "unix:/tmp/x", "tcp::0", "tcp::70000", "tcp::x"):
            with self.assertRaises(shim.ShimError, msg=bad):
                shim.parse_args(["-gdb", bad])

    def test_memory_and_smp_forms(self):
        self.assertEqual(shim.parse_mem("128M"), 128)
        self.assertEqual(shim.parse_mem("128"), 128)
        self.assertEqual(shim.parse_mem("1G"), 1024)
        self.assertEqual(shim.parse_mem("262144K"), 256)
        for bad in ("", "M", "12x", "0M", "512K"):
            with self.assertRaises(shim.ShimError, msg=bad):
                shim.parse_mem(bad)
        with self.assertRaises(shim.ShimError):
            shim.parse_args(["-smp", "0"])

    def test_info_flags(self):
        self.assertEqual(shim.parse_args(["--version"]).action, "version")
        self.assertEqual(shim.parse_args(["-version"]).action, "version")
        self.assertEqual(shim.parse_args(["-help"]).action, "help")
        self.assertEqual(shim.parse_args(["-machine", "help"]).action, "machine-help")
        self.assertEqual(shim.VERSION, "QEMU emulator version 10.0.0 (xiaonux xv6 runner)")
        # the lab Makefile probes `-help | grep '^-gdb'`
        self.assertTrue(any(line.startswith("-gdb ") for line in shim.USAGE.splitlines()))

    def test_refused_options(self):
        with self.assertRaises(shim.ShimError) as cm:
            shim.parse_args(BASE + NET_LAB)
        self.assertIn("not supported in xiaonux: -netdev", str(cm.exception))
        for argv in (["-machine", "pc"], ["-bios", "x.bin"], ["-drive", "file=a,format=qcow2"],
                     ["-device", "e1000"], ["-nope"], ["-kernel"]):
            with self.assertRaises(shim.ShimError, msg=argv):
                shim.parse_args(argv)


def make_elf(segments, e_machine=243, ei_class=2):
    """A minimal ELF64 little-endian file. segments: (paddr, data, memsz)."""
    phoff = 64
    body = bytearray()
    phdrs = bytearray()
    data_off = phoff + 56 * len(segments)
    for paddr, data, memsz in segments:
        off = data_off + len(body)
        body += data
        phdrs += struct.pack("<IIQQQQQQ", 1, 7, off, paddr, paddr, len(data), memsz, 0x1000)
    ident = b"\x7fELF" + bytes([ei_class, 1, 1]) + b"\x00" * 9
    hdr = ident + struct.pack("<HHIQQQIHHHHHH", 2, e_machine, 1, 0x80000000, phoff, 0, 0,
                              64, 56, len(segments), 64, 0, 0)
    return bytes(hdr + phdrs + body)


class Flatten(unittest.TestCase):
    def test_matches_objcopy_for_the_fixture(self):
        kernel = os.path.join(FIXTURE, "kernel")
        binary = os.path.join(FIXTURE, "kernel.bin")
        if not (os.path.exists(kernel) and os.path.exists(binary)):
            self.skipTest(f"fixture missing: {FIXTURE}")
        with open(kernel, "rb") as f:
            flat = shim.flatten_kernel(f.read())
        with open(binary, "rb") as f:
            self.assertEqual(flat, f.read())

    def test_gaps_are_zero_and_trailing_bss_is_not_included(self):
        elf = make_elf([(0x80000000, b"AB", 2), (0x80000010, b"CD", 2 + 64)])
        self.assertEqual(shim.flatten_kernel(elf), b"AB" + b"\x00" * 14 + b"CD")
        # bss between two segments is zero-filled
        elf = make_elf([(0x80000000, b"AB", 40), (0x80000010, b"CD", 2)])
        self.assertEqual(shim.flatten_kernel(elf), b"AB" + b"\x00" * 14 + b"CD")

    def test_rejections(self):
        good = make_elf([(0x80000000, b"XY", 2)])
        self.assertEqual(shim.flatten_kernel(good), b"XY")
        cases = {
            "not an ELF": b"#!/bin/sh\n" + b"\x00" * 100,
            "32-bit ELF": make_elf([(0x80000000, b"X", 1)], ei_class=1),
            "x86 ELF": make_elf([(0x80000000, b"X", 1)], e_machine=62),
            "load below RAM": make_elf([(0x10000000, b"X", 1)]),
            "no loadable segments": make_elf([]),
            "truncated": good[:-1],
            "bad magic": b"\x00" + good[1:],
        }
        for name, data in cases.items():
            with self.assertRaises(shim.ShimError, msg=name):
                shim.flatten_kernel(data)
        too_big = make_elf([(0x80000000 + (128 << 20), b"X", 1)])
        with self.assertRaises(shim.ShimError):
            shim.flatten_kernel(too_big)


class EscapeKeys(unittest.TestCase):
    def setUp(self):
        self.s = shim.Shim(shim.Options())
        self.s.phase = "live"

    def test_ctrl_a_ctrl_a_is_one_ctrl_a_and_other_keys_pass(self):
        self.assertEqual(self.s.escape_filter(b"a\x01\x01b"), (b"a\x01b", False))
        self.assertEqual(self.s.escape_filter(b"\x01q"), (b"\x01q", False))
        self.assertEqual(self.s.escape_filter(b"c\x01"), (b"c", False))
        self.assertEqual(self.s.escape_filter(b"q"), (b"\x01q", False))  # the pending escape carries over

    def test_ctrl_a_x_quits_and_keeps_the_bytes_before_it(self):
        self.assertEqual(self.s.escape_filter(b"ab\x01x"), (b"ab", True))

    def test_read_stdin_sends_bytes_then_stops(self):
        self.s.stdin_tty = True
        with mock.patch.object(shim.os, "read", return_value=b"ab\x01x"):
            self.s.read_stdin()
        self.assertEqual(bytes(self.s.agent_out), b"x6 in YWI=\nx6 stop\n")
        self.assertEqual(self.s.phase, "stopping")


class Handshake(unittest.TestCase):
    """The shim against a fake page: begin/kb/fb/run, then ready, fd and exit."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="xv6shim")
        self.old_sock = shim.AGENT_SOCK
        self.old_wait = shim.HANDSHAKE_S
        self.handlers = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        self.fs = bytes(range(256)) * 40  # 10240 bytes: three 4 KB blocks, the last short
        self.fs_path = os.path.join(self.dir, "fs.img")
        with open(self.fs_path, "wb") as f:
            f.write(self.fs)
        self.kernel_path = os.path.join(self.dir, "kernel")
        self.kernel_elf = make_elf([(0x80000000, b"\x13\x00\x00\x00" * 8, 32)])
        with open(self.kernel_path, "wb") as f:
            f.write(self.kernel_elf)
        # AF_UNIX paths are short; keep the socket in a short directory.
        self.sock_path = os.path.join(self.dir, "a.sock")
        shim.AGENT_SOCK = self.sock_path
        self.lines = []
        self.conns = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.sock_path)
        self.server.listen(1)

    def tearDown(self):
        shim.AGENT_SOCK = self.old_sock
        shim.HANDSHAKE_S = self.old_wait
        for s, h in self.handlers.items():
            signal.signal(s, h)
        for c in self.conns:
            c.close()
        self.server.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def page(self, behaviour):
        """Accept the shim, record its lines, and run behaviour(conn) once on `x6 run`.
        The connection stays open until tearDown, as a real agent's would."""
        def serve():
            conn, _ = self.server.accept()
            self.conns.append(conn)
            buf = b""
            ran = False
            try:
                while True:
                    d = conn.recv(65536)
                    if not d:
                        return
                    buf += d
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        self.lines.append(line.decode())
                        if line == b"x6 run" and not ran:
                            ran = True
                            behaviour(conn)
            except OSError:
                pass
        t = threading.Thread(target=serve, daemon=True)
        t.start()
        return t

    def run_shim(self, argv=None, stdout_tty=False):
        argv = argv or ["-machine", "virt", "-bios", "none", "-kernel", self.kernel_path,
                        "-m", "128M", "-smp", "1", "-nographic",
                        "-drive", f"file={self.fs_path},if=none,format=raw,id=x0",
                        "-device", "virtio-blk-device,drive=x0"]
        o = shim.parse_args(argv)
        # stdout is a pipe (the grader) or a tty, as the test says; stdin is never a tty here.
        with mock.patch.object(shim.Shim, "stdin_live", return_value=False), \
                mock.patch.object(shim.os, "isatty", side_effect=lambda fd: fd == 1 and stdout_tty):
            return shim.Shim(o).run()

    def test_full_session_writes_back_fd_blocks(self):
        def behaviour(conn):
            conn.sendall(b"x6 ready\n")
            changed = bytearray(self.fs[4096:8192])
            changed[0] = 0x7E
            conn.sendall(b"x6 fd 4096 " + base64.b64encode(bytes(changed)) + b"\n")
            conn.sendall(b"x6 exit 0\n")
        t = self.page(behaviour)
        code = self.run_shim()  # stdout is a pipe: the begin line asks for prompt sync
        t.join(5)
        self.assertEqual(code, 0)
        self.assertTrue(self.lines[0].startswith("x6 begin 128 0 0 "))
        kernel_len = len(shim.flatten_kernel(self.kernel_elf))
        self.assertEqual(self.lines[0], f"x6 begin 128 0 0 {kernel_len} {len(self.fs)} 1")
        self.assertEqual(self.lines[-1], "x6 run")
        kb = [l for l in self.lines if l.startswith("x6 kb ")]
        fb = [l for l in self.lines if l.startswith("x6 fb ")]
        self.assertEqual(base64.b64decode(kb[0][len("x6 kb "):]), shim.flatten_kernel(self.kernel_elf))
        got_fs = b"".join(base64.b64decode(l[len("x6 fb "):]) for l in fb)
        self.assertEqual(got_fs, self.fs)
        with open(self.fs_path, "rb") as f:
            disk = f.read()
        expected = bytearray(self.fs)
        expected[4096] = 0x7E
        self.assertEqual(disk, bytes(expected))

    def test_tty_stdout_begin_is_the_old_line(self):
        # A terminal gets no prompt sync: the begin line has no sync field.
        def behaviour(conn):
            conn.sendall(b"x6 ready\n")
            conn.sendall(b"x6 exit 0\n")
        t = self.page(behaviour)
        code = self.run_shim(stdout_tty=True)
        t.join(5)
        self.assertEqual(code, 0)
        kernel_len = len(shim.flatten_kernel(self.kernel_elf))
        self.assertEqual(self.lines[0], f"x6 begin 128 0 0 {kernel_len} {len(self.fs)}")

    def test_busy_page_is_an_error(self):
        t = self.page(lambda conn: conn.sendall(b"x6 busy\n"))
        with self.assertRaises(shim.ShimError) as cm:
            self.run_shim()
        t.join(5)
        self.assertEqual(str(cm.exception), "another xv6 is running")

    def test_page_error_is_printed_and_fails(self):
        t = self.page(lambda conn: conn.sendall(b"x6 err kernel size out of range\n"))
        with self.assertRaises(shim.ShimError) as cm:
            self.run_shim()
        t.join(5)
        self.assertEqual(str(cm.exception), "kernel size out of range")

    def test_no_answer_times_out(self):
        shim.HANDSHAKE_S = 0.3
        t = self.page(lambda conn: None)
        with self.assertRaises(shim.ShimError) as cm:
            self.run_shim()
        t.join(5)
        self.assertIn("didn't answer", str(cm.exception))

    def test_no_agent_socket(self):
        shim.AGENT_SOCK = os.path.join(self.dir, "missing.sock")
        with self.assertRaises(shim.ShimError) as cm:
            self.run_shim()
        self.assertIn("cannot reach xiaonux-agent", str(cm.exception))

    def test_stop_without_exit_fails_after_the_wait(self):
        # The page says ready and then never sends exit. A stop request (what a
        # signal or a vanished parent sets) must end the shim after EXIT_WAIT_S.
        old_wait = shim.EXIT_WAIT_S
        shim.EXIT_WAIT_S = 0.3
        self.page(lambda conn: conn.sendall(b"x6 ready\n"))
        s = shim.Shim(shim.parse_args(["-kernel", self.kernel_path, "-drive", f"file={self.fs_path}"]))
        threading.Timer(0.3, lambda: setattr(s, "stop_requested", True)).start()
        try:
            with mock.patch.object(shim.Shim, "stdin_live", return_value=False):
                with self.assertRaises(shim.ShimError) as cm:
                    s.run()
            self.assertIn("did not report an exit", str(cm.exception))
        finally:
            shim.EXIT_WAIT_S = old_wait


class PromptSync(unittest.TestCase):
    """Pipe output (grading): a write ends after each "$ ", the page is paused
    there, and the shim acks after ACK_GAP. Output after the prompt is held until
    the ack. Terminal output passes through with no split and no ack.
    The deadline is set by hand (due) instead of waiting out ACK_GAP."""

    def make(self, tty):
        s = shim.Shim.__new__(shim.Shim)
        s.stdout_tty = tty
        s.sync_console = not tty
        s.stop_requested = False
        s.stop_sent = False
        s.phase = "live"
        s.stdin_tty = False
        s.stdin_bg = False
        s.escape = False
        s.agent_in = bytearray()
        s.agent_out = bytearray()
        s.out_held = bytearray()
        s.ack_at = None
        s.out_tail = b""
        s.writes = []
        s.write_all = lambda b: s.writes.append(bytes(b))
        return s

    def due(self, s):
        """The ack deadline has passed, as the select loop would see it."""
        s.ack_at = 0.0
        s.service_ack()

    def test_tty_writes_through_without_sync(self):
        s = self.make(True)
        s.write_out(b"a$ b$ c")
        self.assertEqual(s.writes, [b"a$ b$ c"])
        self.assertIsNone(s.ack_at)
        self.assertEqual(bytes(s.agent_out), b"")

    def test_pipe_splits_after_prompt_and_acks(self):
        s = self.make(False)
        self.assertTrue(s.sync_console)
        s.write_out(b"a$ DONE\n$ tail")
        self.assertEqual(s.writes, [b"a$ "])            # the rest waits for the ack
        self.assertIsNotNone(s.ack_at)
        self.assertEqual(bytes(s.out_held), b"DONE\n$ tail")
        self.assertEqual(bytes(s.agent_out), b"")        # no ack before the gap
        self.due(s)
        self.assertEqual(bytes(s.agent_out), b"x6 ack\n")
        self.assertEqual(s.writes, [b"a$ ", b"DONE\n$ "])
        self.assertEqual(bytes(s.out_held), b"tail")
        self.due(s)
        self.assertEqual(bytes(s.agent_out), b"x6 ack\nx6 ack\n")
        self.assertEqual(s.writes, [b"a$ ", b"DONE\n$ ", b"tail"])
        self.assertIsNone(s.ack_at)                      # no prompt left: nothing scheduled
        self.assertEqual(bytes(s.out_held), b"")

    def test_output_without_a_prompt_is_not_held(self):
        s = self.make(False)
        s.write_out(b"a$b  c $")                         # a "$" at the end is not yet a prompt
        self.assertEqual(s.writes, [b"a$b  c $"])
        self.assertIsNone(s.ack_at)
        self.assertEqual(bytes(s.agent_out), b"")

    def test_prompt_split_across_two_out_lines(self):
        s = self.make(False)
        s.write_out(b"x$")
        self.assertIsNone(s.ack_at)
        s.write_out(b" y")
        self.assertEqual(s.writes, [b"x$", b" "])        # the space completes the prompt
        self.assertEqual(bytes(s.out_held), b"y")
        self.assertIsNotNone(s.ack_at)

    def test_dollar_then_other_text_is_not_a_prompt(self):
        s = self.make(False)
        s.write_out(b"x$")
        s.write_out(b"y z")
        self.assertIsNone(s.ack_at)
        self.assertEqual(s.writes, [b"x$", b"y z"])

    def test_stdin_read_before_the_ack_goes_first(self):
        s = self.make(False)
        s.write_out(b"$ ")
        with mock.patch.object(shim.os, "read", return_value=b"echo DONE\n"):
            s.read_stdin()
        typed = b"x6 in " + base64.b64encode(b"echo DONE\n") + b"\n"
        self.assertEqual(bytes(s.agent_out), typed)      # forwarded at once
        self.due(s)
        self.assertEqual(bytes(s.agent_out), typed + b"x6 ack\n")

    def test_no_ack_once_stopping_and_held_output_is_written(self):
        s = self.make(False)
        s.stop_sent = True
        s.phase = "stopping"
        s.write_out(b"a$ b")
        self.due(s)
        self.assertEqual(bytes(s.agent_out), b"")
        self.assertEqual(s.writes, [b"a$ ", b"b"])

    def test_flush_held_writes_the_rest_at_exit(self):
        s = self.make(False)
        s.write_out(b"x$ y$ z")
        self.assertEqual(s.writes, [b"x$ "])
        s.flush_held()
        self.assertEqual(s.writes, [b"x$ ", b"y$ z"])
        self.assertEqual(bytes(s.out_held), b"")


if __name__ == "__main__":
    unittest.main()
