/*
 * xiaonux: overflow-safe range check for block requests (no dependencies,
 * so it can be unit-tested natively).
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef BLK_RANGE_H
#define BLK_RANGE_H
#include <stdint.h>

/* 1 if sectors [sector, sector + n) lie inside a device of 'count' sectors. */
static inline int blk_range_ok(uint64_t sector, int n, uint64_t count)
{
    return n >= 0 && sector <= count && (uint64_t)n <= count - sector;
}
#endif
