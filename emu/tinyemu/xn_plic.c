/*
 * xiaonux: RISC-V PLIC for the xv6-virt machine profile.
 *
 * Written from the RISC-V PLIC specification. Priorities and thresholds are
 * 3-bit, enables are one 32-bit word per context, and claim picks the highest
 * priority pending source (lowest id on ties). A claimed source is in service
 * and does not pend again until it is completed.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdlib.h>
#include "cutils.h"
#include "iomem.h"
#include "xn_plic.h"

#define XN_PLIC_NSRC 32  /* sources 0..31, source 0 is reserved */
#define XN_PLIC_NCTX 2   /* 0 = M, 1 = S */

#define XN_PLIC_PRIO_END (4 * XN_PLIC_NSRC)
#define XN_PLIC_PENDING 0x001000
#define XN_PLIC_ENABLE_BASE 0x002000
#define XN_PLIC_ENABLE_STRIDE 0x80
#define XN_PLIC_CTX_BASE 0x200000
#define XN_PLIC_CTX_STRIDE 0x1000
#define XN_PLIC_CLAIM_OFF 4

struct XNPlic {
    uint32_t level;      /* bit i: raw level of source i */
    uint32_t in_service; /* bit i: claimed and not yet completed */
    uint8_t priority[XN_PLIC_NSRC];
    uint32_t enable[XN_PLIC_NCTX];
    uint8_t threshold[XN_PLIC_NCTX];
    XNPlicOutFunc *out;
    void *out_opaque;
};

static uint32_t xn_plic_pending(const XNPlic *p)
{
    return p->level & ~p->in_service;
}

/* A source is a candidate for context c if it is pending, enabled in c and
   its priority is above the threshold. Source 0 never qualifies. */
static int xn_plic_candidate(const XNPlic *p, uint32_t c, uint32_t id)
{
    return id != 0 &&
           ((xn_plic_pending(p) >> id) & 1) &&
           ((p->enable[c] >> id) & 1) &&
           p->priority[id] > p->threshold[c];
}

static int xn_plic_eligible(const XNPlic *p, uint32_t c)
{
    uint32_t id;

    for (id = 1; id < XN_PLIC_NSRC; id++) {
        if (xn_plic_candidate(p, c, id))
            return 1;
    }
    return 0;
}

static void xn_plic_update(XNPlic *p)
{
    if (!p->out)
        return;
    p->out(p->out_opaque, XN_PLIC_MIP_MEIP, xn_plic_eligible(p, 0));
    p->out(p->out_opaque, XN_PLIC_MIP_SEIP, xn_plic_eligible(p, 1));
}

static uint32_t xn_plic_claim(XNPlic *p, uint32_t c)
{
    uint32_t id, best = 0;

    for (id = 1; id < XN_PLIC_NSRC; id++) {
        if (!xn_plic_candidate(p, c, id))
            continue;
        /* strictly greater, so ties keep the lower id */
        if (best == 0 || p->priority[id] > p->priority[best])
            best = id;
    }
    if (best)
        p->in_service |= 1u << best;
    return best;
}

static void xn_plic_complete(XNPlic *p, uint32_t c, uint32_t id)
{
    if (id < XN_PLIC_NSRC && ((p->enable[c] >> id) & 1))
        p->in_service &= ~(1u << id);
}

/* Returns the context index for an enable register at offset, or -1. */
static int xn_plic_enable_ctx(uint32_t offset)
{
    uint32_t rel;

    if (offset < XN_PLIC_ENABLE_BASE)
        return -1;
    rel = offset - XN_PLIC_ENABLE_BASE;
    if (rel % XN_PLIC_ENABLE_STRIDE != 0 ||
        rel / XN_PLIC_ENABLE_STRIDE >= XN_PLIC_NCTX)
        return -1;
    return (int)(rel / XN_PLIC_ENABLE_STRIDE);
}

static uint32_t xn_plic_read(void *opaque, uint32_t offset, int size_log2)
{
    XNPlic *p = opaque;
    uint32_t rel, val = 0;
    int c;

    (void)size_log2;
    if (offset < XN_PLIC_PRIO_END) {
        if ((offset & 3) == 0 && offset != 0)
            val = p->priority[offset >> 2];
    } else if (offset == XN_PLIC_PENDING) {
        val = xn_plic_pending(p);
    } else if ((c = xn_plic_enable_ctx(offset)) >= 0) {
        val = p->enable[c];
    } else if (offset >= XN_PLIC_CTX_BASE &&
               offset < XN_PLIC_CTX_BASE + XN_PLIC_NCTX * XN_PLIC_CTX_STRIDE) {
        rel = offset - XN_PLIC_CTX_BASE;
        c = (int)(rel / XN_PLIC_CTX_STRIDE);
        if (rel % XN_PLIC_CTX_STRIDE == 0) {
            val = p->threshold[c];
        } else if (rel % XN_PLIC_CTX_STRIDE == XN_PLIC_CLAIM_OFF) {
            val = xn_plic_claim(p, c);
            xn_plic_update(p);
        }
    }
    return val;
}

static void xn_plic_write(void *opaque, uint32_t offset, uint32_t val,
                          int size_log2)
{
    XNPlic *p = opaque;
    uint32_t rel;
    int c;

    (void)size_log2;
    if (offset < XN_PLIC_PRIO_END) {
        if ((offset & 3) == 0 && offset != 0)
            p->priority[offset >> 2] = val & 7;
    } else if ((c = xn_plic_enable_ctx(offset)) >= 0) {
        /* bit 0 (source 0) is not writable */
        p->enable[c] = val & ~1u;
    } else if (offset >= XN_PLIC_CTX_BASE &&
               offset < XN_PLIC_CTX_BASE + XN_PLIC_NCTX * XN_PLIC_CTX_STRIDE) {
        rel = offset - XN_PLIC_CTX_BASE;
        c = (int)(rel / XN_PLIC_CTX_STRIDE);
        if (rel % XN_PLIC_CTX_STRIDE == 0) {
            p->threshold[c] = val & 7;
        } else if (rel % XN_PLIC_CTX_STRIDE == XN_PLIC_CLAIM_OFF) {
            xn_plic_complete(p, c, val);
        }
    }
    xn_plic_update(p);
}

void xn_plic_set_irq(void *opaque, int irq, int level)
{
    XNPlic *p = opaque;

    if (irq < 1 || irq >= XN_PLIC_NSRC)
        return;
    if (level)
        p->level |= 1u << irq;
    else
        p->level &= ~(1u << irq);
    xn_plic_update(p);
}

XNPlic *xn_plic_init(PhysMemoryMap *mem_map, uint64_t addr,
                     XNPlicOutFunc *out, void *out_opaque)
{
    XNPlic *p;

    p = calloc(1, sizeof(*p));
    if (!p)
        return NULL;
    p->out = out;
    p->out_opaque = out_opaque;
    cpu_register_device(mem_map, addr, XN_PLIC_SIZE, p, xn_plic_read,
                        xn_plic_write, DEVIO_SIZE32);
    return p;
}
