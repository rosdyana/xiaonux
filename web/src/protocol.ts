import type { DiskStats } from './disk';

/** Where guest connections leave: off, the local helper, or the relay. */
export interface NetConfig {
  mode: 'off' | 'helper' | 'relay';
  wsUrl: string;
  pingUrl: string;
  /** relay only: host names it will connect to ("*.x" = subdomains) and ports */
  allowed?: string[];
  ports?: number[];
  /** relay only: move new streams to a fresh WebSocket after this many bytes */
  rotateBytes?: number;
}

// Messages between the page and the VM worker.

export type ToWorker =
  | { type: 'start'; bootUrl: string; ramMb: number; cmdline: string; resetOnly?: boolean; forceCold?: boolean; record?: boolean; net?: NetConfig; jit?: boolean; jitCheck?: boolean }
  | { type: 'input'; data: Uint8Array }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'reset' }
  | { type: 'save'; reason: string }
  | { type: 'net'; net: NetConfig }
  | { type: 'jit-export' }
  | { type: 'upload'; name: string; data: Uint8Array }
  | { type: 'download'; path: string }
  /** xv6 bridge: one x6 line from the shim (see xv6-bridge.ts), relayed through the agent */
  | { type: 'x6'; line: string }
  /** extra shells (tabs 2-4); the console is not here */
  | { type: 'tab-open'; id: number; cols: number; rows: number }
  | { type: 'tab-input'; id: number; data: Uint8Array }
  | { type: 'tab-resize'; id: number; cols: number; rows: number }
  | { type: 'tab-close'; id: number };

export type FromWorker =
  | { type: 'console'; data: Uint8Array }
  | { type: 'ready'; ms: number; restored: boolean }
  | { type: 'restored'; ms: number; agentOk: boolean }
  | { type: 'restart-cold' }
  | { type: 'fetch'; url: string; bytes: number }
  | { type: 'stats'; mips: number; heapMb: number; outBytes: number; jit?: { blocks: number; modules: number; invalidated: number; resets: number; preloaded?: number; exec1?: number[]; exec1Nx?: number[]; mulh?: number; div?: number; trans?: number[]; transSame?: number[]; jitInsns?: number; entryHist?: number[]; stop?: number[]; runs?: number; insns?: number; regions?: number; regionBlocks?: number; checked?: number; checkSkipped?: number; jdist?: number[]; xdist?: number[]; chain?: number; fastHit?: number; fastMiss?: number } }
  | { type: 'disk'; stats: DiskStats }
  | { type: 'log'; message: string }
  | { type: 'reset-done' }
  | { type: 'reset-failed'; reason: string }
  /** current: false when the user's files live in an older image (boot.json `previous`) */
  | { type: 'disk-mode'; persistent: boolean; reason: 'opfs' | 'other-tab' | 'unavailable'; current: boolean }
  | { type: 'transfer'; dir: 'up' | 'down'; done: number; total: number }
  | { type: 'upload-done'; name: string; path: string }
  | { type: 'download-done'; path: string; bytes: Uint8Array }
  | { type: 'transfer-error'; message: string }
  | { type: 'jit-export'; bytes: Uint8Array; build: number }
  | { type: 'net'; status: 'connecting' | 'connected' | 'disconnected' | 'rotated'; mode: string; detail?: string }
  | { type: 'net-blocked'; host: string; reason: string }
  | { type: 'saved'; reason: string; ms: number; bytes: number }
  | { type: 'x6'; line: string }
  | { type: 'tab-out'; id: number; data: Uint8Array }
  | { type: 'tab-exit'; id: number; status: number }
  | { type: 'tab-opened'; id: number }
  | { type: 'tab-error'; id: number; reason: string }
  /** max: shells the guest allows; 0 = guest agent too old (needs Reset) */
  | { type: 'tabs'; max: number }
  | { type: 'error'; message: string };

// Messages between the page and its xv6 worker (xv6.worker.ts). Two users:
// the xv6 bridge (xv6-bridge.ts, `make qemu` in the guest, production) and the
// window.xiaonuxXv6 test hook. The Debian VM (vm.worker.ts) never uses these.

export type ToXv6Worker =
  /** sync: pause after each "$ " on the console until a `resume` (grading; see xn_uart.h) */
  | { type: 'start'; base: string; kernel: ArrayBuffer; fs: ArrayBuffer; jit?: boolean; gdb?: boolean; wait?: boolean; sync?: boolean }
  /** test hook: text typed into the console (UTF-8) */
  | { type: 'input'; data: string }
  /** bridge: raw console bytes from the shim */
  | { type: 'input-bytes'; data: Uint8Array }
  /** bridge: raw bytes from the gdb client */
  | { type: 'gdb-in'; data: Uint8Array }
  /** bridge: the shim acknowledged a prompt pause (x6 ack); a no-op unless paused */
  | { type: 'resume' }
  | { type: 'stop' };

export type FromXv6Worker =
  | { type: 'ready'; ms: number }
  | { type: 'console'; data: Uint8Array }
  /** gdb stub replies (only after start with gdb) */
  | { type: 'gdb'; data: Uint8Array }
  | { type: 'stats'; mips: number }
  /** the gdb client sent `k`: the machine is being stopped; `stopped` follows */
  | { type: 'killed' }
  | { type: 'stopped'; fs: ArrayBuffer }
  | { type: 'error'; message: string };
