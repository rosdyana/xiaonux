// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
// The page side of `make qemu` in the guest. The shim (image/xv6/qemu-system-
// riscv64) talks `x6` lines to xiaonux-agent, which relays them to /dev/hvc1,
// where the Debian worker hands them here. This module is pure logic: the
// caller injects how to send a line and how to start the machine, so it runs
// under node (xv6-bridge.test.ts). main.ts wires it to the Debian worker and
// to xv6.worker.ts. The line protocol is documented in parseShimLine below
// and in image/xv6/qemu-system-riscv64.

/** Limits enforced here, not by the shim. RAM is always 128 MB. */
export const X6 = {
  RAM_MB: 128,
  KERNEL_MAX: 8 << 20,
  FS_MAX: 64 << 20,
  /** raw bytes per x6 line (kb/fb/in/gi/out/go) */
  CHUNK: 48 * 1024,
  /** fs.img write-back granularity */
  BLOCK: 4096,
  /** longest accepted line: a full base64 chunk plus its prefix */
  MAX_LINE: 70_000,
} as const;

/** A line from the shim (the `x6 ` prefix is included in the input). */
export type ShimLine =
  /** sync: the machine pauses after each "$ " until an ack (absent in the line = false) */
  | { op: 'begin'; gdb: boolean; wait: boolean; kernelLen: number; fsLen: number; ramMb: number; sync: boolean }
  | { op: 'kb' | 'fb' | 'in' | 'gi'; data: Uint8Array }
  | { op: 'run' | 'stop' | 'ack' };

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UINT = /^\d{1,12}$/;

export function decodeB64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || !B64.test(s)) return null;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * Parse one shim line. Returns null for anything that doesn't fit the
 * protocol (syntax, a bad payload, or a payload over one chunk); the caller
 * drops it. Size limits that need session state are checked by the bridge.
 */
export function parseShimLine(line: string): ShimLine | null {
  if (line.length > X6.MAX_LINE || !line.startsWith('x6 ')) return null;
  const body = line.slice(3);
  const sp = body.indexOf(' ');
  const op = sp < 0 ? body : body.slice(0, sp);
  const rest = sp < 0 ? '' : body.slice(sp + 1);
  switch (op) {
    case 'begin': {
      // The sixth field (sync) is optional: an older shim sends five.
      const f = rest.split(' ');
      if (f.length !== 5 && f.length !== 6) return null;
      const [ram, gdb, wait, kl, fl, sync = '0'] = f;
      if (![ram, kl, fl].every((x) => UINT.test(x)) || ![gdb, wait, sync].every((x) => x === '0' || x === '1')) return null;
      return {
        op, ramMb: Number(ram), gdb: gdb === '1', wait: wait === '1', kernelLen: Number(kl), fsLen: Number(fl),
        sync: sync === '1',
      };
    }
    case 'kb':
    case 'fb':
    case 'in':
    case 'gi': {
      const data = decodeB64(rest);
      if (!data || data.length > X6.CHUNK) return null;
      return { op, data };
    }
    case 'run':
    case 'stop':
    case 'ack':
      return rest === '' ? { op } : null;
    default:
      return null;
  }
}

export interface FsBlock {
  offset: number;
  data: Uint8Array;
}

/**
 * The 4 KB blocks of cur that differ from orig, for the shim to write back.
 * The last block may be short. Returns null if the sizes differ (the fs is a
 * fixed-size disk, so a different size means something went wrong).
 */
export function changedBlocks(orig: Uint8Array, cur: Uint8Array, block: number = X6.BLOCK): FsBlock[] | null {
  if (orig.length !== cur.length) return null;
  const out: FsBlock[] = [];
  for (let off = 0; off < cur.length; off += block) {
    const end = Math.min(off + block, cur.length);
    let same = true;
    for (let i = off; i < end; i++) {
      if (orig[i] !== cur[i]) {
        same = false;
        break;
      }
    }
    if (!same) out.push({ offset: off, data: cur.slice(off, end) });
  }
  return out;
}

