/// <reference lib="webworker" />
// Runs TinyEMU (WASM) and its main loop. The page only draws the terminal.
import type { FromWorker, ToWorker } from './protocol';
import { ChunkDisk, type DiskModule } from './disk';

declare const self: DedicatedWorkerGlobalScope;

interface Xemu extends DiskModule {
  disk?: ChunkDisk;
  _vm_set_snapshot(ptr: number, len: number, rawLen: number): number;
  _vm_set_snapshot_raw(ptr: number, len: number): void;
  _vm_snapshot_save(plen: number): number;
  _agent_send(ptr: number, len: number): number;
  _vm_run_slice(maxCycles: number, chunkCycles: number): number;
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
let disk: ChunkDisk | null = null;

// MessageChannel gives a macrotask yield without setTimeout's 4 ms clamp.
const chan = new MessageChannel();
chan.port1.onmessage = () => tick();
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
    delay = vm._vm_run_slice(SLICE_CYCLES, CHUNK_CYCLES);
    if (delay === 0) cycles += SLICE_CYCLES;
  } while (delay === 0 && performance.now() - start < SLICE_BUDGET_MS);
  flushOutput();

  const now = performance.now();
  if (now - lastStats > 1000) {
    // Upper bound only: counts the cycle budget of slices that didn't idle.
    const mips = lastStats ? cycles / ((now - lastStats) * 1000) : 0;
    post({ type: 'stats', mips: Math.round(mips), heapMb: Math.round(vm.HEAPU8.length / 2 ** 20), outBytes: outTotal });
    if (disk) post({ type: 'disk', stats: { ...disk.stats } });
    cycles = 0;
    lastStats = now;
  }

  if (delay === 0) yieldNow();
  else sleepTimer = setTimeout(tick, Math.max(1, delay));
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
}

// ----- guest agent (/dev/hvc1) -----
let agentBuf = '';
const agentWaiters: { cmd: string; resolve: (ok: boolean) => void }[] = [];
const agentDecoder = new TextDecoder();

function onAgent(bytes: Uint8Array) {
  agentBuf += agentDecoder.decode(bytes, { stream: true });
  let i;
  while ((i = agentBuf.indexOf('\n')) >= 0) {
    const line = agentBuf.slice(0, i).trim();
    agentBuf = agentBuf.slice(i + 1);
    const [status, cmd] = line.split(' ');
    const w = agentWaiters.findIndex((x) => x.cmd === cmd);
    if (w >= 0) agentWaiters.splice(w, 1)[0].resolve(status === 'ok');
    if (status === 'err') post({ type: 'log', message: `agent: ${line}` });
  }
}

function agentCommand(line: string, timeoutMs = 5000): Promise<boolean> {
  const cmd = line.split(' ')[0];
  const p = new Promise<boolean>((resolve) => {
    agentWaiters.push({ cmd, resolve });
    setTimeout(() => resolve(false), timeoutMs);
  });
  const bytes = new TextEncoder().encode(line + '\n');
  const ptr = vm!._malloc(bytes.length);
  vm!.HEAPU8.set(bytes, ptr);
  vm!._agent_send(ptr, bytes.length);
  vm!._free(ptr);
  wake();
  return p;
}

// After a restore: fresh entropy and the real clock before the user sees a
// prompt (the snapshot's CRNG state and clock are the same for everyone).
async function afterRestore() {
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const hex = [...seed].map((b) => b.toString(16).padStart(2, '0')).join('');
  const [okSeed, okTime] = await Promise.all([
    agentCommand(`seed ${hex}`),
    agentCommand(`time ${Date.now()}`),
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

async function start(bootUrl: string, ramMb: number, cmdline: string, resetOnly = false, forceCold = false) {
  t0 = performance.now();
  const bootAbs = new URL(bootUrl, self.location.href);
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
      if (restored === 1) afterRestore();
    },
  });
  vm = mod;
  let cfg = desc.cfg;
  let userSnap: Uint8Array | null = null;
  if (desc.disk) {
    disk = await ChunkDisk.load(mod, base, desc.disk, (msg) => post({ type: 'log', message: msg }));
    mod.disk = disk;
    disk.onWrite = scheduleSave;
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
  mod.ccall('vm_start', null, ['string', 'number', 'string', 'number'], [base + cfg, ramMb, cmdline, 0]);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      start(m.bootUrl, m.ramMb, m.cmdline, m.resetOnly, m.forceCold).catch((err) =>
        post({ type: 'error', message: String(err?.stack ?? err) }),
      );
      break;
    case 'input':
      for (const b of m.data) input.push(b);
      drainInput();
      wake();
      break;
    case 'save':
      saveNow(m.reason);
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
        wake();
      }
      break;
  }
};
