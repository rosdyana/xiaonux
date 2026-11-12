// The guest's view of the network, run in the VM worker.
//   10.0.2.15  guest            10.0.2.2  gateway (us)       10.0.2.3  DNS (us)
// ARP and DNS are answered here; TCP is terminated here and each connection
// becomes a stream at the exit; ICMP echo is answered with the exit's RTT.
// The virtual link never drops frames (frames for the guest queue until it
// has RX buffers), so TCP needs no retransmission or congestion control.

import { FakeDns } from './dns';
import type { Exit, ExitStream } from './exit';
import { localHttpStream, type LocalFetch } from './local-http';
import {
  ETH_ARP, ETH_IPV4, IP_ICMP, IP_TCP, IP_UDP, buildIpv4, buildTcp, buildUdp, checksum, ip4, ipToString,
  parseIpv4, parseTcp, seqAdd, seqLt, TCP_ACK, TCP_FIN, TCP_PSH, TCP_RST, TCP_SYN, type Mac, type TcpSeg,
} from './packet';

const GATEWAY = ip4(10, 0, 2, 2);
const DNS_IP = ip4(10, 0, 2, 3);
const OUR_MAC: Mac = new Uint8Array([0x52, 0x55, 0x0a, 0x00, 0x02, 0x02]);
const MSS = 1460;
const OUR_WINDOW = 65535;

export interface NetEvents {
  /** a connection or ping was refused by the exit (host shown to the user) */
  blocked(host: string, reason: string): void;
  /** counters for the status line */
  activity(stats: NetStats): void;
}

export interface NetStats {
  connections: number;
  open: number;
  bytesIn: number;
  bytesOut: number;
}

type State = 'syn-rcvd' | 'established' | 'closing' | 'closed';

interface Conn {
  key: string;
  guestIp: number;
  guestPort: number;
  remoteIp: number;
  remotePort: number;
  host: string;
  state: State;
  // us -> guest
  sndNxt: number;   // next seq we send
  sndUna: number;   // oldest unacked
  guestWnd: number; // guest's advertised window
  guestMss: number;
  outQ: Uint8Array[]; // data from the exit not yet sent to the guest
  gotData: boolean;   // the exit has sent anything
  finPending: boolean; // exit closed: send FIN after outQ drains
  finSent: boolean;
  // guest -> us
  rcvNxt: number;
  stream: ExitStream | null;
}

export class NetStack {
  private guestMac: Mac | null = null;
  private conns = new Map<string, Conn>();
  readonly dns = new FakeDns();
  /** host name -> handler for HTTP served inside the worker (port 80) */
  readonly localHosts = new Map<string, LocalFetch>();
  stats: NetStats = { connections: 0, open: 0, bytesIn: 0, bytesOut: 0 };

  constructor(
    private sendFrame: (frame: Uint8Array) => void,
    public exit: Exit,
    private events: NetEvents,
  ) {}

  /** Host name (or dotted IP) a guest address stands for. */
  private hostFor(ip: number): string {
    return this.dns.nameFor(ip) ?? ipToString(ip);
  }

  handleFrame(f: Uint8Array) {
    if (f.length < 14) return;
    const type = (f[12] << 8) | f[13];
    this.guestMac ??= f.slice(6, 12);
    if (type === ETH_ARP) return this.arp(f);
    if (type !== ETH_IPV4) return; // IPv6 etc.: ignored, the guest falls back to IPv4
    const ip = parseIpv4(f);
    if (!ip) return;
    if (ip.proto === IP_UDP) return this.udp(ip.src, ip.dst, ip.payload);
    if (ip.proto === IP_TCP) return this.tcp(ip.src, ip.dst, ip.payload);
    if (ip.proto === IP_ICMP) return this.icmp(ip.src, ip.dst, ip.payload);
  }

  // ----- ARP: we are every 10.0.2.x except the guest -----
  private arp(f: Uint8Array) {
    const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
    if (f.length < 42 || v.getUint16(20) !== 1) return; // requests only
    const target = v.getUint32(38);
    if (target >>> 8 !== ip4(10, 0, 2, 0) >>> 8 || target === v.getUint32(28)) return;
    const r = new Uint8Array(42);
    const rv = new DataView(r.buffer);
    r.set(f.subarray(6, 12), 0);
    r.set(OUR_MAC, 6);
    rv.setUint16(12, ETH_ARP);
    rv.setUint16(14, 1);
    rv.setUint16(16, ETH_IPV4);
    r[18] = 6; r[19] = 4;
    rv.setUint16(20, 2); // reply
    r.set(OUR_MAC, 22);
    rv.setUint32(28, target);
    r.set(f.subarray(22, 28), 32); // sender MAC -> target MAC
    rv.setUint32(38, v.getUint32(28));
    this.sendFrame(r);
  }

