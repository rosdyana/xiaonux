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
  | { type: 'download'; path: string };

export type FromWorker =
  | { type: 'console'; data: Uint8Array }
  | { type: 'ready'; ms: number; restored: boolean }
  | { type: 'restored'; ms: number; agentOk: boolean }
  | { type: 'restart-cold' }
  | { type: 'fetch'; url: string; bytes: number }
  | { type: 'stats'; mips: number; heapMb: number; outBytes: number; jit?: { blocks: number; modules: number; invalidated: number; resets: number; preloaded?: number } }
  | { type: 'disk'; stats: DiskStats }
  | { type: 'log'; message: string }
  | { type: 'reset-done' }
  | { type: 'reset-failed'; reason: string }
  | { type: 'disk-mode'; persistent: boolean; reason: 'opfs' | 'other-tab' | 'unavailable' }
  | { type: 'transfer'; dir: 'up' | 'down'; done: number; total: number }
  | { type: 'upload-done'; name: string; path: string }
  | { type: 'download-done'; path: string; bytes: Uint8Array }
  | { type: 'transfer-error'; message: string }
  | { type: 'jit-export'; bytes: Uint8Array; build: number }
  | { type: 'net'; status: 'connecting' | 'connected' | 'disconnected' | 'rotated'; mode: string; detail?: string }
  | { type: 'net-blocked'; host: string; reason: string }
  | { type: 'saved'; reason: string; ms: number; bytes: number }
  | { type: 'error'; message: string };