/** A running machine, as the bridge sees it. */
export interface XvHandle {
  input(data: Uint8Array): void;
  gdbIn(data: Uint8Array): void;
  /** the shim acked a prompt pause (sync sessions only): run again */
  resume(): void;
  /** asks for the final fs; the machine answers with XvEvents.stopped */
  stop(): void;
  terminate(): void;
}

export interface XvEvents {
  console(data: Uint8Array): void;
  gdb(data: Uint8Array): void;
  ready(): void;
  /** the gdb client sent `k`; `stopped` follows */
  killed(): void;
  stopped(fs: Uint8Array): void;
  error(message: string): void;
}

export interface XvStart {
  kernel: Uint8Array;
  /** a copy: the bridge keeps the original for the block diff */
  fs: Uint8Array;
  gdb: boolean;
  wait: boolean;
  /** pause after each "$ " until resume (the shim's stdout is a pipe: grading) */
  sync: boolean;
}

export interface X6BridgeDeps {
  /** one line to the shim, through the Debian worker and the agent */
  send(line: string): void;
  /** starts the machine; throws if it cannot be started */
  start(opts: XvStart, events: XvEvents): XvHandle;
  log?(message: string): void;
}

type State =
  | { phase: 'idle' }
  | {
      phase: 'loading';
      seq: number;
      gdb: boolean;
      wait: boolean;
      sync: boolean;
      kernel: Uint8Array;
      kernelGot: number;
      fs: Uint8Array;
      fsGot: number;
    }
  /** started, `ready` not yet seen */
  | { phase: 'starting'; seq: number; handle: XvHandle; orig: Uint8Array }
  | { phase: 'live'; seq: number; handle: XvHandle; orig: Uint8Array }
  /** `stop` sent to the machine; waiting for its fs */
  | { phase: 'stopping'; seq: number; handle: XvHandle; orig: Uint8Array };

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 300);

export class X6Bridge {
  private st: State = { phase: 'idle' };
  private seq = 0;
  private readonly deps: X6BridgeDeps;

  constructor(deps: X6BridgeDeps) {
    this.deps = deps;
  }

  /** A line from the shim. Anything that doesn't fit the protocol is dropped. */
  onLine(line: string): void {
    const m = parseShimLine(line);
    if (!m) return;
    switch (m.op) {
      case 'begin':
        return this.begin(m);
      case 'kb':
      case 'fb':
        return this.chunk(m.op, m.data);
      case 'run':
        return this.run();
      case 'in':
        if (this.st.phase === 'starting' || this.st.phase === 'live') this.st.handle.input(m.data);
        return;
      case 'gi':
        if (this.st.phase === 'starting' || this.st.phase === 'live') this.st.handle.gdbIn(m.data);
        return;
      case 'stop':
        return this.stopSession();
      case 'ack':
        // The shim's prompt ack. Stray acks (no machine running) are dropped.
        if (this.st.phase === 'starting' || this.st.phase === 'live') this.st.handle.resume();
        return;
    }
  }

  /** The Debian worker restarted or the page reset: end any session, send nothing. */
  kill(): void {
    if (this.st.phase === 'starting' || this.st.phase === 'live' || this.st.phase === 'stopping') {
      this.st.handle.terminate();
    }
    this.st = { phase: 'idle' };
  }

  /** Whether a machine is running (for the caller's UI). */
  get running(): boolean {
    return this.st.phase === 'starting' || this.st.phase === 'live' || this.st.phase === 'stopping';
  }

  private begin(m: Extract<ShimLine, { op: 'begin' }>): void {
    // A session still loading is replaced (its shim restarted); a running one is not.
    if (this.running) {
      this.deps.send('x6 busy');
      return;
    }
    if (m.kernelLen < 1 || m.kernelLen > X6.KERNEL_MAX) return this.fail('kernel size out of range (8 MB max)');
    if (m.fsLen < 1 || m.fsLen > X6.FS_MAX) return this.fail('fs.img size out of range (64 MB max)');
    this.st = {
      phase: 'loading',
      seq: ++this.seq,
      gdb: m.gdb,
      wait: m.wait,
      sync: m.sync,
      kernel: new Uint8Array(m.kernelLen),
      kernelGot: 0,
      fs: new Uint8Array(m.fsLen),
      fsGot: 0,
    };
  }