  private sendIp(src: number, dst: number, proto: number, payload: Uint8Array) {
    if (!this.guestMac) return;
    this.sendFrame(buildIpv4(this.guestMac, OUR_MAC, src, dst, proto, payload));
  }

  // ----- UDP: DNS only -----
  private udp(src: number, dst: number, p: Uint8Array) {
    if (p.length < 8) return;
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const sport = v.getUint16(0), dport = v.getUint16(2);
    if (dst !== DNS_IP || dport !== 53) return;
    const reply = this.dns.answer(p.subarray(8));
    if (reply) this.sendIp(DNS_IP, src, IP_UDP, buildUdp(53, sport, reply));
  }

  // ----- ICMP echo: answered after the exit measured a real RTT -----
  private icmp(src: number, dst: number, p: Uint8Array) {
    if (p.length < 8 || p[0] !== 8) return; // echo request only
    const req = p.slice();
    const host = this.hostFor(dst);
    if (dst === GATEWAY || dst === DNS_IP) {
      this.sendIp(dst, src, IP_ICMP, echoReply(req));
      return;
    }
    this.exit.ping(host).then((rtt) => {
      if (rtt === null) {
        this.events.blocked(host, 'ping refused');
        this.sendIp(GATEWAY, src, IP_ICMP, unreachable(req, src, dst));
      } else {
        this.sendIp(dst, src, IP_ICMP, echoReply(req));
      }
    });
  }

  // ----- TCP -----
  private tcp(src: number, dst: number, p: Uint8Array) {
    const seg = parseTcp(p);
    if (!seg) return;
    const key = `${seg.srcPort}>${dst}:${seg.dstPort}`;
    let c = this.conns.get(key);

    if (seg.flags & TCP_RST) {
      if (c) this.drop(c);
      return;
    }
    if (!c) {
      if ((seg.flags & (TCP_SYN | TCP_ACK)) !== TCP_SYN) {
        // stray segment for a connection we don't know: reset it
        if (!(seg.flags & TCP_RST)) this.rawRst(src, dst, seg);
        return;
      }
      const host = this.hostFor(dst);
      const isLocal = this.localHosts.has(host) && seg.dstPort === 80;
      if (!isLocal && this.exit.allows && !this.exit.allows(host, seg.dstPort)) {
        this.events.blocked(host, `not on the relay's list (port ${seg.dstPort})`);
        this.rawRst(src, dst, seg); // guest sees "connection refused"
        return;
      }
      c = this.open(key, src, dst, seg);
      return;
    }
    if (seg.flags & TCP_SYN) {
      // retransmitted SYN: repeat our SYN-ACK
      if (c.state === 'syn-rcvd') this.send(c, TCP_SYN | TCP_ACK, new Uint8Array(0), seqAdd(c.sndNxt, -1), MSS);
      return;
    }
    if (seg.flags & TCP_ACK) {
      if (seqLt(c.sndUna, seg.ack) && !seqLt(c.sndNxt, seg.ack)) c.sndUna = seg.ack;
      c.guestWnd = seg.window;
      if (c.state === 'syn-rcvd') c.state = 'established';
    }
    // data from the guest (the link is in-order; anything else is a duplicate)
    if (seg.data.length) {
      if (seg.seq === c.rcvNxt) {
        c.rcvNxt = seqAdd(c.rcvNxt, seg.data.length);
        this.stats.bytesOut += seg.data.length;
        c.stream?.write(seg.data.slice());
      }
      this.send(c, TCP_ACK);
    }
    if (seg.flags & TCP_FIN && seqAdd(seg.seq, seg.data.length) === c.rcvNxt) {
      c.rcvNxt = seqAdd(c.rcvNxt, 1);
      // WISP has no half-close: the guest is done sending, so close the
      // remote side once our queued data is out.
      c.stream?.close();
      c.stream = null;
      c.finPending = true;
      this.send(c, TCP_ACK);
    }
    this.pump(c);
    if (c.finSent && c.sndUna === c.sndNxt && c.finPending && c.stream === null) this.drop(c);
  }

