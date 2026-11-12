// xiaonux relay: WISP v1 over a WebSocket, outbound TCP via connect(),
// for the browser VM when the user hasn't installed the helper.
//
//   POST /session  {turnstile}       -> {session, expires}   (Turnstile-gated)
//   GET  /wisp?session=S             WebSocket, WISP v1
//   GET  /ping?session=S&host=H      {"rtt_ms": N}  (TCP connect time)
//
// Only allowlisted host names, ports 80/443. Logs host names and byte
// counts only, never content.

import { connect } from 'cloudflare:sockets';

export interface Env {
  ALLOWED_HOSTS: string;    // comma separated; "*.example.org" allows subdomains
  ALLOWED_ORIGINS: string;  // comma separated page origins
  TURNSTILE_SECRET?: string;
  SESSION_KEY: string;      // HMAC key for session tokens
  DEV_NO_TURNSTILE?: string; // "1" only for local development
}

const CONNECT = 1, DATA = 2, CONTINUE = 3, CLOSE = 4;
const BUFFER = 64;
const CLOSE_VOLUNTARY = 0x02, CLOSE_NETWORK = 0x03, CLOSE_INVALID = 0x41, CLOSE_UNREACHABLE = 0x42,
  CLOSE_BLOCKED = 0x48, CLOSE_THROTTLED = 0x49;
const PORTS = new Set([80, 443]);
const BATCH_BYTES = 32 * 1024;
const BATCH_MS = 2;
/** clients move new streams to a fresh WebSocket after this many bytes */
const ROTATE_BYTES = 1 << 20;
const SESSION_SECONDS = 3600;
const MAX_STREAMS = 6;            // free plan: 6 simultaneous outbound connections
const MAX_BYTES = 512 * 2 ** 20;  // per session, both directions

// ----- policy -----
function hostAllowed(host: string, env: Env): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return false; // names only, no IP literals
  return env.ALLOWED_HOSTS.split(',').map((s) => s.trim().toLowerCase()).some((a) =>
    a.startsWith('*.') ? h.endsWith(a.slice(1)) || h === a.slice(2) : h === a);
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const ok = origin && env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin!, Vary: 'Origin', 'Access-Control-Allow-Headers': 'content-type' } : {};
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ----- sessions: "<expires>.<hmac>" -----
async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function newSession(env: Env): Promise<{ session: string; expires: number }> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const nonce = crypto.randomUUID();
  const body = `${expires}.${nonce}`;
  return { session: `${body}.${await hmac(env.SESSION_KEY, body)}`, expires };
}

async function checkSession(token: string | null, env: Env): Promise<boolean> {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const body = token.slice(0, i);
  const expires = Number(body.split('.')[0]);
  if (!(expires > Date.now() / 1000)) return false;
  return (await hmac(env.SESSION_KEY, body)) === token.slice(i + 1);
}

async function verifyTurnstile(token: string, ip: string | null, env: Env): Promise<boolean> {
  if (env.DEV_NO_TURNSTILE === '1') return true;
  if (!env.TURNSTILE_SECRET || !token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const j = (await r.json()) as { success?: boolean };
  return j.success === true;
}

// ----- WISP -----
function packet(type: number, id: number, payload: Uint8Array): Uint8Array {
  const b = new Uint8Array(5 + payload.length);
  b[0] = type;
  new DataView(b.buffer).setUint32(1, id, true);
  b.set(payload, 5);
  return b;
}
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };

interface RelayStream {
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  pending: Uint8Array[];
  socket: Socket | null;
  processed: number;
  closed: boolean;
}

