import test from 'node:test';
import assert from 'node:assert/strict';
import {
  X6,
  X6Bridge,
  changedBlocks,
  decodeB64,
  encodeB64,
  parseShimLine,
  type XvEvents,
  type XvHandle,
  type XvStart,
} from './xv6-bridge.ts';

const b64 = (bytes: number[]) => encodeB64(Uint8Array.from(bytes));

test('base64 round-trips bytes above 0x7f', () => {
  const bytes = Uint8Array.from([0, 1, 0x7f, 0x80, 0xfe, 0xff, 0x2b, 0x2f]);
  assert.deepEqual(decodeB64(encodeB64(bytes)), bytes);
  assert.deepEqual(decodeB64(''), new Uint8Array(0));
  assert.equal(decodeB64('abc'), null); // length not a multiple of 4
  assert.equal(decodeB64('ab$d'), null);
  assert.equal(decodeB64('a==='), null);
});

test('parseShimLine accepts the protocol lines', () => {
  assert.deepEqual(parseShimLine('x6 begin 128 1 0 1234 2048000'), {
    op: 'begin', ramMb: 128, gdb: true, wait: false, kernelLen: 1234, fsLen: 2048000, sync: false,
  });
  assert.deepEqual(parseShimLine(`x6 kb ${b64([1, 2, 3])}`), { op: 'kb', data: Uint8Array.from([1, 2, 3]) });
  assert.deepEqual(parseShimLine('x6 run'), { op: 'run' });
  assert.deepEqual(parseShimLine('x6 stop'), { op: 'stop' });
  assert.deepEqual(parseShimLine('x6 ack'), { op: 'ack' });
});

test('parseShimLine reads the optional sync field of begin (absent = 0)', () => {
  const on = parseShimLine('x6 begin 128 0 0 10 20 1');
  assert.deepEqual(on, { op: 'begin', ramMb: 128, gdb: false, wait: false, kernelLen: 10, fsLen: 20, sync: true });
  const off = parseShimLine('x6 begin 128 0 0 10 20 0');
  assert.ok(off && off.op === 'begin' && off.sync === false);
  const old = parseShimLine('x6 begin 128 0 0 10 20');
  assert.ok(old && old.op === 'begin' && old.sync === false, 'an old shim sends five fields');
});

test('parseShimLine drops lines that do not fit the protocol', () => {
  const bad = [
    'begin 128 0 0 1 1', // no prefix
    'x6 begin 128 0 0 1', // too few fields
    'x6 begin 128 0 0 1 1 2', // sync must be 0/1
    'x6 begin 128 0 0 1 1 1 1', // too many fields
    'x6 begin 128 0 0 1 1 x', // sync must be 0/1
    'x6 ack now', // ack takes no argument
    'x6 begin 128 2 0 1 1', // gdb must be 0/1
    'x6 begin -1 0 0 1 1',
    'x6 begin 128 0 0 1.5 1',
    'x6 kb !!!!',
    'x6 kb QUI', // bad length
    'x6 run now', // run takes no argument
    'x6 stop now',
    'x6 nope',
    'x6 ',
    `x6 kb ${encodeB64(new Uint8Array(X6.CHUNK + 1))}`, // over one chunk
    `x6 in ${'A'.repeat(X6.MAX_LINE)}`, // over the line limit
  ];
  for (const line of bad) assert.equal(parseShimLine(line), null, line);
});

test('changedBlocks reports changed 4 KB blocks, including a short last block', () => {
  const orig = new Uint8Array(4096 * 2 + 100).fill(7);
  assert.deepEqual(changedBlocks(orig, orig.slice()), []);
  const cur = orig.slice();
  cur[5] = 8; // block 0
  cur[4096 * 2 + 99] = 9; // the short last block
  const blocks = changedBlocks(orig, cur);
  assert.ok(blocks);
  assert.deepEqual(blocks.map((b) => b.offset), [0, 8192]);
  assert.equal(blocks[0].data.length, 4096);
  assert.equal(blocks[1].data.length, 100);
  assert.equal(blocks[0].data[5], 8);
  assert.equal(changedBlocks(orig, new Uint8Array(3)), null, 'a size change is an error');
});

interface Fake {
  lines: string[];
  starts: XvStart[];
  events: XvEvents[];
  handles: { input: Uint8Array[]; gdb: Uint8Array[]; stops: number; terminated: number; resumes: number }[];
  throwOnStart: boolean;
  bridge: X6Bridge;
}

