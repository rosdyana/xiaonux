/*
 * xiaonux: native unit test for the PLIC (emu/tinyemu/xn_plic.c).
 * The .c file is included directly. cpu_register_device is stubbed so the
 * test drives the registered read/write callbacks, and the output callback
 * records the MEIP/SEIP levels instead of touching a CPU.
 * Build: cc -std=c11 -Wall -Wextra -Werror -Iemu/compat -Iemu/tinyemu -o build/xn_plic_test emu/wasm/test/xn_plic_test.c
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdio.h>
#include "xn_plic.c"

#define CHECK(cond, what)                                                    \
    do {                                                                     \
        if (!(cond)) {                                                       \
            printf("FAIL: %s (%s)\n", (what), #cond);                        \
            return 1;                                                        \
        }                                                                    \
    } while (0)

#define CHECK_EQ(got, want, what)                                            \
    do {                                                                     \
        unsigned long g_ = (unsigned long)(got);                             \
        unsigned long w_ = (unsigned long)(want);                            \
        if (g_ != w_) {                                                      \
            printf("FAIL: %s: got 0x%lx, want 0x%lx\n", (what), g_, w_);     \
            return 1;                                                        \
        }                                                                    \
    } while (0)

#define PLIC_BASE 0x0c000000u
#define PRIO(i) (4u * (i))
#define PENDING 0x001000u
#define EN(c) (0x002000u + 0x80u * (c))
#define THR(c) (0x200000u + 0x1000u * (c))
#define CLAIM(c) (THR(c) + 4u)

/* Captured from xn_plic_init's cpu_register_device call. */
static DeviceReadFunc *dev_read;
static DeviceWriteFunc *dev_write;
static void *dev_opaque;
static uint64_t dev_addr, dev_size;
static int dev_flags;

PhysMemoryRange *cpu_register_device(PhysMemoryMap *s, uint64_t addr,
                                     uint64_t size, void *opaque,
                                     DeviceReadFunc *read_func,
                                     DeviceWriteFunc *write_func,
                                     int devio_flags)
{
    (void)s;
    dev_addr = addr;
    dev_size = size;
    dev_opaque = opaque;
    dev_read = read_func;
    dev_write = write_func;
    dev_flags = devio_flags;
    return NULL;
}

/* Output recorder: last level seen on MEIP and SEIP. */
static int meip, seip, bad_mask;

static void fake_out(void *op, uint32_t mip_mask, int level)
{
    (void)op;
    if (mip_mask == XN_PLIC_MIP_MEIP)
        meip = level != 0;
    else if (mip_mask == XN_PLIC_MIP_SEIP)
        seip = level != 0;
    else
        bad_mask = 1;
}

static XNPlic *plic;

/* Fresh device with no sources pending and both outputs low. */
static void new_plic(void)
{
    plic = xn_plic_init(NULL, PLIC_BASE, fake_out, NULL);
    meip = 0;
    seip = 0;
    bad_mask = 0;
}

static uint32_t rd(uint32_t off)
{
    return dev_read(dev_opaque, off, 0);
}

static void wr(uint32_t off, uint32_t val)
{
    dev_write(dev_opaque, off, val, 0);
}

static void setirq(int irq, int level)
{
    xn_plic_set_irq(plic, irq, level);
}

