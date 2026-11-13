/// <reference lib="webworker" />
// Runs TinyEMU (WASM) and its main loop. The page only draws the terminal.
import type { FromWorker, NetConfig, ToWorker } from './protocol';
import { ChunkDisk, type DiskModule } from './disk';
import { NetStack } from './net/stack';
import { noExit, type Exit } from './net/exit';
import { WispExit } from './net/wisp';

declare const self: DedicatedWorkerGlobalScope;

interface Xemu extends DiskModule {
  disk?: ChunkDisk;
  _vm_set_snapshot(ptr: number, len: number, rawLen: number): number;
  _vm_set_snapshot_raw(ptr: number, len: number): void;
  _vm_snapshot_save(plen: number): number;
  _agent_send(ptr: number, len: number): number;
  _net_write_packet(ptr: number, len: number): void;
  _net_can_write(): number;
  _vm_run_slice(maxCycles: number, chunkCycles: number): number;
  _vm_insn_count(): number;
  _xn_jit_set_enabled(on: number): void;
  _xn_jit_set_check(on: number): void;
  _xn_jit_stat(which: number): number;
  _xn_jit_export(plen: number): number;
  _xn_jit_preload(ptr: number, len: number): number;
  _xn_jit_build_id(): number;
  _xn_brotli_decode(ptr: number, len: number, rawLen: number): number;
  xnJitPreModule?: WebAssembly.Module | null;
  _console_queue_char(c: number): number;
  _console_resize(): void;
  ccall(name: string, ret: null, types: string[], args: unknown[]): void;
  HEAPU8: Uint8Array;
  consoleSize: [number, number];
}

// Guest instructions per vm_run_slice call, and per interp chunk.
const SLICE_CYCLES = 2_000_000;
const CHUNK_CYCLES = 200_000;
// Wall-clock budget per macrotask before yielding to receive messages.
const SLICE_BUDGET_MS = 12;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let vm: Xemu | null = null;
let ready = false;
let t0 = 0;
const input: number[] = [];
let inputHead = 0;
let outChunks: Uint8Array[] = [];
let outBytes = 0;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let cycles = 0;
let lastStats = 0;
let outTotal = 0;
let lastInsns = 0;
let disk: ChunkDisk | null = null;

// ----- network -----
const rxQueue: Uint8Array[] = []; // frames for the guest, waiting for RX buffers
let net: NetStack | null = null;

function pumpRx() {
  if (!vm) return;
  while (rxQueue.length && vm._net_can_write()) {
    const f = rxQueue.shift()!;
    const p = vm._malloc(f.length);
    vm.HEAPU8.set(f, p);
    vm._net_write_packet(p, f.length);
    vm._free(p);
  }
}

function makeExit(cfg: NetConfig | undefined): Exit {
  if (!cfg || cfg.mode === 'off') return noExit;
  return new WispExit(cfg.mode, cfg.wsUrl, cfg.pingUrl, (status, detail) =>
    post({ type: 'net', status, mode: cfg.mode, detail }), cfg.allowed, cfg.ports, cfg.rotateBytes ?? 0);
}

// MessageChannel gives a macrotask yield without setTimeout's 4 ms clamp.
const chan = new MessageChannel();
chan.port1.onmessage = () => safeTick();

// An exception in the run loop would otherwise just stop the guest silently.
function safeTick() {
  try {
    tick();
  } catch (e) {
    ready = false;
    post({ type: 'error', message: `VM stopped: ${(e as Error)?.stack ?? e}` });
  }
}
const yieldNow = () => chan.port2.postMessage(0);

function flushOutput() {
  if (outBytes === 0) return;
  const buf = new Uint8Array(outBytes);
  let o = 0;
  for (const c of outChunks) {
    buf.set(c, o);
    o += c.length;
  }
  outChunks = [];
  outBytes = 0;
  post({ type: 'console', data: buf }, [buf.buffer]);
}

function drainInput() {
  if (!vm) return;
  while (inputHead < input.length && vm._console_queue_char(input[inputHead])) inputHead++;
  if (inputHead === input.length) {
    input.length = 0;
    inputHead = 0;
  }
}