function fake(opts: { throwOnStart?: boolean } = {}): Fake {
  const f: Fake = { lines: [], starts: [], events: [], handles: [], throwOnStart: !!opts.throwOnStart, bridge: null as unknown as X6Bridge };
  f.bridge = new X6Bridge({
    send: (line) => f.lines.push(line),
    start: (o, ev): XvHandle => {
      if (f.throwOnStart) throw new Error('no worker');
      f.starts.push(o);
      f.events.push(ev);
      const rec = { input: [] as Uint8Array[], gdb: [] as Uint8Array[], stops: 0, terminated: 0, resumes: 0 };
      f.handles.push(rec);
      return {
        input: (d) => rec.input.push(d),
        gdbIn: (d) => rec.gdb.push(d),
        resume: () => rec.resumes++,
        stop: () => rec.stops++,
        terminate: () => rec.terminated++,
      };
    },
  });
  return f;
}

const kernelBytes = Uint8Array.from([1, 2, 3, 4, 5]);
const fsBytes = new Uint8Array(4096 * 2 + 10).map((_, i) => i % 251);

function begin(f: Fake, { gdb = 0, wait = 0 } = {}) {
  f.bridge.onLine(`x6 begin 128 ${gdb} ${wait} ${kernelBytes.length} ${fsBytes.length}`);
}

function sendAll(f: Fake) {
  f.bridge.onLine(`x6 kb ${encodeB64(kernelBytes)}`);
  f.bridge.onLine(`x6 fb ${encodeB64(fsBytes.subarray(0, 4096))}`);
  f.bridge.onLine(`x6 fb ${encodeB64(fsBytes.subarray(4096))}`);
  f.bridge.onLine('x6 run');
}

test('begin, chunks, run: starts the machine with copies, then ready', () => {
  const f = fake();
  begin(f, { gdb: 1, wait: 1 });
  assert.equal(f.starts.length, 0);
  sendAll(f);
  assert.equal(f.starts.length, 1);
  const s = f.starts[0];
  assert.deepEqual(s.kernel, kernelBytes);
  assert.deepEqual(s.fs, fsBytes);
  assert.equal(s.gdb, true);
  assert.equal(s.wait, true);
  f.events[0].ready();
  assert.deepEqual(f.lines, ['x6 ready']);
});

test('console and gdb output go back as x6 out / x6 go, split at 48 KB', () => {
  const f = fake();
  begin(f);
  sendAll(f);
  f.events[0].ready();
  f.lines.length = 0;
  f.events[0].console(Uint8Array.from([0x41, 0xc3, 0x80]));
  f.events[0].gdb(new Uint8Array(X6.CHUNK + 5));
  assert.deepEqual(f.lines[0], `x6 out ${encodeB64(Uint8Array.from([0x41, 0xc3, 0x80]))}`);
  assert.equal(f.lines.filter((l) => l.startsWith('x6 go ')).length, 2);
  for (const l of f.lines) {
    const m = parseShimLine(l.replace(/^x6 go /, 'x6 gi '));
    if (l.startsWith('x6 go ')) assert.ok(m && m.op === 'gi' && m.data.length <= X6.CHUNK);
  }
});

test('input and gdb bytes reach the machine as raw bytes', () => {
  const f = fake();
  begin(f, { gdb: 1 });
  sendAll(f);
  f.events[0].ready();
  f.bridge.onLine(`x6 in ${b64([0x80, 0xff])}`);
  f.bridge.onLine(`x6 gi ${b64([0x2b, 0x24])}`);
  assert.deepEqual(f.handles[0].input, [Uint8Array.from([0x80, 0xff])]);
  assert.deepEqual(f.handles[0].gdb, [Uint8Array.from([0x2b, 0x24])]);
});

test('stop: asks the machine for fs, sends only the changed blocks, then exit 0', () => {
  const f = fake();
  begin(f);
  sendAll(f);
  f.events[0].ready();
  f.lines.length = 0;
  f.bridge.onLine('x6 stop');
  assert.equal(f.handles[0].stops, 1);
  const fs = fsBytes.slice();
  fs[4096 + 3] ^= 0xff; // block 1 changed
  f.events[0].stopped(fs);
  assert.equal(f.lines.length, 2);
  assert.equal(f.lines[0], `x6 fd 4096 ${encodeB64(fs.subarray(4096, 8192))}`);
  assert.equal(f.lines[1], 'x6 exit 0');
  assert.equal(f.handles[0].terminated, 1);
  // Nothing left: a second stop is stray.
  f.lines.length = 0;
  f.bridge.onLine('x6 stop');
  assert.deepEqual(f.lines, []);
});

test('a second begin while running is busy and its chunks are ignored', () => {
  const f = fake();
  begin(f);
  sendAll(f);
  f.events[0].ready();
  f.lines.length = 0;
  begin(f);
  assert.deepEqual(f.lines, ['x6 busy']);
  f.bridge.onLine(`x6 kb ${encodeB64(kernelBytes)}`);
  f.bridge.onLine('x6 run');
  assert.equal(f.starts.length, 1, 'the running machine is not restarted');
});

