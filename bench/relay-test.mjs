// Checks for relay/ (Cloudflare Worker) with a raw WISP client.
// Usage: node relay-test.mjs [base URL, default http://127.0.0.1:8788]
//
// Optional session-limit checks (the relay must run with DEV_NO_TURNSTILE=1 and
// matching overrides in relay/.dev.vars):
//   EXPECT_OPENS_CAP=N   MAX_OPENS_OVERRIDE=N: the (N+1)th WebSocket on one
//                        session is refused; a new session is unaffected
//   EXPECT_BYTES_CAP=N   MAX_BYTES_OVERRIDE=N: after more than N bytes on one
//                        session, later sockets / streams are throttled
// With neither set only the basic checks run.
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8788';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5180';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

const sess = await fetch(`${BASE}/session`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ turnstile: process.env.TURNSTILE ?? '' }) });
const { session } = await sess.json();
check('session issued', sess.ok && !!session);
check('foreign origin refused', (await fetch(`${BASE}/ping?session=${session}&host=pypi.org`, { headers: { Origin: 'https://evil.example' } })).status === 403);
check('no session refused', (await fetch(`${BASE}/ping?host=pypi.org`, { headers: { Origin: ORIGIN } })).status === 401);
const ping = await fetch(`${BASE}/ping?session=${session}&host=pypi.org`, { headers: { Origin: ORIGIN } });
check('ping pypi.org', ping.ok, JSON.stringify(await ping.json()));
check('ping example.com refused', (await fetch(`${BASE}/ping?session=${session}&host=example.com`, { headers: { Origin: ORIGIN } })).status === 403);

