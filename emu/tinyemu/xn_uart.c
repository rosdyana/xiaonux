/*
 * xiaonux: 16550-compatible UART for the xv6-virt machine profile.
 *
 * Written from the 16550 register description. Behaviour notes:
 *  - THR writes are output immediately, so THRE and TEMT are always set.
 *    A THR write sets thre_pending, which the guest clears by reading IIR
 *    while THRE is the reported cause.
 *  - Setting IER.ETBEI from 0 to 1 also sets thre_pending (THR is empty).
 *  - FCR bit 2 (clear TX FIFO) has nothing to drop, so it leaves
 *    thre_pending unchanged.
 *  - The IRQ line is re-evaluated after every access and every poll.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdlib.h>
#include "cutils.h"
#include "iomem.h"
#include "virtio.h"
#include "xn_uart.h"

#define XN_UART_SIZE 8
#define XN_UART_RX_SIZE 16

#define LCR_DLAB 0x80

#define IER_ERBFI 0x01 /* received data available */
#define IER_ETBEI 0x02 /* THR empty */

#define IIR_NO_INT 0x01
#define IIR_THRE 0x02
#define IIR_RDA 0x04
#define IIR_FIFO_EN 0xC0

#define FCR_FIFO_EN 0x01
#define FCR_RX_CLEAR 0x02

#define LSR_DR 0x01
#define LSR_THRE_TEMT 0x60
#define MSR_CTS_DSR_DCD 0xB0

struct XNUart {
    IRQSignal *irq;
    CharacterDevice *cs;
    uint8_t dll;
    uint8_t dlm;
    uint8_t ier;        /* low 4 bits only */
    uint8_t lcr;
    uint8_t mcr;
    uint8_t scr;
    int fifo_en;        /* FCR bit 0 */
    int thre_pending;
    uint8_t rx[XN_UART_RX_SIZE];
    int rx_head;
    int rx_count;
};

static void xn_uart_update_irq(XNUart *u)
{
    int level;

    level = ((u->ier & IER_ERBFI) && u->rx_count > 0) ||
            ((u->ier & IER_ETBEI) && u->thre_pending);
    set_irq(u->irq, level);
}

void xn_uart_poll(XNUart *u)
{
    uint8_t buf[XN_UART_RX_SIZE];
    int room, n, i;

    room = XN_UART_RX_SIZE - u->rx_count;
    if (u->cs && room > 0) {
        n = u->cs->read_data(u->cs->opaque, buf, room);
        if (n > room)
            n = room;
        for (i = 0; i < n; i++) {
            u->rx[(u->rx_head + u->rx_count) % XN_UART_RX_SIZE] = buf[i];
            u->rx_count++;
        }
    }
    xn_uart_update_irq(u);
}

static uint32_t xn_uart_read_iir(XNUart *u)
{
    uint32_t iir;

    if ((u->ier & IER_ERBFI) && u->rx_count > 0) {
        iir = IIR_RDA;
    } else if ((u->ier & IER_ETBEI) && u->thre_pending) {
        iir = IIR_THRE;
        u->thre_pending = 0; /* reading IIR acknowledges the THRE cause */
    } else {
        iir = IIR_NO_INT;
    }
    if (u->fifo_en)
        iir |= IIR_FIFO_EN;
    return iir;
}

static uint32_t xn_uart_read(void *opaque, uint32_t offset, int size_log2)
{
    XNUart *u = opaque;
    uint32_t val = 0;

    (void)size_log2;
    switch (offset) {
    case 0:
        if (u->lcr & LCR_DLAB) {
            val = u->dll;
        } else if (u->rx_count > 0) {
            val = u->rx[u->rx_head];
            u->rx_head = (u->rx_head + 1) % XN_UART_RX_SIZE;
            u->rx_count--;
            /* keep input flowing into the FIFO; also updates the IRQ */
            xn_uart_poll(u);
        }
        break;
    case 1:
        val = (u->lcr & LCR_DLAB) ? u->dlm : u->ier;
        break;
    case 2:
        val = xn_uart_read_iir(u);
        break;
    case 3:
        val = u->lcr;
        break;
    case 4:
        val = u->mcr;
        break;
    case 5:
        val = LSR_THRE_TEMT | (u->rx_count > 0 ? LSR_DR : 0);
        break;
    case 6:
        val = MSR_CTS_DSR_DCD;
        break;
    case 7:
        val = u->scr;
        break;
    default:
        break;
    }
    xn_uart_update_irq(u);
    return val;
}

static void xn_uart_write(void *opaque, uint32_t offset, uint32_t val,
                          int size_log2)
{
    XNUart *u = opaque;
    uint8_t b = val & 0xff;
    uint8_t new_ier;

    (void)size_log2;
    switch (offset) {
    case 0:
        if (u->lcr & LCR_DLAB) {
            u->dll = b;
        } else {
            if (u->cs)
                u->cs->write_data(u->cs->opaque, &b, 1);
            u->thre_pending = 1;
        }
        break;
    case 1:
        if (u->lcr & LCR_DLAB) {
            u->dlm = b;
        } else {
            new_ier = b & 0x0f;
            /* ETBEI newly set while THR is empty raises THRE */
            if ((new_ier & IER_ETBEI) && !(u->ier & IER_ETBEI))
                u->thre_pending = 1;
            u->ier = new_ier;
        }
        break;
    case 2:
        u->fifo_en = b & FCR_FIFO_EN;
        if (b & FCR_RX_CLEAR) {
            u->rx_head = 0;
            u->rx_count = 0;
        }
        break;
    case 3:
        u->lcr = b;
        break;
    case 4:
        u->mcr = b;
        break;
    case 7:
        u->scr = b;
        break;
    default:
        /* 5 (LSR) and 6 (MSR) are read-only */
        break;
    }
    xn_uart_update_irq(u);
}

XNUart *xn_uart_init(PhysMemoryMap *mem_map, uint64_t addr, IRQSignal *irq,
                     CharacterDevice *cs)
{
    XNUart *u;

    u = calloc(1, sizeof(*u));
    if (!u)
        return NULL;
    u->irq = irq;
    u->cs = cs;
    cpu_register_device(mem_map, addr, XN_UART_SIZE, u, xn_uart_read,
                        xn_uart_write, DEVIO_SIZE8);
    return u;
}
