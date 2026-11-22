/*
 * xiaonux: in-memory block device for the xv6-virt page runner.
 *
 * The whole disk image lives in one malloc'd buffer that the device owns.
 * Every request completes synchronously (returns 0), so the virtio layer
 * never waits on the host. One device per page; vm_start_mem is one-shot.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "cutils.h"
#include "virtio.h"
#include "blk_range.h"

#define SECTOR_SIZE 512

static uint8_t *mem_buf;
static int64_t mem_len;
static BlockDevice mem_bs;

static int64_t mem_get_sector_count(BlockDevice *bs)
{
    return mem_len / SECTOR_SIZE;
}

/* n counts sectors, as in every BlockDevice request. */
static int mem_read_async(BlockDevice *bs, uint64_t sector, uint8_t *buf, int n,
                          BlockDeviceCompletionFunc *cb, void *opaque)
{
    if (n <= 0 || !blk_range_ok(sector, n, (uint64_t)mem_get_sector_count(bs)))
        return -1;
    memcpy(buf, mem_buf + sector * SECTOR_SIZE, (size_t)n * SECTOR_SIZE);
    return 0;
}

static int mem_write_async(BlockDevice *bs, uint64_t sector, const uint8_t *buf, int n,
                           BlockDeviceCompletionFunc *cb, void *opaque)
{
    if (n <= 0 || !blk_range_ok(sector, n, (uint64_t)mem_get_sector_count(bs)))
        return -1;
    memcpy(mem_buf + sector * SECTOR_SIZE, buf, (size_t)n * SECTOR_SIZE);
    return 0;
}

/* Takes ownership of buf (malloc'd, len bytes). */
BlockDevice *blk_mem_device(uint8_t *buf, int64_t len)
{
    mem_buf = buf;
    mem_len = len;
    mem_bs.get_sector_count = mem_get_sector_count;
    mem_bs.read_async = mem_read_async;
    mem_bs.write_async = mem_write_async;
    mem_bs.opaque = NULL;
    return &mem_bs;
}

/* Current disk contents (the device's own buffer), or NULL if none. */
uint8_t *blk_mem_data(int64_t *plen)
{
    *plen = mem_buf ? mem_len : 0;
    return mem_buf;
}
