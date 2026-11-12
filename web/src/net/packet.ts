// Ethernet / IPv4 / UDP / TCP / ICMP helpers for the guest-side network.

export const ETH_IPV4 = 0x0800;
export const ETH_ARP = 0x0806;
export const IP_ICMP = 1;
export const IP_TCP = 6;
export const IP_UDP = 17;

export type Mac = Uint8Array; // 6 bytes

export const ip4 = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
export const ipToString = (ip: number) => `${ip >>> 24}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`;

/** Internet checksum over [data], optionally starting from a partial sum. */
export function checksum(data: Uint8Array, start = 0, len = data.length - start, initial = 0): number {
  let sum = initial;
  let i = start;
  const end = start + len;
  for (; i + 1 < end; i += 2) sum += (data[i] << 8) | data[i + 1];
  if (i < end) sum += data[i] << 8;
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

function pseudoHeaderSum(src: number, dst: number, proto: number, len: number): number {
  return (src >>> 16) + (src & 0xffff) + (dst >>> 16) + (dst & 0xffff) + proto + len;
}

export interface Ipv4 {
  src: number;
  dst: number;
  proto: number;
  payload: Uint8Array; // view into the frame
}

export function parseIpv4(frame: Uint8Array): Ipv4 | null {
  if (frame.length < 34) return null;
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const ihl = (frame[14] & 0x0f) * 4;
  if (frame[14] >> 4 !== 4 || ihl < 20) return null;
  const total = v.getUint16(16);
  // fragmented packets don't happen on this link (MTU 1500, DF set by Linux)
  return {
    src: v.getUint32(26),
    dst: v.getUint32(30),
    proto: frame[23],
    payload: frame.subarray(14 + ihl, 14 + Math.min(total, frame.length - 14)),
  };
}

let ipId = 1;

/** Build an Ethernet + IPv4 frame around [payload] (checksum for UDP/TCP filled in). */
export function buildIpv4(dstMac: Mac, srcMac: Mac, src: number, dst: number, proto: number, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(14 + 20 + payload.length);
  const v = new DataView(f.buffer);
  f.set(dstMac, 0);
  f.set(srcMac, 6);
  v.setUint16(12, ETH_IPV4);
  f[14] = 0x45;
  v.setUint16(16, 20 + payload.length);
  v.setUint16(18, ipId++ & 0xffff);
  v.setUint16(20, 0x4000); // DF
  f[22] = 64;
  f[23] = proto;
  v.setUint32(26, src);
  v.setUint32(30, dst);
  v.setUint16(24, checksum(f, 14, 20));
  f.set(payload, 34);
  if (proto === IP_TCP || proto === IP_UDP) {
    const off = 34 + (proto === IP_TCP ? 16 : 6);
    v.setUint16(off, 0);
    let c = checksum(f, 34, payload.length, pseudoHeaderSum(src, dst, proto, payload.length));
    if (proto === IP_UDP && c === 0) c = 0xffff;
    v.setUint16(off, c);
  }
  return f;
}

export function buildUdp(srcPort: number, dstPort: number, data: Uint8Array): Uint8Array {
  const u = new Uint8Array(8 + data.length);
  const v = new DataView(u.buffer);
  v.setUint16(0, srcPort);
  v.setUint16(2, dstPort);
  v.setUint16(4, u.length);
  u.set(data, 8);
  return u;
}

export const TCP_FIN = 0x01, TCP_SYN = 0x02, TCP_RST = 0x04, TCP_PSH = 0x08, TCP_ACK = 0x10;

export interface TcpSeg {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  window: number;
  mss: number | null;
  data: Uint8Array;
}

export function parseTcp(p: Uint8Array): TcpSeg | null {
  if (p.length < 20) return null;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const off = (p[12] >> 4) * 4;
  let mss: number | null = null;
  for (let i = 20; i < off; ) {
    const kind = p[i];
    if (kind === 0) break;
    if (kind === 1) { i++; continue; }
    const len = p[i + 1];
    if (kind === 2 && len === 4) mss = v.getUint16(i + 2);
    if (len < 2) break;
    i += len;
  }
  return {
    srcPort: v.getUint16(0),
    dstPort: v.getUint16(2),
    seq: v.getUint32(4),
    ack: v.getUint32(8),
    flags: p[13],
    window: v.getUint16(14),
    mss,
    data: p.subarray(off),
  };
}

export function buildTcp(srcPort: number, dstPort: number, seq: number, ack: number, flags: number,
  window: number, data: Uint8Array = new Uint8Array(0), mss?: number): Uint8Array {
  const optLen = mss ? 4 : 0;
  const t = new Uint8Array(20 + optLen + data.length);
  const v = new DataView(t.buffer);
  v.setUint16(0, srcPort);
  v.setUint16(2, dstPort);
  v.setUint32(4, seq >>> 0);
  v.setUint32(8, ack >>> 0);
  t[12] = ((20 + optLen) / 4) << 4;
  t[13] = flags;
  v.setUint16(14, Math.min(window, 0xffff));
  if (mss) {
    t[20] = 2; t[21] = 4;
    v.setUint16(22, mss);
  }
  t.set(data, 20 + optLen);
  return t;
}

/** seq arithmetic (mod 2^32) */
export const seqLt = (a: number, b: number) => ((a - b) | 0) < 0;
export const seqAdd = (a: number, n: number) => (a + n) >>> 0;