function tick() {
  if (!vm || !ready) return;
  sleepTimer = null;
  const start = performance.now();
  let delay = 0;
  do {
    drainInput();
    pumpRx();
    pumpAgent();
    delay = vm._vm_run_slice(SLICE_CYCLES, CHUNK_CYCLES);
    if (delay === 0) cycles += SLICE_CYCLES;
  } while (delay === 0 && performance.now() - start < SLICE_BUDGET_MS);
  flushOutput();

  const now = performance.now();
  if (now - lastStats > 1000) {
    // Real rate: guest instructions retired per wall-clock microsecond.
    const insns = vm._vm_insn_count();
    const mips = lastStats ? (insns - lastInsns) / ((now - lastStats) * 1000) : 0;
    lastInsns = insns;
    post({ type: 'stats', mips: Math.round(mips), heapMb: Math.round(vm.HEAPU8.length / 2 ** 20), outBytes: outTotal,
      jit: { blocks: vm._xn_jit_stat(0), modules: vm._xn_jit_stat(1), invalidated: vm._xn_jit_stat(2), resets: vm._xn_jit_stat(3), preloaded: vm._xn_jit_stat(6) } });
    if (disk) post({ type: 'disk', stats: { ...disk.stats } });
    cycles = 0;
    lastStats = now;
  }

  if (delay === 0) yieldNow();
  else sleepTimer = setTimeout(safeTick, Math.max(1, delay));
}

function wake() {
  if (sleepTimer !== null) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
    yieldNow();
  }
}

// boot.json: {
//   cfg: "xiaonux.cfg",                  cold boot (kernel + disk)
//   disk: "disk-<sha256>.json",          chunked disk manifest
//   snapshot?: { file: "snap-<sha256>.br", raw: <bytes>, cfg: "snap.cfg" }
// }  The snapshot was saved against exactly this disk.
interface BootDesc {
  cfg: string;
  disk?: string;
  snapshot?: { file: string; raw: number; cfg: string };
  /** chunks the first commands need: [hash, offset, length] into file */
  prefetch?: { file: string; index: [string, number, number][] };
  /** translated code for common commands (4e), valid for one emulator build */
  jit?: { file: string; build: number; raw?: number };
}

// Load shipped translations: compile off the VM thread, then register.
async function preloadJit(base: string, jit: { file: string; build: number; raw?: number }) {
  if (!vm || (vm._xn_jit_build_id() >>> 0) !== (jit.build >>> 0)) {
    post({ type: 'log', message: 'shipped translations are for another emulator build; skipped' });
    return;
  }
  const t = performance.now();
  const fetched = await fetchCached(base + jit.file);
  // .br bundles are decoded by the Brotli decoder in our WASM (CDN-independent)
  let p: number, len: number;
  if (jit.raw) {
    const c = vm._malloc(fetched.length);
    vm.HEAPU8.set(fetched, c);
    p = vm._xn_brotli_decode(c, fetched.length, jit.raw);
    vm._free(c);
    if (!p) throw new Error('bundle failed to decode');
    len = jit.raw;
  } else {
    p = vm._malloc(fetched.length);
    vm.HEAPU8.set(fetched, p);
    len = fetched.length;
  }
  const wasmLen = new DataView(vm.HEAPU8.buffer, p, 16).getUint32(12, true);
  vm.xnJitPreModule = await WebAssembly.compile(vm.HEAPU8.slice(p + 16, p + 16 + wasmLen));
  const n = vm._xn_jit_preload(p, len); // keeps its own copy of the index
  vm._free(p);
  post({ type: 'log', message: `shipped translations: ${n} blocks in ${Math.round(performance.now() - t)} ms` });
}

// ----- guest agent (/dev/hvc1) -----
// Replies are lines. "ok <cmd> ..." / "err <cmd> ..." resolve the oldest
// waiter for <cmd>; "file"/"data" lines belong to a running download.
let agentBuf = '';
const agentWaiters: { cmd: string; resolve: (ok: boolean, line: string) => void }[] = [];
const agentDecoder = new TextDecoder();
const agentEncoder = new TextEncoder();

// Bytes for the agent wait here: the C side takes at most 4 KB at a time.
const agentOut: Uint8Array[] = [];
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let agentOutOff = 0;

function pumpAgent() {
  if (!vm) return;
  while (agentOut.length) {
    const head = agentOut[0];
    const piece = head.subarray(agentOutOff, agentOutOff + 4096);
    const p = vm._malloc(piece.length);
    vm.HEAPU8.set(piece, p);
    const n = vm._agent_send(p, piece.length);
    vm._free(p);
    if (n <= 0) return;
    agentOutOff += n;
    if (agentOutOff >= head.length) {
      agentOut.shift();
      agentOutOff = 0;
    }
  }
}