  private chunk(op: 'kb' | 'fb', data: Uint8Array): void {
    const st = this.st;
    if (st.phase !== 'loading') return;
    const isKernel = op === 'kb';
    const buf = isKernel ? st.kernel : st.fs;
    const got = isKernel ? st.kernelGot : st.fsGot;
    if (got + data.length > buf.length) return this.fail(`${op} past the declared length`);
    buf.set(data, got);
    if (isKernel) st.kernelGot += data.length;
    else st.fsGot += data.length;
  }

  private run(): void {
    const st = this.st;
    if (st.phase !== 'loading') return;
    if (st.kernelGot !== st.kernel.length || st.fsGot !== st.fs.length) {
      return this.fail('run before all bytes arrived');
    }
    const seq = st.seq;
    const orig = st.fs;
    const events: XvEvents = {
      console: (data) => {
        if (this.current(seq)) this.sendBytes('out', data);
      },
      gdb: (data) => {
        if (this.current(seq)) this.sendBytes('go', data);
      },
      ready: () => {
        if (this.st.phase === 'starting' && this.st.seq === seq) {
          this.st = { ...this.st, phase: 'live' };
          this.deps.send('x6 ready');
        }
      },
      killed: () => this.deps.log?.('gdb client sent k: stopping the machine'),
      stopped: (fs) => {
        if (this.current(seq)) this.finish(fs);
      },
      error: (message) => {
        if (this.current(seq)) this.machineError(message);
      },
    };
    let handle: XvHandle;
    try {
      handle = this.deps.start(
        { kernel: st.kernel, fs: orig.slice(), gdb: st.gdb, wait: st.wait, sync: st.sync },
        events,
      );
    } catch (e) {
      return this.fail(`cannot start xv6: ${oneLine(String((e as Error)?.message ?? e))}`);
    }
    this.st = { phase: 'starting', seq, handle, orig };
  }

  private current(seq: number): boolean {
    const st = this.st;
    return (st.phase === 'starting' || st.phase === 'live' || st.phase === 'stopping') && st.seq === seq;
  }

  private stopSession(): void {
    const st = this.st;
    if (st.phase === 'loading') this.st = { phase: 'idle' };
    else if (st.phase === 'starting' || st.phase === 'live') {
      this.st = { ...st, phase: 'stopping' };
      st.handle.stop();
    }
    // Idle or already stopping: a stray stop (the agent sends one on every disconnect).
  }

  private finish(fs: Uint8Array): void {
    const st = this.st;
    if (st.phase !== 'stopping' && st.phase !== 'live' && st.phase !== 'starting') return;
    this.st = { phase: 'idle' };
    st.handle.terminate();
    const blocks = changedBlocks(st.orig, fs);
    if (!blocks) {
      this.deps.send('x6 err fs.img size changed');
      this.deps.send('x6 exit 1');
      return;
    }
    for (const b of blocks) this.deps.send(`x6 fd ${b.offset} ${encodeB64(b.data)}`);
    this.deps.send('x6 exit 0');
  }

  private machineError(message: string): void {
    const phase = this.st.phase;
    if (phase === 'starting') {
      this.fail(message);
      return;
    }
    if (phase === 'live' || phase === 'stopping') {
      const st = this.st;
      this.st = { phase: 'idle' };
      st.handle.terminate();
      this.deps.send(`x6 err ${oneLine(message)}`);
      this.deps.send('x6 exit 1');
    }
  }

  /** Ends a handshake with an error the shim prints (it then exits). */
  private fail(message: string): void {
    const st = this.st;
    if (st.phase === 'starting' || st.phase === 'live' || st.phase === 'stopping') st.handle.terminate();
    this.st = { phase: 'idle' };
    this.deps.send(`x6 err ${oneLine(message)}`);
  }

  private sendBytes(op: 'out' | 'go', data: Uint8Array): void {
    for (let o = 0; o < data.length; o += X6.CHUNK) {
      this.deps.send(`x6 ${op} ${encodeB64(data.subarray(o, o + X6.CHUNK))}`);
    }
  }
}
