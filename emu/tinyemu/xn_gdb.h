/*
 * xiaonux: GDB Remote Serial Protocol stub core for the xv6-virt machine.
 *
 * Transport- and machine-agnostic: the machine supplies register and memory
 * access through XNGdbTarget, and the transport (native TCP in temu, the
 * agent channel in the browser) feeds bytes in and gets replies via `out`.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef XN_GDB_H
#define XN_GDB_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    /* regno: 0-31 x, 32 pc, 33-64 f, 65 fflags, 66 frm, 67 fcsr.
       Returns 0, or -1 if there is no such register. */
    int (*reg_rw)(void *t, int regno, uint64_t *val, int write);
    /* Returns 0, or -1 on a fault (no side effects on the target). */
    int (*mem_rw)(void *t, uint64_t addr, uint8_t *buf, int len, int write);
    /* Called after c/s/D so the machine can e.g. disable the JIT. May be NULL. */
    void (*on_resume)(void *t);
} XNGdbTarget;

typedef struct XNGdb XNGdb;

XNGdb *xn_gdb_new(const XNGdbTarget *ops, void *t,
                  void (*out)(void *o, const uint8_t *buf, int len), void *o);
void xn_gdb_free(XNGdb *g);
/* Bytes from the client; may hold any number of packets, or a partial one. */
void xn_gdb_input(XNGdb *g, const uint8_t *buf, int len);
int  xn_gdb_halted(XNGdb *g);
int  xn_gdb_stepping(XNGdb *g);         /* one instruction, then stop */
int  xn_gdb_has_breakpoints(XNGdb *g);
int  xn_gdb_breakpoint_at(XNGdb *g, uint64_t pc);
/* The machine reports a stop: halts and sends "T<sig>thread:1;". */
void xn_gdb_stop(XNGdb *g, int signal);
/* Start halted (-S): no stop reply until the client asks with '?' or resumes. */
void xn_gdb_halt_initial(XNGdb *g);
int  xn_gdb_killed(XNGdb *g);

#endif