  private open(key: string, src: number, dst: number, seg: TcpSeg): Conn {
    const host = this.hostFor(dst);
    const iss = (Math.random() * 0xffffffff) >>> 0;
    const c: Conn = {
      key, guestIp: src, guestPort: seg.srcPort, remoteIp: dst, remotePort: seg.dstPort, host,
      state: 'syn-rcvd', sndNxt: seqAdd(iss, 1), sndUna: iss, guestWnd: seg.window,
      guestMss: Math.min(seg.mss ?? 536, MSS), outQ: [], gotData: false, finPending: false, finSent: false,
      rcvNxt: seqAdd(seg.seq, 1), stream: null,
    };
    this.conns.set(key, c);
    this.stats.connections++;
    this.stats.open++;
    const local = seg.dstPort === 80 ? this.localHosts.get(host) : undefined;
    const stream = local ? localHttpStream(local) : this.exit.connect(host, seg.dstPort);
    c.stream = stream;
    stream.onData = (d) => {
      this.stats.bytesIn += d.length;
      c.gotData = true;
      c.outQ.push(d);
      this.pump(c);
    };
    stream.onClose = (reason) => {
      c.stream = null;
      if (reason && !c.gotData) {
        // the exit refused or failed before any data: reset the connection
        this.events.blocked(host, reason);
        this.send(c, TCP_RST | TCP_ACK);
        this.drop(c);
        return;
      }
      c.finPending = true;
      this.pump(c);
    };
    // Accept right away; if the exit refuses, the guest sees a reset.
    this.send(c, TCP_SYN | TCP_ACK, new Uint8Array(0), iss, MSS);
    this.events.activity(this.stats);
    return c;
  }

  /** Send queued exit data within the guest's window, then FIN if due. */
  private pump(c: Conn) {
    if (c.state === 'closed') return;
    while (c.outQ.length) {
      const inFlight = (c.sndNxt - c.sndUna) >>> 0;
      const room = c.guestWnd - inFlight;
      if (room <= 0) return;
      const head = c.outQ[0];
      const n = Math.min(head.length, c.guestMss, room);
      const chunk = head.subarray(0, n);
      if (n === head.length) c.outQ.shift();
      else c.outQ[0] = head.subarray(n);
      this.send(c, TCP_ACK | TCP_PSH, chunk);
      c.sndNxt = seqAdd(c.sndNxt, n);
    }
    if (c.finPending && !c.finSent) {
      this.send(c, TCP_FIN | TCP_ACK);
      c.sndNxt = seqAdd(c.sndNxt, 1);
      c.finSent = true;
      c.state = 'closing';
    }
  }

  private send(c: Conn, flags: number, data: Uint8Array = new Uint8Array(0), seq = c.sndNxt, mss?: number) {
    this.sendIp(c.remoteIp, c.guestIp, IP_TCP,
      buildTcp(c.remotePort, c.guestPort, seq, c.rcvNxt, flags, OUR_WINDOW, data, mss));
  }

  private rawRst(src: number, dst: number, seg: TcpSeg) {
    const ack = seqAdd(seg.seq, seg.data.length + (seg.flags & TCP_SYN ? 1 : 0) + (seg.flags & TCP_FIN ? 1 : 0));
    this.sendIp(dst, src, IP_TCP, buildTcp(seg.dstPort, seg.srcPort, seg.flags & TCP_ACK ? seg.ack : 0, ack,
      TCP_RST | TCP_ACK, 0));
  }

  private drop(c: Conn) {
    if (c.state === 'closed') return;
    c.state = 'closed';
    c.stream?.close();
    c.stream = null;
    this.conns.delete(c.key);
    this.stats.open--;
    this.events.activity(this.stats);
  }

  /** Close everything (network switched or turned off). */
  resetAll() {
    for (const c of [...this.conns.values()]) {
      this.send(c, TCP_RST | TCP_ACK);
      this.drop(c);
    }
  }
}

function echoReply(req: Uint8Array): Uint8Array {
  const r = req.slice();
  r[0] = 0; // echo reply
  r[2] = r[3] = 0;
  const c = checksum(r);
  r[2] = c >> 8; r[3] = c & 0xff;
  return r;
}

/** ICMP destination unreachable (communication administratively prohibited). */
function unreachable(req: Uint8Array, guest: number, dst: number): Uint8Array {
  // original IP header (20 bytes) + first 8 bytes of the ICMP request
  const orig = buildIpv4(new Uint8Array(6), new Uint8Array(6), guest, dst, IP_ICMP, req.subarray(0, 8)).subarray(14);
  const r = new Uint8Array(8 + orig.length);
  r[0] = 3; r[1] = 13;
  r.set(orig, 8);
  const c = checksum(r);
  r[2] = c >> 8; r[3] = c & 0xff;
  return r;
}
