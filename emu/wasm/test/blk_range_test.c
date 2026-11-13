/*
 * xiaonux: native unit test for blk_range_ok() (emu/wasm/blk_range.h).
 * Build: cc -std=c11 -Wall -Wextra -Werror -Iemu/wasm -o build/blk_range_test emu/wasm/test/blk_range_test.c
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdio.h>
#include <stdint.h>
#include "blk_range.h"

#define COUNT 1024

#define CHECK(sector, n, count, want)                                        \
    do {                                                                     \
        int got_ = blk_range_ok((sector), (n), (count));                     \
        if (got_ != (want)) {                                                \
            printf("FAIL: blk_range_ok(%s, %s, %s) = %d, want %d\n",         \
                   #sector, #n, #count, got_, (want));                       \
            return 1;                                                        \
        }                                                                    \
    } while (0)

int main(void)
{
    CHECK(0, 8, COUNT, 1);
    CHECK(1016, 8, COUNT, 1);
    CHECK(1017, 8, COUNT, 0);
    CHECK(1024, 1, COUNT, 0);

    /* empty requests stay valid while sector <= count */
    CHECK(0, 0, COUNT, 1);
    CHECK(1024, 0, COUNT, 1);
    CHECK(1025, 0, COUNT, 0);
    CHECK(0, -1, COUNT, 0);

    /* wraparound: sector + n == 0 in uint64_t */
    CHECK(UINT64_MAX - 7, 8, COUNT, 0);
    CHECK(UINT64_MAX, 1, COUNT, 0);
    CHECK(1ULL << 63, 8, COUNT, 0);

    /* empty device */
    CHECK(0, 1, 0, 0);

    puts("ok");
    return 0;
}
