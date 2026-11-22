/// <reference lib="webworker" />
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
// Runs the xv6-virt profile from bytes already in memory, for the page's
// window.xiaonuxXv6 test hook. Created only when the hook is called; the
// Debian VM (vm.worker.ts) is unchanged. Small on purpose: no disk chunks,
// network, agent or snapshots.
import type { FromXv6Worker, ToXv6Worker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

interface Xv6Xemu {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _xn_jit_set_enabled(on: number): void;
  _vm_run_slice(maxCycles: number, chunkCycles: number): number;
  _vm_insn_count(): number;
  _vm_mem_disk(plen: number): number;
  _console_queue_char(c: number): number;
  ccall(name: string, ret: 'number', types: string[], args: unknown[]): number;
}

// Same run-loop constants as vm.worker.ts.
const SLICE_CYCLES = 2_000_000;
const CHUNK_CYCLES = 200_000;
const SLICE_BUDGET_MS = 12;
const RAM_MB = 128; // the fixtures' cfg (memory_size: 128)

const post = (m: FromXv6Worker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let vm: Xv6Xemu | null = null;
let running = false;
let stopped = false;
let t0 = 0;
const input: number[] = [];
let inputHead = 0;
let outChunks: Uint8Array[] = [];
let outBytes = 0;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let lastStats = 0;
let lastInsns = 0;

// MessageChannel gives a macrotask yield without setTimeout's 4 ms clamp.
const chan = new MessageChannel();
chan.port1.onmessage = () => safeTick();
const yieldNow = () => chan.port2.postMessage(0);

// An exception in the run loop would otherwise just stop the guest silently.
function safeTick() {
  try {
    tick();
  } catch (e) {
    running = false;
    post({ type: 'error', message: `xv6 stopped: ${(e as Error)?.stack ?? e}` });
  }
}

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
  if (!vm || !running || stopped) return;
  sleepTimer = null;
  const start = performance.now();
  let delay = 0;
  do {
    drainInput();
    delay = vm._vm_run_slice(SLICE_CYCLES, CHUNK_CYCLES);
  } while (delay === 0 && performance.now() - start < SLICE_BUDGET_MS);
  flushOutput();

  const now = performance.now();
  if (now - lastStats > 1000) {
    // Guest instructions retired per wall-clock microsecond, as in vm.worker.ts.
    const insns = vm._vm_insn_count();
    const mips = lastStats ? (insns - lastInsns) / ((now - lastStats) * 1000) : 0;
    lastInsns = insns;
    lastStats = now;
    post({ type: 'stats', mips: Math.round(mips) });
  }

  if (delay === 0) yieldNow();
  else sleepTimer = setTimeout(safeTick, Math.max(1, delay));
}

// Input from the page: queue the bytes and run now, instead of waiting out an idle sleep.
function wake() {
  if (sleepTimer !== null) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
    yieldNow();
  }
}

async function start(m: Extract<ToXv6Worker, { type: 'start' }>) {
  t0 = performance.now();
  const baseAbs = new URL(m.base, self.location.href);
  // The emulator script is imported from the same directory as boot.json: only ever our own.
  if (baseAbs.origin !== self.location.origin) throw new Error('xv6 base must be on this site');
  const base = new URL('.', baseAbs).href;
  const { default: createXemu } = (await import(/* @vite-ignore */ `${base}xemu.mjs`)) as {
    default: (o: object) => Promise<Xv6Xemu>;
  };
  const mod = await createXemu({
    locateFile: (p: string) => base + p,
    baseUrl: base,
    consoleSize: [80, 24],
    onConsole: (bytes: Uint8Array) => {
      outChunks.push(bytes.slice());
      outBytes += bytes.length;
    },
    onReady: () => {
      running = true;
      post({ type: 'ready', ms: Math.round(performance.now() - t0) });
    },
  });
  vm = mod;
  mod._xn_jit_set_enabled(m.jit !== false ? 1 : 0);

  // Every _malloc can grow the heap, so read mod.HEAPU8 fresh after each one.
  const kernel = new Uint8Array(m.kernel);
  const fs = new Uint8Array(m.fs);
  const kp = mod._malloc(kernel.length);
  mod.HEAPU8.set(kernel, kp);
  const fp = mod._malloc(fs.length);
  mod.HEAPU8.set(fs, fp);
  // vm_start_mem takes ownership of both buffers and calls onReady before it returns.
  const rc = mod.ccall('vm_start_mem', 'number',
    ['string', 'number', 'number', 'number', 'number', 'number'],
    ['xv6-virt', kp, kernel.length, fp, fs.length, RAM_MB]);
  if (rc !== 0) throw new Error(`vm_start_mem failed (${rc})`);
  yieldNow();
}

function stop() {
  stopped = true;
  running = false;
  if (sleepTimer !== null) clearTimeout(sleepTimer);
  sleepTimer = null;
  let fs = new ArrayBuffer(0);
  if (vm) {
    flushOutput();
    const lenPtr = vm._malloc(4);
    const p = vm._vm_mem_disk(lenPtr);
    const len = new DataView(vm.HEAPU8.buffer, lenPtr, 4).getInt32(0, true);
    fs = vm.HEAPU8.slice(p, p + len).buffer;
    vm._free(lenPtr);
  }
  post({ type: 'stopped', fs }, [fs]);
  self.close();
}

self.onmessage = (e: MessageEvent<ToXv6Worker>) => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      start(m).catch((err) => post({ type: 'error', message: `xv6 start: ${(err as Error)?.stack ?? err}` }));
      break;
    case 'input': {
      for (const b of new TextEncoder().encode(m.data)) input.push(b);
      wake();
      break;
    }
    case 'stop':
      stop();
      break;
  }
};
