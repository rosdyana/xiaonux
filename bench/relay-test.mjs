// Checks for relay/ (Cloudflare Worker) with a raw WISP client.
// Usage: node relay-test.mjs [base URL, default http://127.0.0.1:8788]
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
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