function agentWrite(line: string) {
  agentOut.push(agentEncoder.encode(line + '\n'));
  pumpAgent();
  wake();
}

interface Download { size: number; sha: string; parts: Uint8Array[]; got: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void }
let download: Download | null = null;

function onAgent(bytes: Uint8Array) {
  agentBuf += agentDecoder.decode(bytes, { stream: true });
  let i;
  while ((i = agentBuf.indexOf('\n')) >= 0) {
    const line = agentBuf.slice(0, i).trim();
    agentBuf = agentBuf.slice(i + 1);
    const [status, cmd] = line.split(' ');
    if (status === 'file' && download) {
      const [, size, sha] = line.split(' ');
      download.size = Number(size);
      download.sha = sha;
      continue;
    }
    if (status === 'data' && download) {
      const bin = atob(line.slice(5));
      const b = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) b[k] = bin.charCodeAt(k);
      download.parts.push(b);
      download.got += b.length;
      post({ type: 'transfer', dir: 'down', done: download.got, total: download.size });
      continue;
    }
    const w = agentWaiters.findIndex((x) => x.cmd === cmd);
    if (w >= 0) agentWaiters.splice(w, 1)[0].resolve(status === 'ok', line);
    if (status === 'err') post({ type: 'log', message: `agent: ${line}` });
  }
}

function agentRequest(line: string, timeoutMs = 5000): Promise<{ ok: boolean; line: string }> {
  const cmd = line.split(' ')[0];
  const p = new Promise<{ ok: boolean; line: string }>((resolve) => {
    agentWaiters.push({ cmd, resolve: (ok, l) => resolve({ ok, line: l }) });
    setTimeout(() => resolve({ ok: false, line: 'timeout' }), timeoutMs);
  });
  agentWrite(line);
  return p;
}

const agentCommand = (line: string, timeoutMs = 5000) => agentRequest(line, timeoutMs).then((r) => r.ok);

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Upload a file into /root/uploads/<name> through the agent (no network needed). */
async function uploadFile(name: string, data: Uint8Array) {
  const put = await agentRequest(`put ${data.length} ${name}`);
  if (!put.ok) throw new Error(put.line);
  const STEP = 36 * 1024;
  for (let o = 0; o < data.length; o += STEP) {
    let bin = '';
    const piece = data.subarray(o, o + STEP);
    for (let k = 0; k < piece.length; k += 0x8000) bin += String.fromCharCode(...piece.subarray(k, k + 0x8000));
    agentWrite('chunk ' + btoa(bin));
    // let the guest drain before queueing much more
    while (agentOut.length > 8) await new Promise((r) => setTimeout(r, 5));
    post({ type: 'transfer', dir: 'up', done: Math.min(o + STEP, data.length), total: data.length });
  }
  while (agentOut.length) await new Promise((r) => setTimeout(r, 5));
  const sha = hex(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
  const end = await agentRequest(`end ${sha}`, 120000);
  if (!end.ok) throw new Error(end.line);
  return end.line.split(' ').slice(2).join(' '); // path in the guest
}

/** Fetch a file under /root from the guest, verified by SHA-256. */
async function downloadFile(path: string): Promise<Uint8Array> {
  if (download) throw new Error('a download is already running');
  const result = new Promise<Uint8Array>((resolve, reject) => {
    download = { size: 0, sha: '', parts: [], got: 0, resolve, reject };
  });
  const r = await agentRequest(`get ${path}`, 600000);
  const d = download!;
  download = null;
  if (!r.ok) throw new Error(r.line.replace(/^err get /, ''));
  const out = new Uint8Array(d.got);
  let o = 0;
  for (const part of d.parts) { out.set(part, o); o += part.length; }
  if (d.got !== d.size || hex(await crypto.subtle.digest('SHA-256', out)) !== d.sha) throw new Error('transfer corrupted');
  d.resolve(out);
  return result;
}

// After a restore: fresh entropy and the real clock before the user sees a
// prompt (the snapshot's CRNG state and clock are the same for everyone).
async function afterRestore() {
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const hex = [...seed].map((b) => b.toString(16).padStart(2, '0')).join('');
  const [okSeed, okTime] = await Promise.all([
    agentCommand(`seed ${hex}`, 15000),
    agentCommand(`time ${Date.now()}`, 15000),
  ]);
  if (!okSeed || !okTime) post({ type: 'log', message: `agent: seed ${okSeed} time ${okTime}` });
  const [cols, rows] = vm!.consoleSize;
  agentCommand(`size ${cols} ${rows}`);
  // Ask the shell (waiting at its prompt in the snapshot) for a fresh prompt.
  input.push(13);
  drainInput();
  wake();
  post({ type: 'restored', ms: Math.round(performance.now() - t0), agentOk: okSeed && okTime });
}

// ----- user snapshots -----
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_AFTER_IDLE_MS = 5000;

function scheduleSave() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow('idle');
  }, SAVE_AFTER_IDLE_MS);
}

