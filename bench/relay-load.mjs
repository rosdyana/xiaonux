// Relay load test: N concurrent sessions, each with S parallel streams doing
// a small HTTP GET through WISP. Usage: node relay-load.mjs [N=100] [S=2] [base]
const N = Number(process.argv[2] ?? 100), S = Number(process.argv[3] ?? 2);
const BASE = process.argv[4] ?? 'http://127.0.0.1:8788';
const ORIGIN = 'http://localhost:5180';
const PATH = '/debian/dists/trixie/main/binary-riscv64/Release'; // 118 bytes

const pkt = (t, id, p) => { const b = new Uint8Array(5 + p.length); b[0] = t; new DataView(b.buffer).setUint32(1, id, true); b.set(p, 5); return b; };
const conn = (id, host, port) => { const h = new TextEncoder().encode(host); const p = new Uint8Array(3 + h.length); p[0] = 1; new DataView(p.buffer).setUint16(1, port, true); p.set(h, 3); return pkt(1, id, p); };

async function session(i) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/session`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  if (!r.ok) return { ok: false, err: `session ${r.status}` };
  const { session } = await r.json();
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/wisp?session=${session}`, { headers: { Origin: ORIGIN } });
  ws.binaryType = 'arraybuffer';
  const got = new Map(); const done = new Set();
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { ws.close(); resolve({ ok: false, err: 'timeout', streams: done.size }); }, 60000);
    ws.onerror = () => { clearTimeout(timer); resolve({ ok: false, err: 'ws error' }); };
    ws.onmessage = (e) => {
      const p = new Uint8Array(e.data); const id = new DataView(p.buffer).getUint32(1, true);
      if (p[0] === 3 && id === 0) {
        for (let s = 1; s <= S; s++) {
          ws.send(conn(s, 'deb.debian.org', 80));
          ws.send(pkt(2, s, new TextEncoder().encode(`GET ${PATH} HTTP/1.1\r\nHost: deb.debian.org\r\nConnection: close\r\n\r\n`)));
        }
      } else if (p[0] === 2) got.set(id, (got.get(id) ?? '') + new TextDecoder().decode(p.subarray(5)));
      else if (p[0] === 4) {
        done.add(id);
        if (done.size === S) {
          clearTimeout(timer); ws.close();
          const ok = [...got.values()].filter((t) => /^HTTP\/1\.1 200/.test(t)).length === S;
          resolve({ ok, ms: Date.now() - t0, err: ok ? undefined : 'bad response' });
        }
      }
    };
  });
}

const t0 = Date.now();
const res = await Promise.all(Array.from({ length: N }, (_, i) => session(i).catch((e) => ({ ok: false, err: String(e) }))));
const ok = res.filter((r) => r.ok);
const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
const errs = {};
for (const r of res) if (!r.ok) errs[r.err] = (errs[r.err] ?? 0) + 1;
console.log(JSON.stringify({ sessions: N, streamsEach: S, ok: ok.length, failed: N - ok.length, errors: errs,
  p50_ms: ms[Math.floor(ms.length / 2)], p95_ms: ms[Math.floor(ms.length * 0.95)], total_s: (Date.now() - t0) / 1000 }));
process.exit(ok.length === N ? 0 : 1);
