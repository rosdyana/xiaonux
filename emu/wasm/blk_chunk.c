/*
 * xiaonux chunked block device (Phase 2).
 *
 * Base image: fixed-size blocks (256 KB), each either all-zero or a
 * content-addressed Brotli chunk named by the SHA-256 of its decoded bytes.
 * Decoded blocks live in a small LRU cache in the WASM heap. A missing block
 * is fetched by JS (Cache Storage, then network); JS hands the compressed
 * bytes back through blk_chunk_loaded(), which decodes, verifies the hash and
 * resumes the waiting request.
 *
 * Writes go to a copy-on-write overlay with 4 KB clusters. The overlay itself
 * lives on the JS side (OPFS sync access handle, or memory) and is accessed
 * synchronously; C only keeps a bitmap of which clusters are present.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include <assert.h>
#include <emscripten.h>

#include "cutils.h"
#include "virtio.h"
#include "sha256.h"
#include "blk_range.h"
#include <brotli/decode.h>

#define SECTOR_SIZE 512
#define CLUSTER_SIZE 4096
#define SECTORS_PER_CLUSTER (CLUSTER_SIZE / SECTOR_SIZE)

/* provided in lib.js */
extern void js_fetch_chunk(int block, int hash_index);
extern int js_overlay_read(uint32_t cluster, uint8_t *buf);
extern void js_overlay_write(uint32_t cluster, const uint8_t *buf);
extern void js_disk_event(int kind, int block, int value);

enum { EV_FETCH_DONE = 1, EV_BAD_HASH = 2, EV_DECODE_ERROR = 3 };

typedef struct CacheEntry {
    int block;               /* -1 when free */
    uint8_t *data;
    struct CacheEntry *prev, *next;  /* LRU list, most recent first */
} CacheEntry;

typedef struct {
    uint32_t block_size;      /* bytes */
    uint32_t n_blocks;
    uint32_t *map;            /* per block: 0 = zero, k = hashes[k-1] */
    uint8_t *hashes;          /* 32 bytes each */
    uint32_t n_hashes;
    uint8_t *loading;         /* per block: fetch in flight */

    uint8_t *overlay_bits;    /* per 4 KB cluster */
    uint32_t n_clusters;
    uint32_t n_overlay;

    CacheEntry *entries;
    int n_entries;
    CacheEntry *lru_head, *lru_tail;
    CacheEntry **by_block;    /* block -> entry (or NULL) */

    /* the one request virtio-blk may have in flight */
    BOOL req_active;
    BOOL req_is_write;
    uint64_t req_sector;      /* next sector to process */
    int req_left;             /* sectors left */
    uint8_t *req_buf;         /* read: guest buffer; write: our copy */
    uint8_t *req_buf_base;
    BlockDeviceCompletionFunc *req_cb;
    void *req_opaque;
    int req_wait_block;       /* block we wait on, -1 if none */

    uint64_t stat_fetched, stat_cache_hits, stat_cache_misses;
} ChunkDisk;

static ChunkDisk g_disk;
static BlockDevice g_bs;

/* ---------- block cache ---------- */

static void lru_unlink(ChunkDisk *d, CacheEntry *e)
{
    if (e->prev) e->prev->next = e->next; else d->lru_head = e->next;
    if (e->next) e->next->prev = e->prev; else d->lru_tail = e->prev;
    e->prev = e->next = NULL;
}

static void lru_push_front(ChunkDisk *d, CacheEntry *e)
{
    e->prev = NULL;
    e->next = d->lru_head;
    if (d->lru_head) d->lru_head->prev = e;
    d->lru_head = e;
    if (!d->lru_tail) d->lru_tail = e;
}

static const uint8_t *cache_get(ChunkDisk *d, int block)
{
    CacheEntry *e = d->by_block[block];
    if (!e) {
        d->stat_cache_misses++;
        return NULL;
    }
    d->stat_cache_hits++;
    if (d->lru_head != e) {
        lru_unlink(d, e);
        lru_push_front(d, e);
    }
    return e->data;
}

