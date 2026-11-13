/// <reference lib="webworker" />
// Phase 2 disk: content-addressed Brotli chunks (decoded in WASM) plus a
// copy-on-write overlay of 4 KB clusters kept in OPFS.

const CLUSTER = 4096;
const CACHE_NAME = 'xiaonux-chunks-v1';
/** Pauses before the 2nd and 3rd attempt of a chunk download. */
const RETRY_DELAYS_MS = [250, 1000];

/** A static host's "not found" page served with 200 must never be cached as data. */
export function looksLikeHtml(r: Response): boolean {
  return (r.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

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
  /** hash indexes in first-fetch order (for building prefetch bundles) */
  fetchOrder?: number[];
}

// Overlay storage (OPFS):
//   index   u32 per 4 KB cluster: slot+1, 0 = absent (the live disk)
//   data    4 KB slots
//   snapN / sidxN (N = 0, 1)  a saved machine + the index as it was then
//   state   u32[3]: valid, active save (0/1), slots in use at that save
// Slots at or below the save point are never overwritten: a cluster
// written after a save gets a new slot. Resuming a save rolls the index
// back to it, so the disk always matches the saved RAM. Saves alternate
// between two files and flip 'state' last, so a torn save keeps the old one.
interface Overlay {
  backend: 'opfs' | 'memory';
  has(cluster: number): boolean;
  read(cluster: number, dst: Uint8Array): boolean;
  write(cluster: number, src: Uint8Array): void;
  flush(): void;
  clusters(): number[];
  reset(): void;
  hasSave(): boolean;
  /** Roll the disk back to the last save and return that machine. */
  rollbackToSave(): Uint8Array | null;
  save(machine: Uint8Array): void;
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
    hasSave: () => false,
    rollbackToSave: () => null,
    save: () => {},
  };
}

