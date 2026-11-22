/*
 * xiaonux: native unit test for the 16550 UART (emu/tinyemu/xn_uart.c).
 * The .c file is included directly. cpu_register_device is stubbed so the
 * test drives the registered read/write callbacks, as the bus would.
 * Build: cc -std=c11 -Wall -Wextra -Werror -Iemu/compat -Iemu/tinyemu -o build/xn_uart_test emu/wasm/test/xn_uart_test.c
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdio.h>
#include <string.h>
#include "xn_uart.c"

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

/* Captured from xn_uart_init's cpu_register_device call. */
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

/* Fake console: records output and serves a queued input buffer. */
typedef struct {
    uint8_t out[256];
    int out_len;
    uint8_t in[64];
    int in_len;
    int in_pos;
} FakeCons;

static FakeCons cons;

static void fake_write(void *op, const uint8_t *buf, int len)
{
    FakeCons *c = op;
    memcpy(c->out + c->out_len, buf, len);
    c->out_len += len;
}

static int fake_read(void *op, uint8_t *buf, int len)
{
    FakeCons *c = op;
    int n = c->in_len - c->in_pos;
    if (n > len)
        n = len;
    memcpy(buf, c->in + c->in_pos, n);
    c->in_pos += n;
    return n;
}

static CharacterDevice cdev = {
    .opaque = &cons,
    .write_data = fake_write,
    .read_data = fake_read,
};

/* Fake IRQ line: remembers the last level driven. */
static int irq_level;

static void fake_irq(void *op, int irq_num, int level)
{
    (void)op;
    (void)irq_num;
    irq_level = level != 0;
}

static IRQSignal irq_sig = { .set_irq = fake_irq, .opaque = NULL, .irq_num = 10 };

static uint32_t rd(uint32_t off)
{
    return dev_read(dev_opaque, off, 0);
}

static void wr(uint32_t off, uint32_t val)
{
    dev_write(dev_opaque, off, val, 0);
}

#define UART_BASE 0x10000000u

