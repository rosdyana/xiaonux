// WISP v1 client: many TCP streams over one WebSocket.
// Packet: type u8 | stream id u32 LE | payload
//   CONNECT  0x01  stream type u8 (1 = TCP) | port u16 LE | host (UTF-8)
//   DATA     0x02  bytes
//   CONTINUE 0x03  buffer remaining u32 LE  (stream 0 at start: initial buffer)
//   CLOSE    0x04  reason u8
// Flow control is client -> server only: each DATA packet uses one slot of
// the stream's buffer; the server refills it with CONTINUE.

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
  buffer: number;
  pending: Uint8Array[];
  closed: boolean;
}

export type WispStatus = 'connecting' | 'connected' | 'disconnected';

export class WispExit implements Exit {
  private ws: WebSocket | null = null;
  private streams = new Map<number, Stream>();
  private nextId = 1;
  private initialBuffer = 0;
  private ready: Promise<void> | null = null;
  private outbox: Uint8Array<ArrayBuffer>[] = [];

  constructor(
    readonly kind: 'helper' | 'relay',
    private wsUrl: string,
    private pingUrl: string,
    private onStatus: (s: WispStatus, detail?: string) => void = () => {},
    private allowed?: string[],
    private ports?: number[],
  ) {}

  allows(host: string, port: number): boolean {
    if (this.ports && !this.ports.includes(port)) return false;
    if (!this.allowed) return true;
    const h = host.toLowerCase();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
    return this.allowed.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) || h === a.slice(2) : h === a.toLowerCase()));
  }

  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.onStatus('connecting');
    this.ready = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let gotInitial = false;
      ws.onmessage = (e) => {
        const p = new Uint8Array(e.data as ArrayBuffer);
        if (!gotInitial && p[0] === CONTINUE && readU32(p, 1) === 0) {
          gotInitial = true;
          this.initialBuffer = readU32(p, 5);
          this.onStatus('connected');
          resolve();
          for (const b of this.outbox) ws.send(b);
          this.outbox = [];
          return;
        }
        this.onPacket(p);
      };
      ws.onclose = (e) => {
        this.onStatus('disconnected', e.reason || `code ${e.code}`);
        if (!gotInitial) reject(new Error(`exit closed (${e.code})`));
        this.ws = null;
        this.ready = null;
        for (const s of [...this.streams.values()]) this.finish(s, 'network connection lost');
      };
      ws.onerror = () => {};
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  private raw(type: number, id: number, payload: Uint8Array) {
    const b = new Uint8Array(5 + payload.length);
    b[0] = type;
    new DataView(b.buffer).setUint32(1, id, true);
    b.set(payload, 5);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.initialBuffer) this.ws.send(b);
    else this.outbox.push(b);
  }

  connect(host: string, port: number): ExitStream {
    const id = this.nextId++;
    const s: Stream = {
      id, buffer: 0, pending: [], closed: false,
      onData: () => {}, onClose: () => {},
      write: (d) => {
        if (s.closed) return;
        s.pending.push(d);
        this.flush(s);
      },
      close: () => {
        if (s.closed) return;
        s.closed = true;
        this.flush(s, true);
      },
    };
    this.streams.set(id, s);
    const hostBytes = new TextEncoder().encode(host);
    const payload = new Uint8Array(3 + hostBytes.length);
    payload[0] = 1; // TCP
    new DataView(payload.buffer).setUint16(1, port, true);
    payload.set(hostBytes, 3);
    this.ensure().then(
      () => {
        s.buffer = this.initialBuffer;
        this.flush(s);
      },
      (e) => this.finish(s, String(e.message ?? e)),
    );
    this.raw(CONNECT, id, payload);
    return s;
  }

  /** Send pending DATA while the stream has buffer; CLOSE after the last byte. */
  private flush(s: Stream, closing = false) {
    while (s.pending.length && s.buffer > 0) {
      this.raw(DATA, s.id, s.pending.shift()!);
      s.buffer--;
    }
    if ((s.closed || closing) && !s.pending.length && this.streams.has(s.id)) {
      this.raw(CLOSE, s.id, new Uint8Array([0x02]));
      this.streams.delete(s.id);
    }
  }

  private onPacket(p: Uint8Array) {
    if (p.length < 5) return;
    const id = readU32(p, 1);
    const s = this.streams.get(id);
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

  private finish(s: Stream, reason: string | null) {
    if (!this.streams.has(s.id) && s.closed) return;
    this.streams.delete(s.id);
    s.closed = true;
    s.onClose(reason);
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

  close() {
    this.ws?.close();
  }
}

function readU32(p: Uint8Array, off: number) {
  return new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(off, true);
}
