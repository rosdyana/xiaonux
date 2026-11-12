/// <reference lib="webworker" />
// Runs TinyEMU (WASM) and its main loop. The page only draws the terminal.
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

interface Xemu {
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
    const mips = lastStats ? cycles / ((now - lastStats) * 1000) : 0;
    post({ type: 'stats', mips: Math.round(mips), heapMb: Math.round(vm.HEAPU8.length / 2 ** 20), outBytes: outTotal });
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

async function start(cfgUrl: string, ramMb: number, cmdline: string) {
  t0 = performance.now();
  const base = new URL('.', new URL(cfgUrl, self.location.href)).href;
  const { default: createXemu } = await import(/* @vite-ignore */ `${base}xemu.mjs`);
  const mod: Xemu = await createXemu({
    locateFile: (p: string) => base + p,
    baseUrl: base,
    consoleSize: [80, 24],
    onConsole: (bytes: Uint8Array) => {
      outChunks.push(bytes.slice());
      outTotal += bytes.length;
      outBytes += bytes.length;
    },
    onFetch: (url: string, bytes: number) => post({ type: 'fetch', url, bytes }),
    onReady: () => {
      ready = true;
      post({ type: 'ready', ms: Math.round(performance.now() - t0) });
      yieldNow();
    },
  });
  vm = mod;
  mod.ccall('vm_start', null, ['string', 'number', 'string', 'number'], [cfgUrl, ramMb, cmdline, 0]);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      start(m.cfgUrl, m.ramMb, m.cmdline).catch((err) =>
        post({ type: 'error', message: String(err?.stack ?? err) }),
      );
      break;
    case 'input':
      for (const b of m.data) input.push(b);
      drainInput();
      wake();
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