async function opfsOverlay(name: string, nClusters: number): Promise<Overlay> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(name, { create: true });
  const open = async (f: string) => (await dir.getFileHandle(f, { create: true })).createSyncAccessHandle();
  const idxH = await open('index');
  const datH = await open('data');
  const stH = await open('state');
  const snapH = [await open('snap0'), await open('snap1')];
  const sidxH = [await open('sidx0'), await open('sidx1')];

  const index = new Uint32Array(nClusters);
  idxH.read(new Uint8Array(index.buffer), { at: 0 });
  let slots = Math.floor(datH.getSize() / CLUSTER);
  // An index entry past the data file is from a torn write: drop it.
  for (let i = 0; i < nClusters; i++) if (index[i] > slots) index[i] = 0;
  const state = new Uint32Array(3); // valid, active, savedSlots
  stH.read(new Uint8Array(state.buffer), { at: 0 });
  let savedSlots = state[0] ? state[2] : 0;
  const entry = new Uint32Array(1);
  let dirty = false;

  const writeIndexEntry = (c: number) => {
    entry[0] = index[c];
    idxH.write(new Uint8Array(entry.buffer), { at: c * 4 });
  };

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
      if (s && s > savedSlots) {
        datH.write(src, { at: (s - 1) * CLUSTER }); // written since the save
      } else {
        s = ++slots; // keep the saved version intact
        datH.write(src, { at: (s - 1) * CLUSTER });
        index[c] = s;
        writeIndexEntry(c); // data before index: a torn write is dropped on load
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
      slots = savedSlots = 0;
      state.fill(0);
      stH.write(new Uint8Array(state.buffer), { at: 0 });
      for (const h of [idxH, datH, ...snapH, ...sidxH]) h.truncate(0);
      for (const h of [idxH, datH, stH, ...snapH, ...sidxH]) h.flush();
    },
    hasSave: () => state[0] === 1 && snapH[state[1]].getSize() > 0,
    rollbackToSave() {
      if (!(state[0] === 1)) return null;
      const a = state[1];
      const n = snapH[a].getSize();
      if (!n) return null;
      const machine = new Uint8Array(n);
      snapH[a].read(machine, { at: 0 });
      index.fill(0);
      sidxH[a].read(new Uint8Array(index.buffer), { at: 0 });
      slots = savedSlots = state[2];
      idxH.write(new Uint8Array(index.buffer), { at: 0 });
      idxH.flush();
      return machine;
    },
    save(machine) {
      // 1. everything the machine has written so far is on storage
      datH.flush();
      idxH.flush();
      dirty = false;
      // 2. machine + index into the inactive pair
      const b = state[0] === 1 ? 1 - state[1] : 0;
      snapH[b].truncate(0);
      snapH[b].write(machine, { at: 0 });
      sidxH[b].truncate(0);
      sidxH[b].write(new Uint8Array(index.buffer), { at: 0 });
      snapH[b].flush();
      sidxH[b].flush();
      // 3. flip
      state[0] = 1;
      state[1] = b;
      state[2] = slots;
      stH.write(new Uint8Array(state.buffer), { at: 0 });
      stH.flush();
      savedSlots = slots;
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
  /** URLs whose cached copy C rejected: the next download bypasses every cache */
  private refetch = new Set<string>();
  /** URLs already re-requested at once after a rejection (one retry each) */
  private retried = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** overlay changed since the last user snapshot */
  changedSinceSave = false;
  /** called after every overlay write (the worker schedules saves) */
  onWrite: () => void = () => {};
  /**
   * Whether changes survive a reload: 'opfs' = yes; 'other-tab' = another tab
   * holds the storage files (only one tab can); 'unavailable' = the browser
   * gave no storage, so this tab runs on an in-memory disk.
   */
  persistence: 'opfs' | 'other-tab' | 'unavailable' = 'unavailable';
  /** Set once a reset starts: late chunk deliveries and writes are dropped. */
  private frozen = false;

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
      this.persistence = 'opfs';
    } catch (e) {
      this.onEvent(`OPFS unavailable (${e}); changes won't survive a reload`);
      this.persistence = (e as DOMException)?.name === 'NoModificationAllowedError' ? 'other-tab' : 'unavailable';
      this.overlay = memoryOverlay();
    }
    this.stats.overlayBackend = this.overlay.backend;
    try {
      this.cache = await caches.open(CACHE_NAME);
    } catch {
      this.cache = null; // e.g. opaque origin; fetch straight from the network
    }
  }

  /**
   * Decide what this visit resumes. With a saved machine, the disk is rolled
   * back to it and the machine is returned; otherwise null (cold boot or the
   * shipped snapshot, on the live overlay). Must be called before the VM runs.
   */
  open(resume: boolean): Uint8Array | null {
    const machine = resume ? this.overlay.rollbackToSave() : null;
    const clusters = this.overlay.clusters();
    for (const c of clusters) this.mod._blk_overlay_mark(c);
    this.stats.overlayClusters = clusters.length;
    return machine;
  }

  get hasUserData() {
    return this.stats.overlayClusters > 0;
  }

  // ----- callbacks from C (via lib.js) -----

  /** hash -> bytes promise for chunks in the prefetch bundle */
  private bundled = new Map<string, Promise<Uint8Array | null>>();
  record = false;

  fetchChunk = (block: number, hashIndex: number) => {
    if (this.frozen) return;
    const hash = this.manifest.hashes[hashIndex];
    const url = `${this.base}chunks/${hash}.br`;
    if (this.record) (this.stats.fetchOrder ??= []).push(hashIndex);
    const fromBundle = this.refetch.has(url) ? undefined : this.bundled.get(hash);
    (fromBundle ? fromBundle.then((b) => b ?? this.getChunk(url)) : this.getChunk(url))
      .then((bytes) => this.deliver(block, bytes))
      .catch((e) => {
        if (this.frozen) return;
        this.stats.errors++;
        this.onEvent(`chunk ${block}: ${e}`);
        this.mod._blk_chunk_loaded(block, 0, 0);
      });
  };

  overlayRead = (cluster: number, ptr: number) =>
    this.overlay.read(cluster, this.mod.HEAPU8.subarray(ptr, ptr + CLUSTER));

  overlayWrite = (cluster: number, ptr: number) => {
    // After a reset starts, nothing may reach the (now empty) overlay: a write
    // that waited on a chunk download would put a stale cluster into it.
    if (this.frozen) return true;
    this.changedSinceSave = true;
    const isNew = !this.overlay.has(cluster);
    this.overlay.write(cluster, this.mod.HEAPU8.subarray(ptr, ptr + CLUSTER));
    if (isNew) this.stats.overlayClusters++;
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.overlay.flush();
      }, 500);
    }
    this.onWrite();
    return true;
  };

  event = (kind: number, block: number, value: number) => {
    if (kind === 2) this.onEvent(`chunk ${block}: hash mismatch`);
    if (kind === 3) this.onEvent(`chunk ${block}: decode error ${value}`);
    if (kind !== 1) this.stats.errors++;
    // C rejected the bytes JS handed over (kind 3 with -1 only means the fetch failed)
    if (kind === 2 || (kind === 3 && value !== -1)) this.recover(block);
  };

  /**
   * A bad copy must not be served again: drop it from Cache Storage and make
   * the next download skip the HTTP cache too. C has already cleared this
   * block's loading flag but not yet failed the waiting guest request, so
   * asking for the block again now keeps that request waiting for a good
   * copy. Once per URL: a chunk that is bad twice becomes an I/O error.
   */
  private recover(block: number) {
    const k = this.manifest.map[block];
    if (!k) return;
    const url = `${this.base}chunks/${this.manifest.hashes[k - 1]}.br`;
    this.cache?.delete(url).catch(() => {});
    this.refetch.add(url);
    if (this.retried.has(url)) return;
    this.retried.add(url);
    this.mod._blk_prefetch(block);
  }

  // ----- helpers -----

  private async getChunk(url: string): Promise<Uint8Array> {
    const reload = this.refetch.has(url);
    const hit = this.cache && !reload ? await this.cache.match(url) : undefined;
    if (hit) {
      const b = new Uint8Array(await hit.arrayBuffer());
      this.stats.chunksFromCache++;
      this.stats.bytesCache += b.length;
      return b;
    }
    const b = await this.download(url, reload);
    this.refetch.delete(url);
    this.stats.chunksFetched++;
    this.stats.bytesNetwork += b.length;
    // Chunks are immutable (named by content hash): cache forever.
    this.cache?.put(url, new Response(b, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
    return b;
  }

  /** Up to 3 attempts: network errors and 5xx are retried, a 4xx or an HTML page is not. */
  private async download(url: string, reload: boolean): Promise<Uint8Array<ArrayBuffer>> {
    for (let attempt = 0; ; attempt++) {
      let retryable = true;
      try {
        const r = await fetch(url, reload ? { cache: 'reload' } : undefined);
        if (!r.ok) {
          retryable = r.status >= 500;
          throw new Error(`HTTP ${r.status}`);
        }
        if (looksLikeHtml(r)) {
          retryable = false;
          throw new Error('got an HTML page instead of a chunk');
        }
        return new Uint8Array(await r.arrayBuffer());
      } catch (e) {
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw e;
        await new Promise((done) => setTimeout(done, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  private deliver(block: number, bytes: Uint8Array) {
    if (this.frozen) return;
    const p = this.mod._malloc(bytes.length || 1);
    this.mod.HEAPU8.set(bytes, p);
    this.mod._blk_chunk_loaded(block, p, bytes.length);
    this.mod._free(p);
  }

  /**
   * Fetch a prefetch bundle (chunks concatenated in first-use order) in one
   * request and put each chunk in Cache Storage. Chunk fetches that arrive
   * meanwhile wait for the bundle instead of making their own request.
   */
  async prefetchBundle(file: string, index: [string, number, number][]) {
    const missing: [string, number, number][] = [];
    for (const e of index) {
      const url = `${this.base}chunks/${e[0]}.br`;
      if (!(this.cache && (await this.cache.match(url)))) missing.push(e);
    }
    if (!missing.length) return 0;
    const resolvers = new Map<string, (b: Uint8Array | null) => void>();
    for (const [h] of missing) this.bundled.set(h, new Promise((r) => resolvers.set(h, r)));
    let bytes = 0;
    try {
      const r = await fetch(this.base + file, { priority: 'low' } as RequestInit);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (looksLikeHtml(r)) throw new Error('got an HTML page instead of the bundle');
      const all = new Uint8Array(await r.arrayBuffer());
      bytes = all.length;
      this.stats.bytesNetwork += bytes;
      for (const [h, off, len] of missing) {
        const b = all.slice(off, off + len);
        this.cache?.put(`${this.base}chunks/${h}.br`, new Response(b)).catch(() => {});
        resolvers.get(h)!(b);
      }
    } catch (e) {
      this.onEvent(`prefetch bundle: ${e}`);
      for (const r of resolvers.values()) r(null); // fall back to single fetches
    } finally {
      for (const [h] of missing) this.bundled.delete(h);
    }
    return bytes;
  }

  flush() {
    this.overlay.flush();
  }

  /** Store a machine saved while the guest was paused. */
  saveUserSnapshot(machine: Uint8Array) {
    this.overlay.save(machine);
    this.changedSinceSave = false;
  }

  get canSaveSnapshots() {
    return this.overlay.backend === 'opfs';
  }

  /**
   * Stop touching the overlay for good: call before reset(). Chunk downloads
   * still in flight are dropped, so a guest write waiting on one can't finish
   * into the emptied overlay. Harmless because the page reloads after a reset.
   */
  freeze() {
    this.frozen = true;
  }

  // Delete the user's changes. The VM must be restarted afterwards.
  reset() {
    this.overlay.reset();
    this.mod._blk_overlay_clear();
    this.stats.overlayClusters = 0;
  }
}