const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/wisp?session=${session}`, { headers: { Origin: ORIGIN } });
ws.binaryType = 'arraybuffer';
const inbox = []; let wake = null;
ws.onmessage = (e) => { inbox.push(new Uint8Array(e.data)); wake?.(); };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const next = async (ms = 10000) => { const end = Date.now() + ms; while (!inbox.length) { if (Date.now() > end) return null; await new Promise((r) => { wake = r; setTimeout(r, 100); }); } return inbox.shift(); };
const pkt = (t, id, p) => { const b = new Uint8Array(5 + p.length); b[0] = t; new DataView(b.buffer).setUint32(1, id, true); b.set(p, 5); return b; };
const conn = (id, host, port) => { const h = new TextEncoder().encode(host); const p = new Uint8Array(3 + h.length); p[0] = 1; new DataView(p.buffer).setUint16(1, port, true); p.set(h, 3); return pkt(1, id, p); };
const first = await next();
check('initial CONTINUE', first?.[0] === 3);
ws.send(conn(1, 'deb.debian.org', 80));
ws.send(pkt(2, 1, new TextEncoder().encode('GET /debian/dists/trixie/Release HTTP/1.1\r\nHost: deb.debian.org\r\nConnection: close\r\n\r\n')));
let text = '', bytes = 0;
for (;;) { const m = await next(); if (!m) break; if (m[0] === 2 && new DataView(m.buffer).getUint32(1, true) === 1) { bytes += m.length - 5; if (text.length < 200) text += new TextDecoder().decode(m.subarray(5)); } if (m[0] === 4) break; }
check('HTTP via relay (deb.debian.org)', /^HTTP\/1\.1 200/.test(text), `${text.split('\r\n')[0]} ${bytes} B`);
for (const [id, host, port, label] of [[2, 'example.com', 80, 'example.com'], [3, 'pypi.org', 22, 'port 22'], [4, '1.1.1.1', 443, 'IP literal']]) {
  ws.send(conn(id, host, port));
  let m; do { m = await next(); } while (m && !(m[0] === 4 && new DataView(m.buffer).getUint32(1, true) === id));
  check(`${label} blocked`, m?.[5] === 0x48, m ? `0x${m[5].toString(16)}` : 'no close');
}
ws.close();

// ----- session limits (optional) -----
const EXPECT_OPENS_CAP = Number(process.env.EXPECT_OPENS_CAP ?? 0);
const EXPECT_BYTES_CAP = Number(process.env.EXPECT_BYTES_CAP ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newSession = async () => (await (await fetch(`${BASE}/session`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ turnstile: process.env.TURNSTILE ?? '' }) })).json()).session;

// WebSocket upgrade by hand so the HTTP status of a refusal is visible.
const upgrade = (session) => new Promise((resolve, reject) => {
  const u = new URL(`${BASE}/wisp?session=${session}`);
  const req = (u.protocol === 'https:' ? https : http).request({
    hostname: u.hostname, port: u.port, path: u.pathname + u.search,
    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), Origin: ORIGIN },
  });
  req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }));
  req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, socket: null }); });
  req.on('error', reject);
  req.end();
});

// A WISP client on a fresh WebSocket; null when the relay refuses the socket.
const wisp = (session) => new Promise((resolve) => {
  const w = new WebSocket(`${BASE.replace(/^http/, 'ws')}/wisp?session=${session}`, { headers: { Origin: ORIGIN } });
  w.binaryType = 'arraybuffer';
  const box = []; let wakeUp = null; let closed = false;
  w.onmessage = (e) => { box.push(new Uint8Array(e.data)); wakeUp?.(); };
  w.onclose = () => { closed = true; wakeUp?.(); };
  w.onerror = () => resolve(null);
  w.onopen = () => resolve({
    ws: w,
    isClosed: () => closed,
    next: async (ms = 10000) => { const end = Date.now() + ms; while (!box.length) { if (closed || Date.now() > end) return null; await new Promise((r) => { wakeUp = r; setTimeout(r, 100); }); } return box.shift(); },
  });
});
// Open a socket and wait for the initial CONTINUE; null if refused or closed at once.
const wispReady = async (session) => { const c = await wisp(session); if (!c) return null; const m = await c.next(3000); return m?.[0] === 3 ? c : (c.ws.close(), null); };
// One HTTP GET on stream `id`; reason is the WISP close reason (0x49 = throttled).
const getRelease = async (c, id) => {
  c.ws.send(conn(id, 'deb.debian.org', 80));
  c.ws.send(pkt(2, id, new TextEncoder().encode('GET /debian/dists/trixie/Release HTTP/1.1\r\nHost: deb.debian.org\r\nConnection: close\r\n\r\n')));
  let n = 0;
  for (;;) {
    const m = await c.next();
    if (!m) return { bytes: n, reason: -1 };
    if (new DataView(m.buffer).getUint32(1, true) !== id) continue;
    if (m[0] === 2) n += m.length - 5;
    if (m[0] === 4) return { bytes: n, reason: m[5] };
  }
};

if (EXPECT_OPENS_CAP) {
  const N = EXPECT_OPENS_CAP;
  const s = await newSession();
  const held = [];
  for (let i = 0; i < N; i++) { const r = await upgrade(s); if (r.status !== 101) break; held.push(r.socket); }
  check(`opens cap: first ${N} sockets on one session accepted`, held.length === N, `accepted ${held.length}`);
  const over = await upgrade(s);
  let refused = over.status !== 101, how = `HTTP ${over.status}`;
  if (!refused) { // accepted: only fine if the relay closes it straight away
    refused = await Promise.race([new Promise((r) => over.socket.once('close', () => r(true))), sleep(1500).then(() => false)]);
    how = refused ? 'accepted then closed' : 'accepted and stayed open';
    over.socket.destroy();
  }
  check(`opens cap: socket ${N + 1} on the same session refused`, refused, how);
  const fresh = await newSession();
  const f = await upgrade(fresh);
  check('opens cap: a new session is not affected', f.status === 101, `HTTP ${f.status}`);
  f.socket?.destroy();
  for (const k of held) k.destroy();
}

if (EXPECT_BYTES_CAP) {
  const CAP = EXPECT_BYTES_CAP;
  // (1) new WebSocket per GET, as the web client does: each socket moves far less
  //     than CAP, so only a per-session total can stop it
  {
    const s = await newSession();
    let total = 0, outcome = null, i = 0;
    for (i = 1; i <= 25 && !outcome; i++) {
      const c = await wispReady(s);
      if (!c) { outcome = `socket ${i} refused`; break; }
      const r = await getRelease(c, 1);
      total += r.bytes;
      if (r.reason === 0x49) outcome = `stream throttled on socket ${i}`;
      c.ws.close();
      await sleep(300); // let the socket's final byte report land
    }
    check('bytes cap: sockets of one session stop once the session total passes the cap', !!outcome && total >= CAP * 0.5, `${outcome ?? 'never throttled'}, ${total} B received (cap ${CAP})`);
    // a different session must be unaffected
    const c = await wispReady(await newSession());
    const r = c && await getRelease(c, 1);
    check('bytes cap: a new session is not affected', !!r && r.reason !== 0x49 && r.bytes > 0, r ? `${r.bytes} B, reason 0x${r.reason.toString(16)}` : 'socket refused');
    c?.ws.close();
  }
  // (2) many GETs over one socket: the stream gets CLOSE 0x49 once the cap passes
  {
    const c = await wispReady(await newSession());
    let total = 0, outcome = null;
    for (let id = 1; c && id <= 25 && !outcome; id++) {
      const r = await getRelease(c, id);
      total += r.bytes;
      if (r.reason === 0x49) outcome = `stream ${id} closed 0x49`;
      else if (r.reason === -1) outcome = `no answer on stream ${id}`;
      await sleep(200);
    }
    check('bytes cap: streams on one socket are throttled (0x49)', outcome?.endsWith('0x49') && total >= CAP * 0.5, `${outcome ?? 'never throttled'}, ${total} B received (cap ${CAP})`);
    c?.ws.close();
  }
  // (3) uploads count: push a big request body, expect CLOSE 0x49 on that stream
  {
    const c = await wispReady(await newSession());
    c.ws.send(conn(1, 'deb.debian.org', 80));
    c.ws.send(pkt(2, 1, new TextEncoder().encode('POST /upload HTTP/1.1\r\nHost: deb.debian.org\r\nContent-Length: 1000000000\r\nConnection: close\r\n\r\n')));
    const chunk = new Uint8Array(16 * 1024).fill(0x41);
    let sent = 0, reason = null;
    for (let i = 0; i < Math.ceil(CAP / chunk.length) * 3 + 10 && reason === null && !c.isClosed(); i++) {
      c.ws.send(pkt(2, 1, chunk)); sent += chunk.length;
      if (i % 4 === 3) { // drain incoming packets
        for (;;) { const m = await c.next(20); if (!m) break; if (m[0] === 4 && new DataView(m.buffer).getUint32(1, true) === 1) { reason = m[5]; break; } }
      }
    }
    for (let k = 0; reason === null && k < 20; k++) { const m = await c.next(250); if (m?.[0] === 4 && new DataView(m.buffer).getUint32(1, true) === 1) reason = m[5]; }
    check('bytes cap: uploads count toward the cap (0x49)', reason === 0x49, `close reason ${reason === null ? 'none' : '0x' + reason.toString(16)} after ${sent} B sent (cap ${CAP})`);
    c.ws.close();
  }
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
