// Fake-IP DNS: every name gets an address from 198.18.0.0/15 and we remember
// which name it stands for. Connections to that address are opened at the
// exit *by name*, so the exit (and the relay's allowlist) sees host names and
// TLS still runs end to end inside the guest.

import { ip4 } from './packet';

const BASE = ip4(198, 18, 0, 1);
const LAST = ip4(198, 19, 255, 254);

export class FakeDns {
  private byName = new Map<string, number>();
  private byIp = new Map<number, string>();
  private next = BASE;

  addressFor(name: string): number {
    const key = name.toLowerCase().replace(/\.$/, '');
    let ip = this.byName.get(key);
    if (ip === undefined) {
      ip = this.next;
      this.next = this.next >= LAST ? BASE : this.next + 1;
      const old = this.byIp.get(ip);
      if (old !== undefined) this.byName.delete(old);
      this.byName.set(key, ip);
      this.byIp.set(ip, key);
    }
    return ip;
  }

  nameFor(ip: number): string | undefined {
    return this.byIp.get(ip);
  }

  static isFake(ip: number) {
    return ip >= BASE - 1 && ip <= LAST + 1;
  }

  /** Answer a DNS query message; returns the response message. */
  answer(q: Uint8Array): Uint8Array | null {
    if (q.length < 12) return null;
    const v = new DataView(q.buffer, q.byteOffset, q.byteLength);
    const qdcount = v.getUint16(4);
    if ((q[2] & 0x80) !== 0 || qdcount !== 1) return null;
    // question name
    const labels: string[] = [];
    let i = 12;
    while (i < q.length && q[i] !== 0) {
      const len = q[i];
      if (len > 63 || i + 1 + len > q.length) return null;
      labels.push(new TextDecoder().decode(q.subarray(i + 1, i + 1 + len)));
      i += 1 + len;
    }
    i++;
    if (i + 4 > q.length) return null;
    const qtype = v.getUint16(i);
    const qclass = v.getUint16(i + 2);
    const qEnd = i + 4;
    const name = labels.join('.');

    const isA = qtype === 1 && qclass === 1 && name.length > 0;
    const out = new Uint8Array(qEnd + (isA ? 16 : 0));
    out.set(q.subarray(0, qEnd));
    const o = new DataView(out.buffer);
    // QR=1, opcode copied, AA=0, RD copied, RA=1, RCODE=0 (NOERROR; AAAA etc. get no answers)
    out[2] = 0x80 | (q[2] & 0x79);
    out[3] = 0x80;
    o.setUint16(6, isA ? 1 : 0); // ANCOUNT
    o.setUint16(8, 0);
    o.setUint16(10, 0);
    if (isA) {
      const a = qEnd;
      o.setUint16(a, 0xc00c); // pointer to the question name
      o.setUint16(a + 2, 1);
      o.setUint16(a + 4, 1);
      o.setUint32(a + 6, 60); // TTL
      o.setUint16(a + 10, 4);
      o.setUint32(a + 12, this.addressFor(name));
    }
    return out;
  }
}
