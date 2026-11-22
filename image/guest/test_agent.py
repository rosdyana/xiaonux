#!/usr/bin/python3
"""Tests for xiaonux-agent. Each test runs the agent as a subprocess on one
end of a pty pair, with a temporary socket. Stdlib only; runs on macOS and Linux.

Run from the repo root: python3 image/guest/test_agent.py -v
"""
import base64, os, re, select, shutil, socket, subprocess, sys, tempfile, termios, threading, time, tty, unittest

AGENT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xiaonux-agent")
TAB_OUT_MAX = 3072
NL = "\n"


def b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


class Lines:
    """Reads a file descriptor on a thread and splits it into lines."""

    def __init__(self, fd: int):
        self.fd = fd
        self.lines = []
        self.buf = bytearray()
        self.cond = threading.Condition()
        self.done = False
        self.stop = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while not self.stop:
            try:
                r, _, _ = select.select([self.fd], [], [], 0.05)
                if not r:
                    continue
                data = os.read(self.fd, 65536)
            except (OSError, ValueError):
                break
            if not data:
                break
            with self.cond:
                self.buf += data
                while True:
                    i = self.buf.find(b"\n")
                    if i < 0:
                        break
                    self.lines.append(self.buf[:i].rstrip(b"\r").decode("ascii", "replace"))
                    del self.buf[:i + 1]
                self.cond.notify_all()
        with self.cond:
            self.done = True
            self.cond.notify_all()

    def mark(self) -> int:
        with self.cond:
            return len(self.lines)

    def wait(self, pred, since: int = 0, timeout: float = 5.0):
        """The first line at index >= since matching pred, or None on timeout."""
        end = time.monotonic() + timeout
        pos = since
        with self.cond:
            while True:
                n = len(self.lines)
                for i in range(pos, n):
                    if pred(self.lines[i]):
                        return self.lines[i]
                pos = n
                remain = end - time.monotonic()
                if remain <= 0 or self.done:
                    return None
                self.cond.wait(remain)

    def snapshot(self, since: int = 0):
        with self.cond:
            return list(self.lines[since:])

    def out_bytes(self, tid: int, since: int = 0) -> bytes:
        """Decoded payload of the "t out <tid>" lines at index >= since."""
        prefix = f"t out {tid} "
        chunks = [base64.b64decode(line[len(prefix):])
                  for line in self.snapshot(since) if line.startswith(prefix)]
        return b"".join(chunks)

    def stop_thread(self):
        self.stop = True
        self.thread.join(2)