int main(void)
{
    /* 0. registration: 4 MB window, 32-bit registers */
    new_plic();
    CHECK(plic != NULL, "init returns a device");
    CHECK_EQ(dev_addr, PLIC_BASE, "registered at 0x0c000000");
    CHECK_EQ(dev_size, 0x400000, "registered size is 0x400000");
    CHECK_EQ(dev_flags, DEVIO_SIZE32, "registered as 32-bit");

    /* 1. priorities: 3 bits, source 0 reserved */
    CHECK_EQ(rd(PRIO(5)), 0, "priority resets to 0");
    wr(PRIO(5), 0xFFFFFFFF);
    CHECK_EQ(rd(PRIO(5)), 7, "priority is 3 bits");
    wr(PRIO(0), 5);
    CHECK_EQ(rd(PRIO(0)), 0, "source 0 priority reads 0");
    wr(PRIO(5), 3);

    /* 2. priority and threshold filtering on S-mode context 1 */
    wr(EN(1), 1u << 5);
    CHECK_EQ(rd(EN(1)), 1u << 5, "enable readback");
    setirq(5, 1);
    CHECK_EQ(seip, 1, "priority 3 > threshold 0 raises SEIP");
    CHECK_EQ(rd(PENDING), 1u << 5, "pending bit shows the level");
    wr(THR(1), 3);
    CHECK_EQ(rd(THR(1)), 3, "threshold readback");
    CHECK_EQ(seip, 0, "priority equal to threshold does not qualify");
    wr(THR(1), 2);
    CHECK_EQ(seip, 1, "priority above threshold qualifies");
    wr(PRIO(5), 0);
    CHECK_EQ(seip, 0, "priority 0 never qualifies");
    wr(PRIO(5), 3);
    CHECK_EQ(seip, 1, "restoring priority restores SEIP");
    wr(THR(1), 0xF);
    CHECK_EQ(rd(THR(1)), 7, "threshold is 3 bits");
    CHECK_EQ(seip, 0, "threshold 7 blocks everything");
    wr(THR(1), 0);
    wr(PRIO(5), 0);
    CHECK_EQ(seip, 0, "priority 0 with threshold 0 does not qualify");
    wr(PRIO(5), 3);
    CHECK_EQ(seip, 1, "priority 3 with threshold 0 qualifies");
    CHECK_EQ(bad_mask, 0, "only MEIP/SEIP are driven");

    /* 3. enables are per context; bit 0 is not writable */
    CHECK_EQ(meip, 0, "context 0 not enabled, MEIP low");
    wr(EN(0), 1u << 5);
    CHECK_EQ(meip, 1, "enabling in context 0 raises MEIP");
    CHECK_EQ(seip, 1, "context 1 unaffected by context 0 enable");
    wr(EN(0), 0);
    CHECK_EQ(meip, 0, "disabling in context 0 drops MEIP");
    CHECK_EQ(seip, 1, "SEIP still high from context 1");
    wr(EN(1), 0xFFFFFFFF);
    CHECK_EQ(rd(EN(1)), 0xFFFFFFFE, "enable bit 0 is not writable");
    wr(EN(1), 1u << 5);
    CHECK_EQ(rd(EN(1)), 1u << 5, "enable restored");

    /* 4. claim: highest priority, lowest id on ties, in-service blocks re-pend */
    new_plic();
    wr(EN(1), (1u << 3) | (1u << 7) | (1u << 9));
    wr(PRIO(3), 2);
    wr(PRIO(7), 5);
    wr(PRIO(9), 5);
    wr(THR(1), 0);
    setirq(3, 1);
    setirq(7, 1);
    setirq(9, 1);
    CHECK_EQ(rd(CLAIM(1)), 7, "claim returns highest priority, lowest id on tie");
    CHECK_EQ(rd(PENDING), (1u << 3) | (1u << 9), "claimed source is not pending");
    setirq(7, 1);
    CHECK_EQ(rd(PENDING), (1u << 3) | (1u << 9), "re-asserting a claimed source does not re-pend");
    CHECK_EQ(rd(CLAIM(1)), 9, "next claim returns the other priority-5 source");
    CHECK_EQ(rd(CLAIM(1)), 3, "then the priority-2 source");
    CHECK_EQ(rd(CLAIM(1)), 0, "claim returns 0 when nothing is eligible");
    CHECK_EQ(seip, 0, "SEIP low with everything in service");
    CHECK_EQ(meip, 0, "MEIP low for context 0");

    /* 5. complete re-arms the source; an id not enabled in the context is ignored */
    new_plic();
    wr(EN(1), 1u << 7);
    wr(PRIO(7), 4);
    wr(THR(1), 0);
    setirq(7, 1);
    CHECK_EQ(seip, 1, "source 7 raises SEIP");
    CHECK_EQ(rd(CLAIM(1)), 7, "claim source 7");
    CHECK_EQ(seip, 0, "claimed source drops SEIP");
    wr(CLAIM(0), 7);
    CHECK_EQ(rd(PENDING), 0, "complete from a context that does not enable 7 is ignored");
    CHECK_EQ(seip, 0, "SEIP still low after the ignored complete");
    wr(CLAIM(1), 7);
    CHECK_EQ(rd(PENDING), 1u << 7, "complete re-arms the still-asserted source");
    CHECK_EQ(seip, 1, "SEIP high again after complete");
    CHECK_EQ(rd(CLAIM(1)), 7, "claimed again after complete");
    setirq(7, 0);
    CHECK_EQ(seip, 0, "deasserting the level drops SEIP");
    wr(CLAIM(1), 7);
    CHECK_EQ(rd(PENDING), 0, "no pending after the line is low");
    CHECK_EQ(seip, 0, "SEIP stays low");

    /* 6. MEIP tracks context 0 and SEIP tracks context 1, independently */
    new_plic();
    wr(EN(0), 1u << 4);
    wr(EN(1), 1u << 6);
    wr(PRIO(4), 1);
    wr(PRIO(6), 1);
    wr(THR(0), 0);
    wr(THR(1), 0);
    setirq(4, 1);
    CHECK_EQ(meip, 1, "source 4 raises MEIP");
    CHECK_EQ(seip, 0, "source 4 is not enabled for SEIP");
    setirq(6, 1);
    CHECK_EQ(meip, 1, "MEIP still high");
    CHECK_EQ(seip, 1, "source 6 raises SEIP");
    setirq(4, 0);
    CHECK_EQ(meip, 0, "dropping source 4 drops MEIP");
    CHECK_EQ(seip, 1, "SEIP unaffected by source 4");
    setirq(6, 0);
    CHECK_EQ(seip, 0, "dropping source 6 drops SEIP");
    setirq(12, 1);
    CHECK_EQ(meip, 0, "unenabled source 12 does not drive MEIP");
    CHECK_EQ(seip, 0, "unenabled source 12 does not drive SEIP");
    setirq(12, 0);
    wr(THR(0), 0);
    setirq(4, 1);
    CHECK_EQ(meip, 1, "source 4 back on");
    wr(THR(0), 1);
    CHECK_EQ(meip, 0, "threshold equal to priority blocks MEIP");
    wr(THR(0), 0);
    setirq(6, 1);
    CHECK_EQ(seip, 1, "source 6 back on raises SEIP");
    CHECK_EQ(rd(CLAIM(0)), 4, "context 0 claims source 4");
    CHECK_EQ(meip, 0, "claimed source drops MEIP");
    CHECK_EQ(seip, 1, "context 1 still has source 6");
    CHECK_EQ(bad_mask, 0, "only MEIP/SEIP are driven");

    /* 7. out-of-range sources are ignored; unknown offsets read 0, ignore writes */
    new_plic();
    setirq(0, 1);
    setirq(32, 1);
    setirq(-1, 1);
    CHECK_EQ(rd(PENDING), 0, "sources 0, 32 and -1 never pend");
    wr(EN(0), 0xFFFFFFFF);
    CHECK_EQ(rd(EN(0) + 4), 0, "unknown enable word reads 0");
    CHECK_EQ(rd(0x3000), 0, "unknown offset reads 0");
    wr(0x3000, 0xFFFF);
    wr(PENDING, 0xFFFF);
    CHECK_EQ(rd(PENDING), 0, "pending bitmap is read-only");
    CHECK_EQ(rd(0x3000), 0, "unknown offset ignores writes");
    CHECK_EQ(rd(CLAIM(2)), 0, "context 2 does not exist");

    puts("ok");
    return 0;
}
