// End-to-end checks for helper/ (xiaonux-net) with a raw WISP client.
// Usage: node helper-test.mjs [path/to/xiaonux-net]
import { spawn } from 'node:child_process';

const bin = process.argv[2] ?? '../helper/target/release/xiaonux-net';
const PORT = 18787, TOKEN = 'testtoken', ORIGIN = 'http://localhost:5180';
const helper = spawn(bin, ['--port', String(PORT), '--token', TOKEN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => helper.stdout.once('data', r));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

function open(token = TOKEN, origin = ORIGIN) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/wisp?token=${token}`, { headers: { Origin: origin } });
    ws.binaryType = 'arraybuffer';
    const inbox = [];
    let waiter = null;
    ws.onmessage = (e) => { inbox.push(new Uint8Array(e.data)); waiter?.(); };
    ws.onopen = () => resolve({ ws, next: async (ms = 8000) => {
      const end = Date.now() + ms;
      while (!inbox.length) {
        if (Date.now() > end) return null;
        await new Promise((r) => { waiter = r; setTimeout(r, 100); });
      }
      return inbox.shift();
    } });
    ws.onerror = () => resolve(null);
  });
}
const pkt = (type, id, payload) => {
  const b = new Uint8Array(5 + payload.length); b[0] = type;
  new DataView(b.buffer).setUint32(1, id, true); b.set(payload, 5); return b;
};
const connectPkt = (id, host, port) => {
  const h = new TextEncoder().encode(host); const p = new Uint8Array(3 + h.length);
  p[0] = 1; new DataView(p.buffer).setUint16(1, port, true); p.set(h, 3); return pkt(1, id, p);
};

// 1. HTTP through the helper
{
  const c = await open();
  const first = await c.next();
  check('initial CONTINUE', first && first[0] === 3 && new DataView(first.buffer).getUint32(5, true) > 0);
  c.ws.send(connectPkt(1, 'example.com', 80));
  c.ws.send(pkt(2, 1, new TextEncoder().encode('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n')));
  let text = '', closed = false;
  for (let i = 0; i < 50 && !closed; i++) {
    const m = await c.next(); if (!m) break;
    if (m[0] === 2) text += new TextDecoder().decode(m.subarray(5));
    if (m[0] === 4) closed = true;
  }
  check('HTTP GET example.com via WISP', /^HTTP\/1\.1 200/.test(text), text.split('\r\n')[0]);
  // 2. LAN / loopback / port policy
  for (const [id, host, port, label] of [[2, '127.0.0.1', 80, 'loopback'], [3, '192.168.1.1', 80, 'LAN'], [4, 'example.com', 22, 'port 22']]) {
    c.ws.send(connectPkt(id, host, port));
    let m; do { m = await c.next(); } while (m && !(m[0] === 4 && new DataView(m.buffer).getUint32(1, true) === id));
    check(`${label} refused`, m && m[5] === 0x48, m ? `reason 0x${m[5].toString(16)}` : 'no close');
  }
  c.ws.close();
}
// 3. bad token / bad origin
check('bad token refused', (await open('nope')) === null);
check('foreign origin refused', (await open(TOKEN, 'https://evil.example')) === null);
// 4. ping
{
  const r = await fetch(`http://127.0.0.1:${PORT}/ping?token=${TOKEN}&host=example.com`, { headers: { Origin: ORIGIN } });
  const j = await r.json();
  check('ping example.com', r.ok && j.rtt_ms > 0, `${j.rtt_ms} ms`);
  const r2 = await fetch(`http://127.0.0.1:${PORT}/ping?token=${TOKEN}&host=10.0.0.1`, { headers: { Origin: ORIGIN } });
  check('ping LAN refused', r2.status === 403);
}
helper.kill();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
