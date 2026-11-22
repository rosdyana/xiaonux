/*
 * xiaonux: 16550-compatible UART for the xv6-virt machine profile.
 *
 * Byte-wide registers at offsets 0-7 of a device window. Transmit is
 * synchronous (a THR write goes straight to the character device), receive
 * is a 16-byte FIFO filled by xn_uart_poll(). The interrupt line is driven
 * through an IRQSignal supplied by the machine.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef XN_UART_H
#define XN_UART_H

#include <stddef.h>
#include <stdint.h>
#include "cutils.h"
#include "iomem.h"
#include "virtio.h" /* CharacterDevice */

typedef struct XNUart XNUart;

/* Registers an 8-byte DEVIO_SIZE8 window at addr. Returns NULL if out of
   memory. The IRQSignal must outlive the device. */
XNUart *xn_uart_init(PhysMemoryMap *mem_map, uint64_t addr, IRQSignal *irq,
                     CharacterDevice *cs);

/* Pull console input into the RX FIFO (non-blocking) and update the IRQ. */
void xn_uart_poll(XNUart *u);

/* Prompt sync (xiaonux, grading only; see xn_uart.c). With it on, a THR write
   of ' ' right after '$' pauses the machine: xn_uart_paused() is 1 until
   xn_uart_resume(). Turning it off also clears a pause. */
void xn_uart_set_prompt_sync(XNUart *u, int on);
int xn_uart_paused(XNUart *u);
void xn_uart_resume(XNUart *u);

#endif /* XN_UART_H */
