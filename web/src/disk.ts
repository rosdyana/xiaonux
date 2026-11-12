/// <reference lib="webworker" />
// Phase 2 disk: content-addressed Brotli chunks (decoded in WASM) plus a
// copy-on-write overlay of 4 KB clusters kept in OPFS.

const CLUSTER = 4096;
const CACHE_NAME = 'xiaonux-chunks-v1';

export interface DiskManifest {
  format: string;
  block_size: number;
  n_blocks: number;
  hashes: string[];
  map: number[];
}

export interface DiskModule {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _blk_chunk_setup(bs: number, nb: number, map: number, hashes: number, nh: number, cacheMb: number): number;
  _blk_chunk_loaded(block: number, ptr: number, len: number): void;
  _blk_overlay_mark(cluster: number): void;
  _blk_overlay_clear(): void;
  _blk_prefetch(block: number): void;
}

export interface DiskStats {
  chunksFetched: number;
  chunksFromCache: number;
  bytesNetwork: number;
  bytesCache: number;
  overlayClusters: number;
  overlayBackend: 'opfs' | 'memory';
  errors: number;
}

// Overlay storage: an index file (one u32 per cluster: slot+1, 0 = absent)
// and a data file of 4 KB slots appended in write order.
interface Overlay {
  backend: 'opfs' | 'memory';
  has(cluster: number): boolean;
  read(cluster: number, dst: Uint8Array): boolean;
  write(cluster: number, src: Uint8Array): void;
  flush(): void;
  clusters(): number[];
  reset(): void;
}

function memoryOverlay(): Overlay {
  const m = new Map<number, Uint8Array>();
  return {
    backend: 'memory',
    has: (c) => m.has(c),
    read: (c, dst) => {
      const b = m.get(c);
      if (!b) return false;
      dst.set(b);
      return true;
    },
    write: (c, src) => void m.set(c, src.slice()),
    flush: () => {},
    clusters: () => [...m.keys()],
    reset: () => m.clear(),
  };
}

async function opfsOverlay(name: string, nClusters: number): Promise<Overlay> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(name, { create: true });
  const idxH = await (await dir.getFileHandle('index', { create: true })).createSyncAccessHandle();
  const datH = await (await dir.getFileHandle('data', { create: true })).createSyncAccessHandle();
  const index = new Uint32Array(nClusters);
  const got = idxH.read(new Uint8Array(index.buffer), { at: 0 });
  let slots = Math.floor(datH.getSize() / CLUSTER);
  // An index entry that points past the data file is from a torn write: drop it.
  if (got > 0) for (let i = 0; i < nClusters; i++) if (index[i] > slots) index[i] = 0;
  const entry = new Uint32Array(1);
  let dirty = false;
  return {
    backend: 'opfs',
    has: (c) => index[c] !== 0,
    read(c, dst) {
      const s = index[c];
      if (!s) return false;
      datH.read(dst, { at: (s - 1) * CLUSTER });
      return true;
    },
    write(c, src) {
      let s = index[c];
      if (!s) {
        s = ++slots;
        datH.write(src, { at: (s - 1) * CLUSTER });
        index[c] = s;
        entry[0] = s;
        // data before index, so a torn write never points at garbage
        idxH.write(new Uint8Array(entry.buffer), { at: c * 4 });
      } else {
        datH.write(src, { at: (s - 1) * CLUSTER });
      }
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      datH.flush();
      idxH.flush();
      dirty = false;
    },
    clusters() {
      const out: number[] = [];
      for (let i = 0; i < nClusters; i++) if (index[i]) out.push(i);
      return out;
    },
    reset() {
      index.fill(0);
      slots = 0;
      idxH.truncate(0);
      datH.truncate(0);
      idxH.flush();
      datH.flush();
    },
  };
}

