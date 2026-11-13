/*
 * xiaonux machine snapshots: a tiny symmetric serializer.
 *
 * The same "visit" code saves and loads: XSNAP_U64(sn, x) writes x when
 * saving and assigns x when loading. Every field is stored explicitly as
 * fixed-width little-endian, so a snapshot made by native temu restores in
 * the WASM build (struct layouts and pointer sizes differ).
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef XSNAP_H
#define XSNAP_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define XSNAP_MAGIC "XNXSNAP1"
#define XSNAP_VERSION 1

typedef struct XSnap {
    int saving;          /* 1 = save, 0 = load */
    uint8_t *buf;
    size_t len, cap, pos;
    int error;           /* set on overrun / mismatch when loading, or out of memory when saving */
} XSnap;

#ifndef XSNAP_REALLOC
#define XSNAP_REALLOC realloc   /* tests override this to simulate OOM */
#endif

/* Returns 0 if n more bytes fit, -1 (and sets error) if memory ran out. */
static inline int xsnap_reserve(XSnap *sn, size_t n)
{
    if (sn->error)
        return -1;
    if (n > SIZE_MAX - sn->len) {
        sn->error = 1;
        return -1;
    }
    if (sn->len + n > sn->cap) {
        size_t cap = sn->cap ? sn->cap : (1 << 20);
        uint8_t *nb;
        while (cap < sn->len + n) {
            if (cap > SIZE_MAX / 2) { sn->error = 1; return -1; }
            cap *= 2;
        }
        nb = XSNAP_REALLOC(sn->buf, cap);
        if (!nb) {
            sn->error = 1;     /* keep the old buffer: the caller frees it */
            return -1;
        }
        sn->buf = nb;
        sn->cap = cap;
    }
    return 0;
}

static inline void xsnap_bytes(XSnap *sn, void *p, size_t n)
{
    if (sn->saving) {
        if (xsnap_reserve(sn, n) < 0)
            return;
        memcpy(sn->buf + sn->len, p, n);
        sn->len += n;
    } else {
        if (sn->error || sn->pos + n > sn->len) {
            sn->error = 1;
            memset(p, 0, n);
            return;
        }
        memcpy(p, sn->buf + sn->pos, n);
        sn->pos += n;
    }
}

static inline uint64_t xsnap_u64(XSnap *sn, uint64_t v)
{
    xsnap_bytes(sn, &v, 8);
    return v;
}

/* Visit a field of any integer type as u64. */
#define XSNAP_U64(sn, field) ((field) = (__typeof__(field))xsnap_u64((sn), (uint64_t)(field)))

/* A section tag: saved as 4 bytes, checked on load. */
static inline void xsnap_tag(XSnap *sn, const char tag[4])
{
    char t[4];
    memcpy(t, tag, 4);
    xsnap_bytes(sn, t, 4);
    if (!sn->saving && memcmp(t, tag, 4) != 0)
        sn->error = 1;
}

#endif /* XSNAP_H */