// Runs between slices, so the guest is paused. A save is refused while a
// disk request is in flight; retry shortly.
function saveNow(reason: string, attempt = 0) {
  if (!vm || !ready || !disk || !disk.canSaveSnapshots) return;
  if (!disk.hasUserData || !disk.changedSinceSave) return;
  const t = performance.now();
  const lenPtr = vm._malloc(4);
  const p = vm._vm_snapshot_save(lenPtr);
  const len = new Uint32Array(vm.HEAPU8.buffer, lenPtr, 1)[0];
  vm._free(lenPtr);
  if (!p) {
    if (attempt < 40) setTimeout(() => saveNow(reason, attempt + 1), 25);
    return;
  }
  disk.saveUserSnapshot(vm.HEAPU8.subarray(p, p + len));
  vm._free(p);
  post({ type: 'saved', reason, ms: Math.round(performance.now() - t), bytes: len });
}

async function fetchCached(url: string): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open('xiaonux-chunks-v1');
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  post({ type: 'fetch', url, bytes: b.length });
  cache?.put(url, new Response(b)).catch(() => {});
  return b;
}

async function start(bootUrl: string, ramMb: number, cmdline: string, resetOnly = false, forceCold = false, record = false, netCfg?: NetConfig, jit = true, jitCheck = false) {
  t0 = performance.now();
  const bootAbs = new URL(bootUrl, self.location.href);
  // The emulator script is imported from next to boot.json: only ever our own.
  if (bootAbs.origin !== self.location.origin) throw new Error('boot.json must be on this site');
  const base = new URL('.', bootAbs).href;
  const [desc, { default: createXemu }] = await Promise.all([
    fetch(bootAbs, { cache: 'no-cache' }).then((r) => r.json() as Promise<BootDesc>),
    import(/* @vite-ignore */ `${base}xemu.mjs`),
  ]);
  const mod: Xemu = await createXemu({
    locateFile: (p: string) => base + p,
    baseUrl: base,
    consoleSize: [80, 24],
    onConsole: (bytes: Uint8Array) => {
      outChunks.push(bytes.slice());
      outTotal += bytes.length;
      outBytes += bytes.length;
    },
    onAgent,
    onNetPacket: (f: Uint8Array) => {
      net?.handleFrame(f);
      pumpRx();
    },
    onFetch: (url: string, bytes: number) => post({ type: 'fetch', url, bytes }),
    onReady: (restored: number) => {
      if (restored < 0) {
        post({ type: 'log', message: 'snapshot does not match this build; cold boot' });
        post({ type: 'restart-cold' });
        return;
      }
      ready = true;
      post({ type: 'ready', ms: Math.round(performance.now() - t0), restored: restored === 1 });
      yieldNow();
      if (desc.jit && jit && !jitCheck) setTimeout(() => preloadJit(base, desc.jit!).catch((e) => post({ type: 'log', message: `jit preload: ${e}` })), 0);
      // Warm the chunks the first commands will need, without delaying the prompt.
      if (desc.prefetch && disk && !record) {
        const d = disk;
        const pf = desc.prefetch;
        setTimeout(() => d.prefetchBundle(pf.file, pf.index).then((n) => n && post({ type: 'log', message: `prefetched ${(n / 2 ** 20).toFixed(1)} MB` })), 50);
      }
      if (restored === 1) afterRestore();
    },
  });
  vm = mod;
  mod._xn_jit_set_enabled(jit ? 1 : 0); // ?jit=0 runs the plain interpreter
  if (jitCheck) mod._xn_jit_set_check(1); // ?jit=check: lockstep against the interpreter
  net = new NetStack(
    (f) => {
      rxQueue.push(f);
      pumpRx();
      wake();
    },
    makeExit(netCfg),
    {
      blocked: (host, reason) => post({ type: 'net-blocked', host, reason }),
      activity: () => {},
    },
  );
  // Our riscv64 wheel index, served inside the worker (works with the network off).
  // Static hosting: a directory URL means its index.html.
  net.localHosts.set('wheels.xiaonux', (path) => fetch(base + 'pypi' + (path.endsWith('/') ? path + 'index.html' : path)));
  let cfg = desc.cfg;
  let userSnap: Uint8Array | null = null;
  if (desc.disk) {
    disk = await ChunkDisk.load(mod, base, desc.disk, (msg) => post({ type: 'log', message: msg }));
    mod.disk = disk;
    disk.onWrite = scheduleSave;
    disk.record = record;
    if (resetOnly) {
      disk.reset();
      post({ type: 'reset-done' });
      return;
    }
    userSnap = disk.open(!forceCold);
    post({ type: 'disk', stats: disk.stats });
  }
  // The shipped snapshot is only valid with the pristine disk. Once the user
  // has changes, resume their own save (valid only with the overlay exactly
  // as it was then), else cold boot with the overlay.
  if (userSnap) {
    const p = mod._malloc(userSnap.length);
    mod.HEAPU8.set(userSnap, p);
    mod._vm_set_snapshot_raw(p, userSnap.length); // C owns p now
    if (desc.snapshot) cfg = desc.snapshot.cfg;
    post({ type: 'log', message: `resuming your saved machine (${(userSnap.length / 2 ** 20).toFixed(1)} MB)` });
  } else if (desc.snapshot && !forceCold && !disk?.hasUserData) {
    const snap = await fetchCached(base + desc.snapshot.file);
    const p = mod._malloc(snap.length);
    mod.HEAPU8.set(snap, p);
    const rc = mod._vm_set_snapshot(p, snap.length, desc.snapshot.raw);
    mod._free(p);
    if (rc === 0) cfg = desc.snapshot.cfg;
    else post({ type: 'log', message: 'snapshot failed to decode; cold boot' });
  }
  mod.ccall('vm_start', null, ['string', 'number', 'string', 'number'], [base + cfg, ramMb, cmdline, 1]);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      start(m.bootUrl, m.ramMb, m.cmdline, m.resetOnly, m.forceCold, m.record, m.net, m.jit ?? true, m.jitCheck ?? false).catch((err) =>
        post({ type: 'error', message: String(err?.stack ?? err) }),
      );
      break;
    case 'input':
      for (const b of m.data) input.push(b);
      drainInput();
      wake();
      break;
    case 'net':
      net?.resetAll();
      if (net) net.exit = makeExit(m.net);
      break;
    case 'jit-export': {
      if (!vm) break;
      const lp = vm._malloc(4);
      const p = vm._xn_jit_export(lp);
      const len = new Uint32Array(vm.HEAPU8.buffer, lp, 1)[0];
      const bytes = vm.HEAPU8.slice(p, p + len);
      vm._free(p); vm._free(lp);
      post({ type: 'jit-export', bytes, build: vm._xn_jit_build_id() >>> 0 }, [bytes.buffer]);
      break;
    }
    case 'save':
      saveNow(m.reason);
      break;
    case 'upload':
      uploadFile(m.name, m.data).then(
        (path) => post({ type: 'upload-done', name: m.name, path }),
        (e) => post({ type: 'transfer-error', message: `upload of ${m.name} failed: ${e.message}` }));
      break;
    case 'download':
      downloadFile(m.path).then(
        (bytes) => post({ type: 'download-done', path: m.path, bytes }, [bytes.buffer]),
        (e) => post({ type: 'transfer-error', message: `download of ${m.path} failed: ${e.message}` }));
      break;
    case 'reset':
      // Stop the guest first so it can't write after the overlay is gone.
      ready = false;
      disk?.reset();
      post({ type: 'reset-done' });
      break;
    case 'resize':
      if (vm) {
        vm.consoleSize = [m.cols, m.rows];
        vm._console_resize();
        // The shell only sees the size the agent sets on /dev/hvc0 (the
        // console resize alone doesn't reach the tty), so tell it too.
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => agentCommand(`size ${m.cols} ${m.rows}`), 100);
        wake();
      }
      break;
  }
};