/* returns a buffer to fill for 'block', evicting the LRU entry */
static uint8_t *cache_alloc(ChunkDisk *d, int block)
{
    CacheEntry *e = d->lru_tail;
    if (e->block >= 0)
        d->by_block[e->block] = NULL;
    lru_unlink(d, e);
    e->block = block;
    d->by_block[block] = e;
    lru_push_front(d, e);
    return e->data;
}

static void cache_drop(ChunkDisk *d, int block)
{
    CacheEntry *e = d->by_block[block];
    if (!e) return;
    d->by_block[block] = NULL;
    e->block = -1;
    lru_unlink(d, e);
    /* free entries go to the tail so they are reused first */
    e->prev = d->lru_tail;
    e->next = NULL;
    if (d->lru_tail) d->lru_tail->next = e; else d->lru_head = e;
    d->lru_tail = e;
}

/* ---------- base image ---------- */

static inline BOOL overlay_has(ChunkDisk *d, uint32_t c)
{
    return (d->overlay_bits[c >> 3] >> (c & 7)) & 1;
}

static inline void overlay_set(ChunkDisk *d, uint32_t c)
{
    if (!overlay_has(d, c)) {
        d->overlay_bits[c >> 3] |= 1 << (c & 7);
        d->n_overlay++;
    }
}

/* Make the base block available. Returns its data, a zero-filled
   pointer for all-zero blocks (*is_zero set), or NULL if a fetch is
   now pending. */
static const uint8_t *base_block(ChunkDisk *d, int block, BOOL *is_zero)
{
    const uint8_t *p;
    *is_zero = FALSE;
    if (d->map[block] == 0) {
        *is_zero = TRUE;
        return NULL;
    }
    p = cache_get(d, block);
    if (p)
        return p;
    if (!d->loading[block]) {
        d->loading[block] = 1;
        js_fetch_chunk(block, d->map[block] - 1);
    }
    return NULL;
}

/* Read one cluster of current disk content into buf.
   Returns 0 when done, 1 if it must wait for 'block' to load. */
static int read_cluster(ChunkDisk *d, uint32_t c, uint8_t *buf, int *wait_block)
{
    uint64_t off;
    int block;
    BOOL is_zero;
    const uint8_t *p;

    if (overlay_has(d, c) && js_overlay_read(c, buf))
        return 0;
    off = (uint64_t)c * CLUSTER_SIZE;
    block = off / d->block_size;
    p = base_block(d, block, &is_zero);
    if (is_zero) {
        memset(buf, 0, CLUSTER_SIZE);
        return 0;
    }
    if (!p) {
        *wait_block = block;
        return 1;
    }
    memcpy(buf, p + (off % d->block_size), CLUSTER_SIZE);
    return 0;
}

/* ---------- request engine ---------- */

/* Process as much of the active request as possible.
   Returns 0 when the request is complete, 1 if waiting on a block,
   -1 if the request is out of range. */
static int process_request(ChunkDisk *d)
{
    uint8_t tmp[CLUSTER_SIZE];

    while (d->req_left > 0) {
        if (d->req_sector >= (uint64_t)d->n_clusters * SECTORS_PER_CLUSTER)
            return -1;   /* cannot happen after start_request's check */
        uint32_t c = d->req_sector / SECTORS_PER_CLUSTER;
        int in_off = d->req_sector % SECTORS_PER_CLUSTER;
        int n = min_int(d->req_left, SECTORS_PER_CLUSTER - in_off);
        int wait = -1;

        if (!d->req_is_write) {
            if (in_off == 0 && n == SECTORS_PER_CLUSTER) {
                if (read_cluster(d, c, d->req_buf, &wait))
                    goto wait_block;
            } else {
                if (read_cluster(d, c, tmp, &wait))
                    goto wait_block;
                memcpy(d->req_buf, tmp + in_off * SECTOR_SIZE, n * SECTOR_SIZE);
            }
        } else {
            if (in_off == 0 && n == SECTORS_PER_CLUSTER) {
                js_overlay_write(c, d->req_buf);
            } else {
                /* partial cluster: read-modify-write */
                if (read_cluster(d, c, tmp, &wait))
                    goto wait_block;
                memcpy(tmp + in_off * SECTOR_SIZE, d->req_buf, n * SECTOR_SIZE);
                js_overlay_write(c, tmp);
            }
            overlay_set(d, c);
        }
        d->req_sector += n;
        d->req_left -= n;
        d->req_buf += n * SECTOR_SIZE;
        continue;
    wait_block:
        d->req_wait_block = wait;
        return 1;
    }
    d->req_wait_block = -1;
    return 0;
}

