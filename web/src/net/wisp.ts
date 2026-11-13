// WISP v1 client: many TCP streams over one WebSocket.
// Packet: type u8 | stream id u32 LE | payload
//   CONNECT  0x01  stream type u8 (1 = TCP) | port u16 LE | host (UTF-8)
//   DATA     0x02  bytes
//   CONTINUE 0x03  buffer remaining u32 LE  (stream 0 at start: initial buffer)
//   CLOSE    0x04  reason u8
// Flow control is client -> server only: each DATA packet uses one slot of
// the stream's buffer; the server refills it with CONTINUE.
//
// Rotation (for the free-tier relay, where one WebSocket is one request with
// a small CPU budget): once a WebSocket has carried `rotateBytes`, new streams
// go to a fresh one and the old one closes when its last stream ends. If the
// relay drops a socket anyway, its streams fail and the next stream reconnects.

import type { Exit, ExitStream } from './exit';

const CONNECT = 1, DATA = 2, CONTINUE = 3, CLOSE = 4;

const CLOSE_REASONS: Record<number, string> = {
  0x01: 'closed', 0x02: 'closed', 0x03: 'network error',
  0x41: 'invalid destination', 0x42: 'host unreachable', 0x43: 'connection timed out',
  0x44: 'connection refused', 0x47: 'timed out', 0x48: 'blocked by the network policy',
  0x49: 'throttled',
};

interface Stream extends ExitStream {
  id: number;
  conn: Conn;
  buffer: number;
  pending: Uint8Array[];
  closed: boolean;
}

export type WispStatus = 'connecting' | 'connected' | 'disconnected' | 'rotated';

/** One WebSocket and the streams opened on it. */
class Conn {
  ws: WebSocket;
  streams = new Map<number, Stream>();
  initialBuffer = 0;
  ready: Promise<void>;
  bytes = 0;
  retired = false;
  dead = false;
  private outbox: Uint8Array<ArrayBuffer>[] = [];

  constructor(url: string, private owner: WispExit) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    let gotInitial = false;
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.onmessage = (e) => {
        const p = new Uint8Array(e.data as ArrayBuffer);
        this.bytes += p.length;
        if (!gotInitial && p[0] === CONTINUE && readU32(p, 1) === 0) {
          gotInitial = true;
          this.initialBuffer = readU32(p, 5);
          resolve();
          for (const b of this.outbox) this.ws.send(b);
          this.outbox = [];
          this.owner.status('connected');
          return;
        }
        this.onPacket(p);
      };
      this.ws.onclose = (e) => {
        this.dead = true;
        if (!gotInitial) reject(new Error(`exit closed (${e.code})`));
        for (const s of [...this.streams.values()]) this.finish(s, 'network connection lost');
        this.owner.connClosed(this, e.reason || `code ${e.code}`);
      };
      this.ws.onerror = () => {};
    });
    this.ready.catch(() => {});
  }

  raw(type: number, id: number, payload: Uint8Array) {
    const b = new Uint8Array(5 + payload.length);
    b[0] = type;
    new DataView(b.buffer).setUint32(1, id, true);
    b.set(payload, 5);
    this.bytes += b.length;
    if (this.ws.readyState === WebSocket.OPEN && this.initialBuffer) this.ws.send(b);
    else this.outbox.push(b);
  }

  /** Send pending DATA (coalesced) while the stream has buffer; CLOSE after the last byte. */
  flush(s: Stream) {
    while (s.pending.length && s.buffer > 0) {
      // merge small writes into one packet: fewer messages for the relay to handle
      let n = 0, k = 0;
      while (k < s.pending.length && n + s.pending[k].length <= 64 * 1024) n += s.pending[k++].length;
      if (k === 0) k = 1;
      const parts = s.pending.splice(0, k);
      let data: Uint8Array;
      if (parts.length === 1) data = parts[0];
      else {
        data = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
        let o = 0;
        for (const p of parts) { data.set(p, o); o += p.length; }
      }
      this.raw(DATA, s.id, data);
      s.buffer--;
    }
    if (s.closed && !s.pending.length && this.streams.has(s.id)) {
      this.raw(CLOSE, s.id, new Uint8Array([0x02]));
      this.streams.delete(s.id);
      this.maybeClose();
    }
  }

  private onPacket(p: Uint8Array) {
    if (p.length < 5) return;
    const s = this.streams.get(readU32(p, 1));
    if (!s) return;
    switch (p[0]) {
      case DATA:
        s.onData(p.slice(5));
        break;
      case CONTINUE:
        s.buffer = readU32(p, 5);
        this.flush(s);
        break;
      case CLOSE: {
        const reason = p[5];
        this.finish(s, reason === 0x02 || reason === 0x01 ? null : (CLOSE_REASONS[reason] ?? `closed (0x${reason.toString(16)})`));
        break;
      }
    }
  }

  finish(s: Stream, reason: string | null) {
    if (!this.streams.has(s.id)) return;
    this.streams.delete(s.id);
    s.closed = true;
    s.onClose(reason);
    this.maybeClose();
  }

  /** A retired connection goes away once its last stream is done. */
  maybeClose() {
    if (this.retired && this.streams.size === 0 && !this.dead) this.ws.close(1000, 'rotated');
  }
}