class AgentTest(unittest.TestCase):
    def setUp(self):
        # Short name: the socket path must fit in sun_path (104 bytes on macOS).
        self.tmp = tempfile.mkdtemp(prefix="xna")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.sock = os.path.join(self.tmp, "a.sock")
        self.master, self.slave = os.openpty()
        self.addCleanup(os.close, self.master)
        self.addCleanup(os.close, self.slave)
        try:
            tty.setraw(self.master)
        except termios.error:
            pass
        env = dict(os.environ)
        env.update(XIAONUX_AGENT_DEV=os.ttyname(self.slave),
                   XIAONUX_AGENT_SOCK=self.sock,
                   XIAONUX_AGENT_TAB_CWD=self.tmp)
        self.errlog = open(os.path.join(self.tmp, "agent.err"), "wb")
        self.addCleanup(self.errlog.close)
        self.agent = subprocess.Popen([sys.executable, AGENT], env=env,
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                      stderr=self.errlog)
        self.addCleanup(self._stop_agent)
        self.dev = Lines(self.master)
        self.addCleanup(self.dev.stop_thread)
        deadline = time.monotonic() + 10
        while not os.path.exists(self.sock):  # created after the agent sets the pty raw
            if time.monotonic() > deadline or self.agent.poll() is not None:
                self.fail(f"agent did not start: {self.agent_stderr()}")
            time.sleep(0.02)
        self.expect(lambda l: l == "t ready 8", since=self.request("t reset", None))

    def _stop_agent(self):
        # Killing the agent closes its pty masters, which hang up the tab shells.
        self.agent.kill()
        self.agent.wait(timeout=5)

    def agent_stderr(self) -> str:
        try:
            with open(os.path.join(self.tmp, "agent.err"), "rb") as f:
                return f.read()[-2000:].decode("utf-8", "replace")
        except OSError:
            return ""

    def send(self, line: str):
        os.write(self.master, line.encode() + b"\n")

    def type_in(self, tid: int, text: str):
        """Type text into a tab (a trailing newline is added)."""
        self.send(f"t in {tid} {b64(text + NL)}")

    def expect(self, pred, since: int = 0, timeout: float = 5.0) -> str:
        line = self.dev.wait(pred, since, timeout)
        if line is None:
            self.fail(f"no matching line within {timeout}s; last lines: "
                      f"{self.dev.snapshot()[-6:]}; agent stderr: {self.agent_stderr()}")
        return line

    def request(self, line: str, pred, timeout: float = 5.0) -> int:
        """Send a line. Returns the index to search from; with pred, also waits for a reply."""
        since = self.dev.mark()
        self.send(line)
        if pred is not None:
            self.expect(pred, since, timeout)
        return since

    def open_tab(self, tid: int, cols: int = 80, rows: int = 24):
        since = self.request(f"t open {tid} {cols} {rows}", None)
        reply = self.expect(lambda l: l.startswith(f"t opened {tid}") or l.startswith(f"t error {tid} "),
                            since)
        self.assertEqual(reply, f"t opened {tid}")

    def wait_out(self, tid: int, needle: bytes, since: int = 0, timeout: float = 10.0) -> bytes:
        end = time.monotonic() + timeout
        while True:
            data = self.dev.out_bytes(tid, since)
            if needle in data:
                return data
            if time.monotonic() > end:
                self.fail(f"tab {tid} output lacks {needle!r} after {timeout}s: {data[-200:]!r}")
            time.sleep(0.05)

    def tab_ready(self, tid: int):
        """Wait until the tab's shell is up and reading input."""
        since = self.dev.mark()
        self.type_in(tid, "echo R$((6*7))R")
        self.wait_out(tid, b"R42R", since)

    def pid_of(self, tid: int) -> int:
        since = self.dev.mark()
        self.type_in(tid, "echo P$$P")
        end = time.monotonic() + 10
        while True:
            # The typed echo shows "P$$P", which has no digits, so only the output matches.
            m = re.search(rb"P(\d+)P", self.dev.out_bytes(tid, since))
            if m:
                return int(m.group(1))
            if time.monotonic() > end:
                self.fail(f"no pid from tab {tid}")
            time.sleep(0.05)

    def connect_client(self):
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.connect(self.sock)
        self.addCleanup(c.close)
        return c, Lines(c.fileno())

    def zombie_children(self):
        """Zombie children of the agent, from ps. None if ps is not installed."""
        if shutil.which("ps") is None:
            return None
        out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,stat="],
                             capture_output=True, text=True).stdout
        found = []
        for line in out.splitlines():
            fields = line.split()
            if len(fields) == 3 and fields[1] == str(self.agent.pid) and fields[2].startswith("Z"):
                found.append(line)
        return found

    # Tests

    def test_ping(self):
        self.expect(lambda l: l == "ok ping", since=self.request("ping", None))

    def test_unknown_tab_subcommand(self):
        self.expect(lambda l: l == "err t unknown", since=self.request("t bogus", None))

    def test_reset_ready(self):
        self.expect(lambda l: l == "t ready 8", since=self.request("t reset", None))

    def test_open_echo(self):
        self.open_tab(1)
        self.tab_ready(1)
        since = self.dev.mark()
        self.type_in(1, "echo hi-$((6*7))")
        self.wait_out(1, b"hi-42", since)

    def test_size(self):
        self.open_tab(1)
        self.tab_ready(1)
        self.send("t size 1 100 30")
        since = self.dev.mark()
        self.type_in(1, "stty size")
        self.wait_out(1, b"30 100", since)

    def test_exit(self):
        self.open_tab(1)
        self.tab_ready(1)
        self.type_in(1, "exit")
        self.expect(lambda l: l == "t exit 1 0", timeout=10)

    def test_cap_full(self):
        for tid in range(1, 9):
            self.open_tab(tid)
        since = self.request("t open 9 80 24", None)
        self.expect(lambda l: l == "t error 9 full", since=since)

    def test_busy(self):
        self.open_tab(1)
        since = self.request("t open 1 80 24", None)
        self.expect(lambda l: l == "t error 1 busy", since=since)

    def test_close_sleep_no_zombie(self):
        if self.zombie_children() is None:
            self.skipTest("ps is not installed")
        self.open_tab(2)
        self.tab_ready(2)
        self.type_in(2, "sleep 1000")
        time.sleep(0.5)  # let sleep start
        start = time.monotonic()
        since = self.request("t close 2", None)
        self.expect(lambda l: re.fullmatch(r"t exit 2 \d+", l) is not None, since=since, timeout=3)
        self.assertLess(time.monotonic() - start, 3)
        self.assertEqual(self.zombie_children(), [])

    def test_flood_fairness(self):
        self.open_tab(1)
        self.tab_ready(1)
        flood_since = self.dev.mark()
        self.type_in(1, "yes | head -c 2000000; echo D$((6*7))D")
        ping_since = self.request("ping", None)
        start = time.monotonic()
        self.expect(lambda l: l == "ok ping", since=ping_since, timeout=2)
        self.assertLess(time.monotonic() - start, 2)
        self.wait_out(1, b"D42D", flood_since, timeout=60)
        sizes = []
        for line in self.dev.snapshot(flood_since):
            if line.startswith("t out 1 "):
                sizes.append(len(base64.b64decode(line[len("t out 1 "):])))
        self.assertGreater(len(sizes), 1)
        self.assertLessEqual(max(sizes), TAB_OUT_MAX)

    def test_socket_client_is_x6_only(self):
        sock, client = self.connect_client()
        sock.sendall(b"t open 3 80 24\nx6 hello\n")
        self.expect(lambda l: l == "x6 hello", timeout=5)
        # The client's "t open" was dropped: nothing answered it.
        self.assertEqual([l for l in self.dev.snapshot() if l.startswith("t ") and l != "t ready 8"], [])

        # Positive control: x6 lines do reach the client, and tab output does not.
        self.open_tab(1)
        self.tab_ready(1)
        self.assertGreater(len(self.dev.out_bytes(1)), 0)
        self.send("x6 mark")  # from the page: the agent relays it to the client
        self.assertEqual(client.wait(lambda l: l == "x6 mark", timeout=5), "x6 mark")
        self.assertEqual([l for l in client.snapshot() if not l.startswith("x6 ")], [])

        # Disconnecting tells the page the x6 client went away.
        since = self.dev.mark()
        sock.close()
        self.expect(lambda l: l == "x6 stop", since=since, timeout=5)
        client.stop_thread()

    def test_reset_kills_tabs(self):
        self.open_tab(1)
        self.open_tab(2)
        self.tab_ready(1)
        self.tab_ready(2)
        pids = [self.pid_of(1), self.pid_of(2)]
        since = self.request("t reset", None)
        self.expect(lambda l: l == "t ready 8", since=since, timeout=10)
        for pid in pids:
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)


if __name__ == "__main__":
    unittest.main()