static void finish_request(ChunkDisk *d, int ret)
{
    BlockDeviceCompletionFunc *cb = d->req_cb;
    void *opaque = d->req_opaque;
    if (d->req_is_write)
        free(d->req_buf_base);
    d->req_active = FALSE;
    d->req_buf = d->req_buf_base = NULL;
    if (cb)
        cb(opaque, ret);
}

static int64_t chunk_get_sector_count(BlockDevice *bs)
{
    return (int64_t)g_disk.n_blocks * (g_disk.block_size / SECTOR_SIZE);
}

static int start_request(ChunkDisk *d, BOOL is_write, uint64_t sector,
                         uint8_t *buf, int n,
                         BlockDeviceCompletionFunc *cb, void *opaque)
{
    int r;

    if (!blk_range_ok(sector, n, (uint64_t)chunk_get_sector_count(&g_bs)))
        return -1;
    assert(!d->req_active);
    d->req_active = TRUE;
    d->req_is_write = is_write;
    d->req_sector = sector;
    d->req_left = n;
    d->req_buf = d->req_buf_base = buf;
    d->req_cb = NULL;
    d->req_opaque = NULL;
    r = process_request(d);
    if (r < 0) {
        /* buf is still virtio's own buffer here, so do not free it */
        d->req_active = FALSE;
        d->req_buf = d->req_buf_base = NULL;
        return -1;
    }
    if (r == 0) {
        d->req_active = FALSE;
        d->req_buf = d->req_buf_base = NULL;
        return 0;  /* completed synchronously */
    }
    /* goes async: keep our own copy of write data (virtio frees it) */
    if (is_write) {
        size_t len = (size_t)d->req_left * SECTOR_SIZE;
        uint8_t *copy = malloc(len);
        memcpy(copy, d->req_buf, len);
        d->req_buf = d->req_buf_base = copy;
    }
    d->req_cb = cb;
    d->req_opaque = opaque;
    return 1;
}

static int chunk_read_async(BlockDevice *bs, uint64_t sector, uint8_t *buf,
                            int n, BlockDeviceCompletionFunc *cb, void *opaque)
{
    return start_request(&g_disk, FALSE, sector, buf, n, cb, opaque);
}

static int chunk_write_async(BlockDevice *bs, uint64_t sector,
                             const uint8_t *buf, int n,
                             BlockDeviceCompletionFunc *cb, void *opaque)
{
    return start_request(&g_disk, TRUE, sector, (uint8_t *)buf, n, cb, opaque);
}

/* ---------- JS entry points ---------- */

/* Set up the device from a parsed manifest. 'map' has n_blocks entries,
   'hashes' n_hashes*32 bytes; both are copied. */
EMSCRIPTEN_KEEPALIVE int blk_chunk_setup(uint32_t block_size, uint32_t n_blocks,
                                         const uint32_t *map,
                                         const uint8_t *hashes, uint32_t n_hashes,
                                         int cache_mb)
{
    ChunkDisk *d = &g_disk;
    int i;

    if (block_size % CLUSTER_SIZE != 0 || n_blocks == 0)
        return -1;
    memset(d, 0, sizeof(*d));
    d->block_size = block_size;
    d->n_blocks = n_blocks;
    d->map = malloc(n_blocks * sizeof(uint32_t));
    memcpy(d->map, map, n_blocks * sizeof(uint32_t));
    d->n_hashes = n_hashes;
    d->hashes = malloc(n_hashes * 32);
    memcpy(d->hashes, hashes, n_hashes * 32);
    d->loading = mallocz(n_blocks);
    d->n_clusters = (uint64_t)n_blocks * block_size / CLUSTER_SIZE;
    d->overlay_bits = mallocz((d->n_clusters + 7) / 8);
    d->by_block = mallocz(n_blocks * sizeof(CacheEntry *));
    d->n_entries = max_int(4, (int)(((uint64_t)cache_mb << 20) / block_size));
    d->entries = mallocz(d->n_entries * sizeof(CacheEntry));
    for (i = 0; i < d->n_entries; i++) {
        d->entries[i].block = -1;
        d->entries[i].data = malloc(block_size);
        lru_push_front(d, &d->entries[i]);
    }
    d->req_wait_block = -1;
    g_bs.get_sector_count = chunk_get_sector_count;
    g_bs.read_async = chunk_read_async;
    g_bs.write_async = chunk_write_async;
    g_bs.opaque = d;
    return 0;
}

