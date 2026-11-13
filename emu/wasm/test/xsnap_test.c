/*
 * Native unit test for xsnap.h: a save that runs out of memory must fail
 * cleanly (error set, old buffer kept) instead of writing through NULL.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* A realloc that starts failing once `fail_after` calls have succeeded.
   Defined before the include so xsnap.h picks it up. */
static int fail_after = -1, calls = 0;
static void *test_realloc(void *p, size_t n)
{
    if (fail_after >= 0 && calls++ >= fail_after)
        return NULL;
    return realloc(p, n);
}
#define XSNAP_REALLOC test_realloc
#include "xsnap.h"

#define MB (1024u * 1024u)
#define PIECE (64u * 1024u)

#define CHECK(cond, what)                                                    \
    do {                                                                     \
        if (!(cond)) {                                                       \
            printf("FAIL: %s (%s)\n", (what), #cond);                        \
            return 1;                                                        \
        }                                                                    \
    } while (0)

static void fill_piece(uint8_t *piece, size_t offset)
{
    size_t i;
    for (i = 0; i < PIECE; i++)
        piece[i] = (uint8_t)((offset + i) * 31u + 7u);
}

/* Write total bytes in PIECE-sized chunks of a position-dependent pattern. */
static void write_all(XSnap *sn, size_t total)
{
    static uint8_t piece[PIECE];
    size_t off;
    for (off = 0; off < total; off += PIECE) {
        fill_piece(piece, off);
        xsnap_bytes(sn, piece, PIECE);
    }
}

int main(void)
{
    static uint8_t piece[PIECE];
    XSnap sn, ld;
    size_t off, last_cap, len_before;
    uint32_t tail = 0x01020304;

    /* 1. normal save: 3 MB in 64 KB pieces */
    fail_after = -1;
    calls = 0;
    sn = (XSnap){ .saving = 1 };
    write_all(&sn, 3 * MB);
    CHECK(sn.error == 0, "case 1: no error");
    CHECK(sn.len == 3 * MB, "case 1: len is 3 MB");
    CHECK(sn.buf != NULL && sn.cap >= sn.len, "case 1: buffer holds the data");
    for (off = 0; off < 3 * MB; off += PIECE) {
        fill_piece(piece, off);
        CHECK(memcmp(sn.buf + off, piece, PIECE) == 0, "case 1: contents match");
    }
    free(sn.buf);

    /* 2. out of memory on the second growth */
    fail_after = 1;
    calls = 0;
    sn = (XSnap){ .saving = 1 };
    write_all(&sn, 3 * MB);
    CHECK(sn.error == 1, "case 2: error is set");
    CHECK(sn.buf != NULL, "case 2: old buffer kept");
    CHECK(sn.cap == 1 * MB, "case 2: cap is the last successful one");
    CHECK(sn.len <= sn.cap, "case 2: len within the last successful cap");
    for (off = 0; off < sn.len; off += PIECE) {
        fill_piece(piece, off);
        CHECK(memcmp(sn.buf + off, piece, PIECE) == 0, "case 2: kept data intact");
    }

    /* 3. after an error, further writes are no-ops (even ones that would fit) */
    last_cap = sn.cap;
    len_before = sn.len;
    xsnap_bytes(&sn, &tail, sizeof(tail));
    write_all(&sn, 3 * MB);
    CHECK(sn.error == 1, "case 3: error stays set");
    CHECK(sn.len == len_before, "case 3: len unchanged");
    CHECK(sn.cap == last_cap, "case 3: cap unchanged");
    free(sn.buf);

    /* the very first allocation failing leaves an empty, freeable state */
    fail_after = 0;
    calls = 0;
    sn = (XSnap){ .saving = 1 };
    xsnap_bytes(&sn, &tail, sizeof(tail));
    CHECK(sn.error == 1, "first allocation: error is set");
    CHECK(sn.buf == NULL && sn.len == 0, "first allocation: nothing written");
    free(sn.buf);

    /* 4. load path unchanged: u64 round trip, overrun sets error */
    fail_after = -1;
    calls = 0;
    sn = (XSnap){ .saving = 1 };
    xsnap_u64(&sn, 0x1122334455667788ULL);
    CHECK(sn.error == 0 && sn.len == 8, "case 4: saved one u64");
    ld = (XSnap){ .saving = 0, .buf = sn.buf, .len = sn.len };
    CHECK(xsnap_u64(&ld, 0) == 0x1122334455667788ULL, "case 4: round trip");
    CHECK(ld.error == 0 && ld.pos == 8, "case 4: no error after a full read");
    CHECK(xsnap_u64(&ld, 0) == 0, "case 4: read past len returns 0");
    CHECK(ld.error == 1, "case 4: read past len sets error");
    free(sn.buf);

    /* 5. size overflow is an error, not a wrap-around */
    sn = (XSnap){ .saving = 1 };
    CHECK(xsnap_reserve(&sn, SIZE_MAX) < 0 && sn.error == 1,
          "case 5: n > SIZE_MAX - len");
    CHECK(sn.buf == NULL, "case 5: nothing allocated");
    sn = (XSnap){ .saving = 1 };
    CHECK(xsnap_reserve(&sn, SIZE_MAX / 2 + 2) < 0 && sn.error == 1,
          "case 5: capacity doubling overflow");
    CHECK(sn.buf == NULL, "case 5: nothing allocated for doubling overflow");

    puts("ok");
    return 0;
}