int main(void)
{
    XNUart *u;
    static const char alpha[] = "0123456789abcdefghij";
    int i;

    /* 0. registration: 8 byte-wide registers at the UART base */
    u = xn_uart_init(NULL, UART_BASE, &irq_sig, &cdev);
    CHECK(u != NULL, "init returns a device");
    CHECK_EQ(dev_addr, UART_BASE, "registered at 0x10000000");
    CHECK_EQ(dev_size, 8, "registered size is 8 bytes");
    CHECK_EQ(dev_flags, DEVIO_SIZE8, "registered as byte-wide");
    CHECK(dev_read != NULL && dev_write != NULL, "callbacks registered");

    /* 1. xv6 init sequence: IER=0, LCR=0x80, DLL=3, DLM=0, LCR=3, FCR=7, IER=3 */
    wr(1, 0);
    wr(3, 0x80);
    wr(0, 3);
    wr(1, 0);
    wr(3, 3);
    wr(2, 7);
    wr(1, 3);
    CHECK_EQ(irq_level, 1, "IER=3 raises THRE on an idle transmitter");
    CHECK_EQ(rd(3), 3, "LCR reads back");
    CHECK_EQ(rd(1), 3, "IER reads back");
    CHECK_EQ(rd(2), 0xC2, "IIR is THRE with FIFO enabled");
    CHECK_EQ(irq_level, 0, "reading IIR clears THRE");
    CHECK_EQ(rd(2), 0xC1, "IIR is no interrupt after the clear");

    /* 2. THR write outputs the byte and raises the IRQ */
    wr(0, 'h');
    wr(0, 'i');
    CHECK_EQ(cons.out_len, 2, "two bytes output");
    CHECK(memcmp(cons.out, "hi", 2) == 0, "output bytes in order");
    CHECK_EQ(irq_level, 1, "THR write raises the IRQ");
    CHECK_EQ(rd(2), 0xC2, "IIR is THRE after a THR write");
    CHECK_EQ(irq_level, 0, "IIR read clears the IRQ");
    CHECK_EQ(rd(2), 0xC1, "IIR no interrupt again");

    /* 3. queued input raises the IRQ, IIR reports RDA, RBR is in order */
    memcpy(cons.in, "abc", 3);
    cons.in_len = 3;
    cons.in_pos = 0;
    CHECK_EQ(irq_level, 0, "no input yet, IRQ low");
    xn_uart_poll(u);
    CHECK_EQ(irq_level, 1, "queued input raises the IRQ");
    CHECK_EQ(rd(2), 0xC4, "IIR is RDA with FIFO enabled");
    CHECK_EQ(rd(5) & 1, 1, "LSR bit 0 (data ready) set");
    CHECK_EQ(rd(0), 'a', "RBR first byte");
    CHECK_EQ(rd(0), 'b', "RBR second byte");
    CHECK_EQ(rd(0), 'c', "RBR third byte");
    CHECK_EQ(rd(5) & 1, 0, "LSR bit 0 clear when empty");
    CHECK_EQ(rd(0), 0, "RBR returns 0 when empty");
    CHECK_EQ(irq_level, 0, "IRQ low once the FIFO is drained");

    /* 4. the FIFO holds 16 bytes; RBR pops refill it from the console */
    memcpy(cons.in, alpha, sizeof(alpha) - 1);
    cons.in_len = (int)(sizeof(alpha) - 1);
    cons.in_pos = 0;
    xn_uart_poll(u);
    CHECK_EQ(cons.in_pos, 16, "poll reads only the free FIFO space");
    for (i = 0; i < (int)(sizeof(alpha) - 1); i++) {
        CHECK_EQ(rd(0), (uint8_t)alpha[i], "RX bytes in order through the FIFO");
    }
    CHECK_EQ(rd(5) & 1, 0, "all input consumed");

    /* 5. DLAB=1 aliases offsets 0 and 1 to DLL and DLM */
    wr(3, 0x80);
    cons.out_len = 0;
    wr(0, 0x5a);
    wr(1, 0x33);
    CHECK_EQ(cons.out_len, 0, "DLL write does not transmit");
    CHECK_EQ(rd(0), 0x5a, "DLL reads back at offset 0");
    CHECK_EQ(rd(1), 0x33, "DLM reads back at offset 1");
    cons.in[0] = 'Q';
    cons.in_len = 1;
    cons.in_pos = 0;
    xn_uart_poll(u);
    CHECK_EQ(rd(0), 0x5a, "with DLAB=1 offset 0 reads DLL, no RBR pop");
    CHECK_EQ(cons.in_pos, 1, "input still queued after the DLL read");
    wr(3, 3);
    CHECK_EQ(rd(1), 3, "DLM write left IER alone");
    CHECK_EQ(rd(0), 'Q', "with DLAB=0 offset 0 pops RBR");

    /* 6. IER ETBEI newly set raises THRE; rewriting it while set does not */
    CHECK_EQ(rd(2), 0xC1, "IIR clear before the IER test");
    wr(1, 0);
    CHECK_EQ(irq_level, 0, "IER=0 leaves the IRQ low");
    wr(1, 2);
    CHECK_EQ(irq_level, 1, "ETBEI newly set raises THRE");
    CHECK_EQ(rd(2), 0xC2, "IIR reports THRE");
    CHECK_EQ(irq_level, 0, "IIR read cleared THRE");
    wr(1, 2);
    CHECK_EQ(irq_level, 0, "ETBEI already set does not re-raise THRE");

    /* 7. LSR/MSR/SCR/MCR and FCR behaviour */
    CHECK_EQ(rd(5), 0x60, "LSR is THRE|TEMT with no data");
    CHECK_EQ(rd(6), 0xB0, "MSR is CTS|DSR|DCD");
    wr(7, 0xA5);
    CHECK_EQ(rd(7), 0xA5, "SCR round trip");
    wr(4, 0x0b);
    CHECK_EQ(rd(4), 0x0b, "MCR round trip");
    wr(2, 0);
    CHECK_EQ(rd(2), 0x01, "FCR=0 drops the FIFO-enable bits from IIR");
    wr(2, 7);
    CHECK_EQ(rd(2), 0xC1, "FCR=7 restores the FIFO-enable bits");
    cons.in[0] = 'z';
    cons.in[1] = 'z';
    cons.in_len = 2;
    cons.in_pos = 0;
    xn_uart_poll(u);
    CHECK_EQ(rd(5) & 1, 1, "data queued before the FCR RX clear");
    wr(2, 0x03);
    CHECK_EQ(rd(5) & 1, 0, "FCR bit 1 clears the RX FIFO");
    CHECK_EQ(rd(0), 0, "RBR is empty after the RX clear");

    /* 8. prompt sync: "$ " on the console pauses the machine until resumed */
    cons.out_len = 0;
    CHECK_EQ(xn_uart_paused(u), 0, "not paused at the start of the sync test");
    wr(0, '$');
    wr(0, ' ');
    CHECK_EQ(xn_uart_paused(u), 0, "sync off: \"$ \" does not pause");
    xn_uart_set_prompt_sync(u, 1);
    wr(0, '$');
    wr(0, 'x');
    CHECK_EQ(xn_uart_paused(u), 0, "\"$x\" does not pause");
    wr(0, ' ');
    wr(0, '$');
    CHECK_EQ(xn_uart_paused(u), 0, "\" $\" does not pause");
    wr(0, 'y');
    CHECK_EQ(xn_uart_paused(u), 0, "\"$\" then \"y\" does not pause");
    wr(0, '$');
    wr(0, ' ');
    CHECK_EQ(xn_uart_paused(u), 1, "\"$ \" pauses with sync on");
    wr(0, 'z');
    CHECK_EQ(xn_uart_paused(u), 1, "output while paused keeps the pause");
    CHECK_EQ(cons.out_len, 10, "all bytes are still output while paused");
    CHECK(memcmp(cons.out, "$ $x $y$ z", 10) == 0, "bytes output in order");
    xn_uart_resume(u);
    CHECK_EQ(xn_uart_paused(u), 0, "resume clears the pause");
    xn_uart_resume(u);
    CHECK_EQ(xn_uart_paused(u), 0, "resume when not paused is a no-op");

    /* a DLL write is not a transmit: it neither pauses nor sets the last byte */
    wr(3, 0x80);
    wr(0, '$');
    wr(3, 3);
    wr(0, ' ');
    CHECK_EQ(xn_uart_paused(u), 0, "a DLL write of '$' does not count as transmitted");

    /* turning sync off clears a pending pause and stops new ones */
    wr(0, '$');
    wr(0, ' ');
    CHECK_EQ(xn_uart_paused(u), 1, "\"$ \" pauses again");
    xn_uart_set_prompt_sync(u, 0);
    CHECK_EQ(xn_uart_paused(u), 0, "sync off clears the pause");
    wr(0, '$');
    wr(0, ' ');
    CHECK_EQ(xn_uart_paused(u), 0, "sync off: no pause");
    xn_uart_set_prompt_sync(u, 1);
    wr(0, '$');
    wr(0, ' ');
    CHECK_EQ(xn_uart_paused(u), 1, "sync back on: pauses");
    xn_uart_resume(u);

    puts("ok");
    return 0;
}