test('a stray stop and stray chunks with no session are dropped', () => {
  const f = fake();
  f.bridge.onLine('x6 stop');
  f.bridge.onLine(`x6 kb ${encodeB64(kernelBytes)}`);
  f.bridge.onLine('x6 run');
  f.bridge.onLine(`x6 in ${b64([1])}`);
  f.bridge.onLine('x6 gi AA==');
  assert.deepEqual(f.lines, []);
  assert.equal(f.starts.length, 0);
});

test('limits and early run are refused with x6 err, and the session resets', () => {
  const f = fake();
  f.bridge.onLine(`x6 begin 128 0 0 ${X6.KERNEL_MAX + 1} 10`);
  assert.match(f.lines.pop() ?? '', /^x6 err kernel size/);
  f.bridge.onLine(`x6 begin 128 0 0 10 ${X6.FS_MAX + 1}`);
  assert.match(f.lines.pop() ?? '', /^x6 err fs\.img size/);
  begin(f);
  f.bridge.onLine('x6 run');
  assert.match(f.lines.pop() ?? '', /^x6 err run before all bytes/);
  begin(f);
  f.bridge.onLine(`x6 kb ${encodeB64(new Uint8Array(6))}`);
  assert.match(f.lines.pop() ?? '', /^x6 err kb past the declared length/);
  assert.equal(f.starts.length, 0);
});

test('a start that throws replies x6 err and goes idle', () => {
  const f = fake({ throwOnStart: true });
  begin(f);
  sendAll(f);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0], /^x6 err cannot start xv6: no worker/);
  f.lines.length = 0;
  f.bridge.onLine('x6 stop');
  assert.deepEqual(f.lines, []);
});

test('a machine error during the handshake is x6 err only', () => {
  const f = fake();
  begin(f);
  sendAll(f);
  f.events[0].error('boom\nagain');
  assert.deepEqual(f.lines, ['x6 err boom again']);
  assert.equal(f.handles[0].terminated, 1);
});

test('a machine error after ready is x6 err then x6 exit 1', () => {
  const f = fake();
  begin(f);
  sendAll(f);
  f.events[0].ready();
  f.lines.length = 0;
  f.events[0].error('worker crashed');
  assert.deepEqual(f.lines, ['x6 err worker crashed', 'x6 exit 1']);
});

test('kill ends a session without sending anything', () => {
  const f = fake();
  begin(f);
  sendAll(f);
  f.events[0].ready();
  f.lines.length = 0;
  f.bridge.kill();
  assert.equal(f.handles[0].terminated, 1);
  assert.equal(f.bridge.running, false);
  assert.deepEqual(f.lines, []);
});

test('events from a machine that was replaced are ignored', () => {
  const f = fake();
  begin(f);
  sendAll(f);
  f.events[0].ready();
  f.bridge.kill();
  f.lines.length = 0;
  begin(f);
  sendAll(f);
  f.events[0].console(Uint8Array.from([0x41]));
  f.events[0].stopped(fsBytes.slice());
  f.events[1].ready();
  assert.deepEqual(f.lines, ['x6 ready'], 'only the new machine speaks');
});

test('begin with sync 1 starts the machine in sync mode; without the field it does not', () => {
  const on = fake();
  on.bridge.onLine(`x6 begin 128 0 0 ${kernelBytes.length} ${fsBytes.length} 1`);
  sendAll(on);
  assert.equal(on.starts.length, 1);
  assert.equal(on.starts[0].sync, true);

  const off = fake();
  begin(off);
  sendAll(off);
  assert.equal(off.starts[0].sync, false);
});

test('x6 ack resumes a starting or live machine, and is a no-op otherwise', () => {
  const f = fake();
  f.bridge.onLine('x6 ack'); // no session
  assert.deepEqual(f.lines, []);
  f.bridge.onLine(`x6 begin 128 0 0 ${kernelBytes.length} ${fsBytes.length} 1`);
  sendAll(f);
  f.bridge.onLine('x6 ack'); // starting
  assert.equal(f.handles[0].resumes, 1);
  f.events[0].ready();
  f.bridge.onLine('x6 ack'); // live
  assert.equal(f.handles[0].resumes, 2);
  assert.deepEqual(f.lines, ['x6 ready'], 'an ack never sends anything back');
  f.bridge.onLine('x6 stop');
  f.bridge.onLine('x6 ack'); // stopping: no resume is sent
  assert.equal(f.handles[0].resumes, 2);
  f.bridge.onLine('x6 ack junk'); // malformed: dropped
  assert.equal(f.handles[0].resumes, 2);
});

test('after a page reload, the old shim\'s stop and chunks are stray and send nothing', () => {
  const f = fake();
  // A fresh page has no session. The agent relays the stale shim's lines.
  f.bridge.onLine('x6 stop');
  f.bridge.onLine('x6 in AA==');
  f.bridge.onLine('x6 gi AA==');
  f.bridge.onLine('x6 fd 0 AA==');
  assert.deepEqual(f.lines, []);
  assert.equal(f.bridge.running, false);
  assert.equal(f.starts.length, 0);
});
