/*
 * xiaonux: RISC-V PLIC for the xv6-virt machine profile.
 *
 * One hart, sources 1-31, two contexts (0 = M-mode, 1 = S-mode). Registers
 * are 32-bit (DEVIO_SIZE32). Unknown offsets read 0 and ignore writes.
 *
 * Output design: the PLIC does not depend on riscv_cpu.h. Instead of a CPU
 * pointer it takes a callback, out(out_opaque, mip_mask, level), which is
 * called after every change with MIP_MEIP (context 0) or MIP_SEIP (context 1)
 * and whether that context has an eligible source. The machine wires it to
 * riscv_cpu_set_mip() / riscv_cpu_reset_mip() on the hart.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef XN_PLIC_H
#define XN_PLIC_H

#include <stddef.h>
#include <stdint.h>
#include "cutils.h"
#include "iomem.h"

/* Same bit values as MIP_MEIP / MIP_SEIP in riscv_cpu.h. */
#define XN_PLIC_MIP_MEIP (1u << 11)
#define XN_PLIC_MIP_SEIP (1u << 9)

#define XN_PLIC_SIZE 0x400000

typedef struct XNPlic XNPlic;

typedef void XNPlicOutFunc(void *opaque, uint32_t mip_mask, int level);

/* Registers the PLIC window at addr. out may be NULL (no outputs).
   Returns NULL if out of memory. */
XNPlic *xn_plic_init(PhysMemoryMap *mem_map, uint64_t addr,
                     XNPlicOutFunc *out, void *out_opaque);

/* IRQSignal handler. opaque is the XNPlic; irq must be 1..31. */
void xn_plic_set_irq(void *opaque, int irq, int level);

#endif /* XN_PLIC_H */
