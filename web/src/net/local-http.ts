// Hosts served inside the worker, without any exit: a minimal HTTP/1.1 server
// for GET requests, backed by fetch() against our own static files. Used for
// the wheel index (wheels.xiaonux), so `pip install numpy` works offline.

import type { ExitStream } from './exit';

export type LocalFetch = (path: string) => Promise<Response>;

export function localHttpStream(fetchPath: LocalFetch): ExitStream {
  let buf = '';
  let busy = false;
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const s: ExitStream = {
    onData: () => {},
    onClose: () => {},
    close() {},
    write(d) {
      buf += dec.decode(d, { stream: true });
      void serve();
    },
  };
  async function serve() {
    if (busy) return;
    busy = true;
    try {
      let end;
      while ((end = buf.indexOf('\r\n\r\n')) >= 0) {
        const head = buf.slice(0, end);
        buf = buf.slice(end + 4);
        const [method, target] = head.split('\r\n')[0].split(' ');
        const keepAlive = !/\r\nconnection:\s*close/i.test(head);
        let status = 200, reason = 'OK', type = 'application/octet-stream', body = new Uint8Array(0);
        if (method !== 'GET' && method !== 'HEAD') {
          status = 405; reason = 'Method Not Allowed';
        } else {
          const r = await fetchPath(target.split('?')[0]);
          status = r.status; reason = r.statusText || (r.ok ? 'OK' : 'Error');
          type = r.headers.get('content-type') ?? type;
          if (method === 'GET') body = new Uint8Array(await r.arrayBuffer());
        }
        const hdr = `HTTP/1.1 ${status} ${reason}\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\n` +
          `Connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n\r\n`;
        s.onData(enc.encode(hdr));
        for (let o = 0; o < body.length; o += 64 * 1024) s.onData(body.subarray(o, o + 64 * 1024));
        if (!keepAlive) { s.onClose(null); return; }
      }
    } catch (e) {
      s.onClose(`local server error: ${e}`);
    } finally {
      busy = false;
    }
  }
  return s;
}
