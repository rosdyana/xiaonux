import type { DiskStats } from './disk';

// Messages between the page and the VM worker.

export type ToWorker =
  | { type: 'start'; bootUrl: string; ramMb: number; cmdline: string; resetOnly?: boolean; forceCold?: boolean; record?: boolean }
  | { type: 'input'; data: Uint8Array }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'reset' }
  | { type: 'save'; reason: string };

export type FromWorker =
  | { type: 'console'; data: Uint8Array }
  | { type: 'ready'; ms: number; restored: boolean }
  | { type: 'restored'; ms: number; agentOk: boolean }
  | { type: 'restart-cold' }
  | { type: 'fetch'; url: string; bytes: number }
  | { type: 'stats'; mips: number; heapMb: number; outBytes: number }
  | { type: 'disk'; stats: DiskStats }
  | { type: 'log'; message: string }
  | { type: 'reset-done' }
  | { type: 'saved'; reason: string; ms: number; bytes: number }
  | { type: 'error'; message: string };