export class WispExit implements Exit {
  private current: Conn | null = null;
  private nextId = 1;
  /** closed for good: no more status events */
  private shut = false;

  constructor(
    readonly kind: 'helper' | 'relay',
    private wsUrl: string,
    private pingUrl: string,
    private onStatus: (s: WispStatus, detail?: string) => void = () => {},
    private allowed?: string[],
    private ports?: number[],
    /** bytes per WebSocket before new streams use a fresh one (0 = never) */
    private rotateBytes = 0,
  ) {}

  status(s: WispStatus, detail?: string) {
    if (this.shut) return;
    this.onStatus(s, detail);
  }

  connClosed(c: Conn, detail: string) {
    if (this.shut) return;
    if (c === this.current) {
      this.current = null;
      // A drop the client didn't ask for (e.g. the relay shed the request):
      // the next stream reconnects.
      this.onStatus('disconnected', detail);
    }
  }

  allows(host: string, port: number): boolean {
    if (this.ports && !this.ports.includes(port)) return false;
    if (!this.allowed) return true;
    const h = host.toLowerCase();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
    return this.allowed.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) || h === a.slice(2) : h === a.toLowerCase()));
  }

  private conn(): Conn {
    const c = this.current;
    if (c && !c.dead && !(this.rotateBytes && c.bytes > this.rotateBytes)) return c;
    if (c && !c.dead) {
      c.retired = true;
      c.maybeClose();
      this.onStatus('rotated');
    }
    if (!c || c.dead) this.onStatus('connecting');
    this.current = new Conn(this.wsUrl, this);
    return this.current;
  }

  connect(host: string, port: number): ExitStream {
    const conn = this.conn();
    const id = this.nextId++;
    const s: Stream = {
      id, conn, buffer: 0, pending: [], closed: false,
      onData: () => {}, onClose: () => {},
      write: (d) => {
        if (s.closed) return;
        s.pending.push(d);
        // coalesce writes made in the same turn into one packet
        if (s.pending.length === 1) queueMicrotask(() => conn.flush(s));
      },
      close: () => {
        if (s.closed) return;
        s.closed = true;
        queueMicrotask(() => conn.flush(s));
      },
    };
    conn.streams.set(id, s);
    const hostBytes = new TextEncoder().encode(host);
    const payload = new Uint8Array(3 + hostBytes.length);
    payload[0] = 1; // TCP
    new DataView(payload.buffer).setUint16(1, port, true);
    payload.set(hostBytes, 3);
    conn.ready.then(
      () => {
        s.buffer = conn.initialBuffer;
        conn.flush(s);
      },
      (e) => conn.finish(s, String(e.message ?? e)),
    );
    conn.raw(CONNECT, id, payload);
    return s;
  }

  async ping(host: string): Promise<number | null> {
    try {
      const r = await fetch(`${this.pingUrl}${this.pingUrl.includes('?') ? '&' : '?'}host=${encodeURIComponent(host)}`);
      if (!r.ok) return null;
      const j = (await r.json()) as { rtt_ms?: number };
      return typeof j.rtt_ms === 'number' ? j.rtt_ms : null;
    } catch {
      return null;
    }
  }

  /** New session URLs: new streams use a fresh socket; open streams finish on the old one. */
  renew(cfg: { wsUrl: string; pingUrl: string; allowed?: string[]; ports?: number[]; rotateBytes?: number }) {
    this.wsUrl = cfg.wsUrl;
    this.pingUrl = cfg.pingUrl;
    this.allowed = cfg.allowed;
    this.ports = cfg.ports;
    this.rotateBytes = cfg.rotateBytes ?? 0;
    const c = this.current;
    this.current = null;
    if (c && !c.dead) { c.retired = true; c.maybeClose(); }
  }

  close() {
    this.shut = true;
    const c = this.current;
    this.current = null;
    c?.ws.close();
  }
}

function readU32(p: Uint8Array, off: number) {
  return new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(off, true);
}