const hexToBytes = (h: string, out: Uint8Array, at: number) => {
  for (let i = 0; i < 32; i++) out[at + i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
};

export class ChunkDisk {
  stats: DiskStats = {
    chunksFetched: 0, chunksFromCache: 0, bytesNetwork: 0, bytesCache: 0,
    overlayClusters: 0, overlayBackend: 'memory', errors: 0,
  };
  private overlay!: Overlay;
  private cache: Cache | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private mod: DiskModule,
    private base: string,
    private manifest: DiskManifest,
    readonly id: string,
    private onEvent: (msg: string) => void = () => {},
  ) {}

  static async load(mod: DiskModule, base: string, manifestName: string, onEvent?: (msg: string) => void) {
    const r = await fetch(base + manifestName, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`manifest ${manifestName}: HTTP ${r.status}`);
    const manifest = (await r.json()) as DiskManifest;
    if (manifest.format !== 'xiaonux-disk-1') throw new Error(`unknown disk format ${manifest.format}`);
    // The overlay belongs to one exact base image.
    const id = manifestName.replace(/^disk-|\.json$/g, '').slice(0, 16);
    const d = new ChunkDisk(mod, base, manifest, id, onEvent);
    await d.init();
    return d;
  }

  private async init() {
    const { mod, manifest: m } = this;
    const mapPtr = mod._malloc(m.n_blocks * 4);
    new Uint32Array(mod.HEAPU8.buffer, mapPtr, m.n_blocks).set(m.map);
    const hashPtr = mod._malloc(m.hashes.length * 32);
    m.hashes.forEach((h, i) => hexToBytes(h, mod.HEAPU8, hashPtr + i * 32));
    const rc = mod._blk_chunk_setup(m.block_size, m.n_blocks, mapPtr, hashPtr, m.hashes.length, 32);
    mod._free(mapPtr);
    mod._free(hashPtr);
    if (rc !== 0) throw new Error('blk_chunk_setup failed');

    const nClusters = (m.n_blocks * m.block_size) / CLUSTER;
    try {
      this.overlay = await opfsOverlay(`overlay-${this.id}`, nClusters);
    } catch (e) {
      this.onEvent(`OPFS unavailable (${e}); changes won't survive a reload`);
      this.overlay = memoryOverlay();
    }
    this.stats.overlayBackend = this.overlay.backend;
    for (const c of this.overlay.clusters()) mod._blk_overlay_mark(c);
    this.stats.overlayClusters = this.overlay.clusters().length;
    try {
      this.cache = await caches.open(CACHE_NAME);
    } catch {
      this.cache = null; // e.g. opaque origin; fetch straight from the network
    }
  }

  get hasUserData() {
    return this.stats.overlayClusters > 0;
  }

  // ----- callbacks from C (via lib.js) -----

  fetchChunk = (block: number, hashIndex: number) => {
    const url = `${this.base}chunks/${this.manifest.hashes[hashIndex]}.br`;
    this.getChunk(url)
      .then((bytes) => this.deliver(block, bytes))
      .catch((e) => {
        this.stats.errors++;
        this.onEvent(`chunk ${block}: ${e}`);
        this.mod._blk_chunk_loaded(block, 0, 0);
      });
  };

  overlayRead = (cluster: number, ptr: number) =>
    this.overlay.read(cluster, this.mod.HEAPU8.subarray(ptr, ptr + CLUSTER));

  overlayWrite = (cluster: number, ptr: number) => {
    const isNew = !this.overlay.has(cluster);
    this.overlay.write(cluster, this.mod.HEAPU8.subarray(ptr, ptr + CLUSTER));
    if (isNew) this.stats.overlayClusters++;
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.overlay.flush();
      }, 500);
    }
  };

  event = (kind: number, block: number, value: number) => {
    if (kind === 2) this.onEvent(`chunk ${block}: hash mismatch`);
    if (kind === 3) this.onEvent(`chunk ${block}: decode error ${value}`);
    if (kind !== 1) this.stats.errors++;
  };

  // ----- helpers -----

  private async getChunk(url: string): Promise<Uint8Array> {
    const hit = this.cache ? await this.cache.match(url) : undefined;
    if (hit) {
      const b = new Uint8Array(await hit.arrayBuffer());
      this.stats.chunksFromCache++;
      this.stats.bytesCache += b.length;
      return b;
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = new Uint8Array(await r.arrayBuffer());
    this.stats.chunksFetched++;
    this.stats.bytesNetwork += b.length;
    // Chunks are immutable (named by content hash): cache forever.
    this.cache?.put(url, new Response(b, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
    return b;
  }

  private deliver(block: number, bytes: Uint8Array) {
    const p = this.mod._malloc(bytes.length || 1);
    this.mod.HEAPU8.set(bytes, p);
    this.mod._blk_chunk_loaded(block, p, bytes.length);
    this.mod._free(p);
  }

  prefetch(blocks: number[]) {
    for (const b of blocks) this.mod._blk_prefetch(b);
  }

  flush() {
    this.overlay.flush();
  }

  // Delete the user's changes. The VM must be restarted afterwards.
  reset() {
    this.overlay.reset();
    this.mod._blk_overlay_clear();
    this.stats.overlayClusters = 0;
  }
}