function wispSession(ws: WebSocket, env: Env, ctx: ExecutionContext) {
  const streams = new Map<number, RelayStream>();
  const stats = { streams: 0, up: 0, down: 0, hosts: new Map<string, number>() };
  const send = (type: number, id: number, payload: Uint8Array) => {
    try { ws.send(packet(type, id, payload)); } catch { /* socket gone */ }
  };
  const closeStream = (id: number, reason: number, notify = true) => {
    const s = streams.get(id);
    if (!s) return;
    streams.delete(id);
    s.closed = true;
    s.socket?.close().catch(() => {});
    if (notify) send(CLOSE, id, new Uint8Array([reason]));
  };
  const overLimit = () => stats.up + stats.down > MAX_BYTES;

  async function open(id: number, host: string, port: number) {
    const s: RelayStream = { writer: null, pending: [], socket: null, processed: 0, closed: false };
    streams.set(id, s);
    if (!PORTS.has(port) || !hostAllowed(host, env)) return closeStream(id, CLOSE_BLOCKED);
    if (streams.size > MAX_STREAMS) return closeStream(id, CLOSE_THROTTLED);
    stats.streams++;
    let socket: Socket;
    try {
      socket = connect({ hostname: host, port }, { secureTransport: 'off', allowHalfOpen: false });
      await socket.opened;
    } catch {
      return closeStream(id, CLOSE_UNREACHABLE);
    }
    if (s.closed) { socket.close().catch(() => {}); return; }
    s.socket = socket;
    s.writer = socket.writable.getWriter();
    for (const d of s.pending.splice(0)) await write(id, s, d);
    // remote -> browser, batched: every WebSocket message costs CPU, and on
    // the free plan one session has a few ms of it in total.
    const reader = socket.readable.getReader();
    let reason = CLOSE_VOLUNTARY;
    let acc: Uint8Array[] = [];
    let accLen = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flushOut = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!accLen) return;
      const out = acc.length === 1 ? acc[0] : new Uint8Array(accLen);
      if (acc.length > 1) { let o = 0; for (const a of acc) { out.set(a, o); o += a.length; } }
      acc = []; accLen = 0;
      send(DATA, id, out);
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || s.closed) break;
        stats.down += value.length;
        stats.hosts.set(host, (stats.hosts.get(host) ?? 0) + value.length);
        acc.push(value);
        accLen += value.length;
        if (accLen >= BATCH_BYTES) flushOut();
        else if (!timer) timer = setTimeout(flushOut, BATCH_MS);
        if (overLimit()) { reason = CLOSE_THROTTLED; break; }
      }
    } catch {
      reason = CLOSE_NETWORK;
    }
    flushOut();
    closeStream(id, reason, !s.closed);
  }

  async function write(id: number, s: RelayStream, d: Uint8Array) {
    if (!s.writer) { s.pending.push(d); return; }
    try {
      await s.writer.write(d);
    } catch {
      return closeStream(id, CLOSE_NETWORK);
    }
    stats.up += d.length;
    if (++s.processed >= BUFFER / 2) {
      s.processed = 0;
      send(CONTINUE, id, u32(BUFFER));
    }
  }

  // Newer compatibility dates deliver binary frames as Blob unless asked;
  // decode in arrival order either way.
  (ws as unknown as { binaryType: string }).binaryType = 'arraybuffer';
  let chain: Promise<void> = Promise.resolve();
  ws.addEventListener('message', (e) => {
    const d = e.data as ArrayBuffer | Blob | string;
    if (typeof d === 'string') return;
    if (d instanceof ArrayBuffer) handle(new Uint8Array(d));
    else chain = chain.then(async () => handle(new Uint8Array(await d.arrayBuffer())));
  });
  function handle(p: Uint8Array) {
    if (p.length < 5) return;
    const id = new DataView(p.buffer, p.byteOffset).getUint32(1, true);
    const body = p.subarray(5);
    switch (p[0]) {
      case CONNECT: {
        if (body.length < 3 || body[0] !== 1 || streams.has(id)) { send(CLOSE, id, new Uint8Array([CLOSE_INVALID])); break; }
        const port = new DataView(body.buffer, body.byteOffset).getUint16(1, true);
        const host = new TextDecoder().decode(body.subarray(3));
        ctx.waitUntil(open(id, host, port));
        break;
      }
      case DATA: {
        const s = streams.get(id);
        if (s) ctx.waitUntil(write(id, s, body.slice()));
        break;
      }
      case CLOSE:
        closeStream(id, CLOSE_VOLUNTARY, false);
        break;
    }
  }
  ws.addEventListener('close', () => {
    for (const id of [...streams.keys()]) closeStream(id, CLOSE_VOLUNTARY, false);
    // host names and byte counts only
    console.log(JSON.stringify({ streams: stats.streams, up: stats.up, down: stats.down, hosts: Object.fromEntries(stats.hosts) }));
  });
  send(CONTINUE, 0, u32(BUFFER));
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST' } });
    if (!cors['Access-Control-Allow-Origin']) return json({ error: 'origin not allowed' }, 403, {});

    if (url.pathname === '/session' && req.method === 'POST') {
      const { turnstile } = (await req.json().catch(() => ({}))) as { turnstile?: string };
      if (!(await verifyTurnstile(turnstile ?? '', req.headers.get('CF-Connecting-IP'), env))) return json({ error: 'challenge failed' }, 403, cors);
      const allowed = env.ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean);
      return json({ ...(await newSession(env)), allowed, ports: [...PORTS], rotateBytes: ROTATE_BYTES }, 200, cors);
    }
    if (!(await checkSession(url.searchParams.get('session'), env))) return json({ error: 'no session' }, 401, cors);

    if (url.pathname === '/ping') {
      const host = url.searchParams.get('host') ?? '';
      if (!hostAllowed(host, env)) return json({ error: 'not allowed' }, 403, cors);
      const t0 = Date.now();
      try {
        const s = connect({ hostname: host, port: 443 });
        await s.opened;
        const rtt = Date.now() - t0;
        s.close().catch(() => {});
        return json({ rtt_ms: rtt }, 200, cors);
      } catch {
        return json({ error: 'unreachable' }, 403, cors);
      }
    }
    if (url.pathname === '/wisp') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426, cors);
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      wispSession(server, env, ctx);
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: 'not found' }, 404, cors);
  },
};
