// Messages between the page and the VM worker.

export type ToWorker =
  | { type: 'start'; cfgUrl: string; ramMb: number; cmdline: string }
  | { type: 'input'; data: Uint8Array }
  | { type: 'resize'; cols: number; rows: number };

export type FromWorker =
  | { type: 'console'; data: Uint8Array }
  | { type: 'ready'; ms: number }
  | { type: 'fetch'; url: string; bytes: number }
  | { type: 'stats'; mips: number; heapMb: number; outBytes: number }
  | { type: 'error'; message: string };