BlockDevice *blk_chunk_device(void)
{
    return g_disk.n_blocks ? &g_bs : NULL;
}

/* Overlay clusters that already exist (restored from OPFS at startup). */
EMSCRIPTEN_KEEPALIVE void blk_overlay_mark(uint32_t cluster)
{
    if (cluster < g_disk.n_clusters)
        overlay_set(&g_disk, cluster);
}

EMSCRIPTEN_KEEPALIVE void blk_overlay_clear(void)
{
    ChunkDisk *d = &g_disk;
    memset(d->overlay_bits, 0, (d->n_clusters + 7) / 8);
    d->n_overlay = 0;
}

EMSCRIPTEN_KEEPALIVE uint32_t blk_overlay_count(void)
{
    return g_disk.n_overlay;
}

/* JS delivers the compressed chunk for 'block' (data == NULL on fetch
   error). Takes ownership of nothing: JS frees 'data' afterwards. */
EMSCRIPTEN_KEEPALIVE void blk_chunk_loaded(int block, const uint8_t *data, int len)
{
    ChunkDisk *d = &g_disk;
    uint8_t *dst, digest[32];
    size_t out_len;
    BrotliDecoderResult r;

    if (block < 0 || block >= (int)d->n_blocks || !d->loading[block])
        return;
    d->loading[block] = 0;
    if (!data) {
        js_disk_event(EV_DECODE_ERROR, block, -1);
        goto resume;
    }
    dst = cache_alloc(d, block);
    out_len = d->block_size;
    if (len == (int)d->block_size) {
        /* A CDN applied Content-Encoding: br and the browser already
           decoded it. The hash check below still guards the content. */
        memcpy(dst, data, len);
        r = BROTLI_DECODER_RESULT_SUCCESS;
    } else {
        r = BrotliDecoderDecompress(len, data, &out_len, dst);
    }
    if (r != BROTLI_DECODER_RESULT_SUCCESS || out_len != d->block_size) {
        cache_drop(d, block);
        js_disk_event(EV_DECODE_ERROR, block, (int)r);
        goto resume;
    }
    SHA256(dst, d->block_size, digest);
    if (memcmp(digest, d->hashes + (d->map[block] - 1) * 32, 32) != 0) {
        cache_drop(d, block);
        js_disk_event(EV_BAD_HASH, block, 0);
        goto resume;
    }
    d->stat_fetched++;
    js_disk_event(EV_FETCH_DONE, block, len);
 resume:
    if (d->req_active && d->req_wait_block == block) {
        if (!d->loading[block] && !d->by_block[block] && d->map[block] != 0) {
            /* failed: report an I/O error to the guest */
            finish_request(d, -1);
            return;
        }
        int r = process_request(d);
        if (r < 0)
            finish_request(d, -1);
        else if (r == 0)
            finish_request(d, 0);
    }
}

/* Start fetching a block ahead of need (prefetch). */
EMSCRIPTEN_KEEPALIVE void blk_prefetch(int block)
{
    BOOL is_zero;
    if (block >= 0 && block < (int)g_disk.n_blocks)
        base_block(&g_disk, block, &is_zero);
}

EMSCRIPTEN_KEEPALIVE double blk_stat(int which)
{
    switch (which) {
    case 0: return (double)g_disk.stat_fetched;
    case 1: return (double)g_disk.stat_cache_hits;
    case 2: return (double)g_disk.stat_cache_misses;
    case 3: return (double)g_disk.n_overlay;
    default: return 0;
    }
}
