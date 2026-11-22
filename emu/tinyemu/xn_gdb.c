/*
 * xiaonux: GDB Remote Serial Protocol stub core (see xn_gdb.h).
 *
 * Implements the subset that stock gdb (riscv64) and the MIT lab graders
 * use: register and memory access, software breakpoints (no memory
 * patching), single-step, continue, detach and kill. Packets are framed
 * as $data#cc with +/- acks until QStartNoAckMode.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdlib.h>
#include <string.h>
#include "xn_gdb.h"

#define XN_GDB_PACKET_SIZE 4000                          /* advertised */
#define XN_GDB_BODY_MAX    4096                          /* largest body accepted */
#define XN_GDB_MEM_MAX     ((XN_GDB_PACKET_SIZE - 2) / 2) /* bytes per m/M */
#define XN_GDB_MAX_BP      64
#define XN_GDB_REG_PC      32
#define XN_GDB_REG_FFLAGS  65
#define XN_GDB_NGREG       33   /* g packet: x0-x31 and pc */

enum { RX_IDLE, RX_BODY, RX_SUM1, RX_SUM2 };

/* Feature list served by qXfer:features:read. Register names follow gdb's
   riscv tdesc expectations (x8 is "fp", FP registers use the ABI names in
   architectural order). */
static const char xn_gdb_target_xml[] =
    "<?xml version=\"1.0\"?>\n"
    "<!DOCTYPE target SYSTEM \"gdb-target.dtd\">\n"
    "<target version=\"1.0\">\n"
    "<architecture>riscv:rv64</architecture>\n"
    "<feature name=\"org.gnu.gdb.riscv.cpu\">\n"
    "<reg name=\"zero\" bitsize=\"64\" regnum=\"0\"/>\n"
    "<reg name=\"ra\" bitsize=\"64\" regnum=\"1\"/>\n"
    "<reg name=\"sp\" bitsize=\"64\" regnum=\"2\"/>\n"
    "<reg name=\"gp\" bitsize=\"64\" regnum=\"3\"/>\n"
    "<reg name=\"tp\" bitsize=\"64\" regnum=\"4\"/>\n"
    "<reg name=\"t0\" bitsize=\"64\" regnum=\"5\"/>\n"
    "<reg name=\"t1\" bitsize=\"64\" regnum=\"6\"/>\n"
    "<reg name=\"t2\" bitsize=\"64\" regnum=\"7\"/>\n"
    "<reg name=\"fp\" bitsize=\"64\" regnum=\"8\"/>\n"
    "<reg name=\"s1\" bitsize=\"64\" regnum=\"9\"/>\n"
    "<reg name=\"a0\" bitsize=\"64\" regnum=\"10\"/>\n"
    "<reg name=\"a1\" bitsize=\"64\" regnum=\"11\"/>\n"
    "<reg name=\"a2\" bitsize=\"64\" regnum=\"12\"/>\n"
    "<reg name=\"a3\" bitsize=\"64\" regnum=\"13\"/>\n"
    "<reg name=\"a4\" bitsize=\"64\" regnum=\"14\"/>\n"
    "<reg name=\"a5\" bitsize=\"64\" regnum=\"15\"/>\n"
    "<reg name=\"a6\" bitsize=\"64\" regnum=\"16\"/>\n"
    "<reg name=\"a7\" bitsize=\"64\" regnum=\"17\"/>\n"
    "<reg name=\"s2\" bitsize=\"64\" regnum=\"18\"/>\n"
    "<reg name=\"s3\" bitsize=\"64\" regnum=\"19\"/>\n"
    "<reg name=\"s4\" bitsize=\"64\" regnum=\"20\"/>\n"
    "<reg name=\"s5\" bitsize=\"64\" regnum=\"21\"/>\n"
    "<reg name=\"s6\" bitsize=\"64\" regnum=\"22\"/>\n"
    "<reg name=\"s7\" bitsize=\"64\" regnum=\"23\"/>\n"
    "<reg name=\"s8\" bitsize=\"64\" regnum=\"24\"/>\n"
    "<reg name=\"s9\" bitsize=\"64\" regnum=\"25\"/>\n"
    "<reg name=\"s10\" bitsize=\"64\" regnum=\"26\"/>\n"
    "<reg name=\"s11\" bitsize=\"64\" regnum=\"27\"/>\n"
    "<reg name=\"t3\" bitsize=\"64\" regnum=\"28\"/>\n"
    "<reg name=\"t4\" bitsize=\"64\" regnum=\"29\"/>\n"
    "<reg name=\"t5\" bitsize=\"64\" regnum=\"30\"/>\n"
    "<reg name=\"t6\" bitsize=\"64\" regnum=\"31\"/>\n"
    "<reg name=\"pc\" bitsize=\"64\" type=\"code_ptr\" regnum=\"32\"/>\n"
    "</feature>\n"
    "<feature name=\"org.gnu.gdb.riscv.fpu\">\n"
    "<reg name=\"ft0\" bitsize=\"64\" type=\"ieee_double\" regnum=\"33\"/>\n"
    "<reg name=\"ft1\" bitsize=\"64\" type=\"ieee_double\" regnum=\"34\"/>\n"
    "<reg name=\"ft2\" bitsize=\"64\" type=\"ieee_double\" regnum=\"35\"/>\n"
    "<reg name=\"ft3\" bitsize=\"64\" type=\"ieee_double\" regnum=\"36\"/>\n"
    "<reg name=\"ft4\" bitsize=\"64\" type=\"ieee_double\" regnum=\"37\"/>\n"
    "<reg name=\"ft5\" bitsize=\"64\" type=\"ieee_double\" regnum=\"38\"/>\n"
    "<reg name=\"ft6\" bitsize=\"64\" type=\"ieee_double\" regnum=\"39\"/>\n"
    "<reg name=\"ft7\" bitsize=\"64\" type=\"ieee_double\" regnum=\"40\"/>\n"
    "<reg name=\"fs0\" bitsize=\"64\" type=\"ieee_double\" regnum=\"41\"/>\n"
    "<reg name=\"fs1\" bitsize=\"64\" type=\"ieee_double\" regnum=\"42\"/>\n"
    "<reg name=\"fa0\" bitsize=\"64\" type=\"ieee_double\" regnum=\"43\"/>\n"
    "<reg name=\"fa1\" bitsize=\"64\" type=\"ieee_double\" regnum=\"44\"/>\n"
    "<reg name=\"fa2\" bitsize=\"64\" type=\"ieee_double\" regnum=\"45\"/>\n"
    "<reg name=\"fa3\" bitsize=\"64\" type=\"ieee_double\" regnum=\"46\"/>\n"
    "<reg name=\"fa4\" bitsize=\"64\" type=\"ieee_double\" regnum=\"47\"/>\n"
    "<reg name=\"fa5\" bitsize=\"64\" type=\"ieee_double\" regnum=\"48\"/>\n"
    "<reg name=\"fa6\" bitsize=\"64\" type=\"ieee_double\" regnum=\"49\"/>\n"
    "<reg name=\"fa7\" bitsize=\"64\" type=\"ieee_double\" regnum=\"50\"/>\n"
    "<reg name=\"fs2\" bitsize=\"64\" type=\"ieee_double\" regnum=\"51\"/>\n"
    "<reg name=\"fs3\" bitsize=\"64\" type=\"ieee_double\" regnum=\"52\"/>\n"
    "<reg name=\"fs4\" bitsize=\"64\" type=\"ieee_double\" regnum=\"53\"/>\n"
    "<reg name=\"fs5\" bitsize=\"64\" type=\"ieee_double\" regnum=\"54\"/>\n"
    "<reg name=\"fs6\" bitsize=\"64\" type=\"ieee_double\" regnum=\"55\"/>\n"
    "<reg name=\"fs7\" bitsize=\"64\" type=\"ieee_double\" regnum=\"56\"/>\n"
    "<reg name=\"fs8\" bitsize=\"64\" type=\"ieee_double\" regnum=\"57\"/>\n"
    "<reg name=\"fs9\" bitsize=\"64\" type=\"ieee_double\" regnum=\"58\"/>\n"
    "<reg name=\"fs10\" bitsize=\"64\" type=\"ieee_double\" regnum=\"59\"/>\n"
    "<reg name=\"fs11\" bitsize=\"64\" type=\"ieee_double\" regnum=\"60\"/>\n"
    "<reg name=\"ft8\" bitsize=\"64\" type=\"ieee_double\" regnum=\"61\"/>\n"
    "<reg name=\"ft9\" bitsize=\"64\" type=\"ieee_double\" regnum=\"62\"/>\n"
    "<reg name=\"ft10\" bitsize=\"64\" type=\"ieee_double\" regnum=\"63\"/>\n"
    "<reg name=\"ft11\" bitsize=\"64\" type=\"ieee_double\" regnum=\"64\"/>\n"
    "<reg name=\"fflags\" bitsize=\"32\" type=\"int\" regnum=\"65\"/>\n"
    "<reg name=\"frm\" bitsize=\"32\" type=\"int\" regnum=\"66\"/>\n"
    "<reg name=\"fcsr\" bitsize=\"32\" type=\"int\" regnum=\"67\"/>\n"
    "</feature>\n"
    "</target>\n";

struct XNGdb {
    const XNGdbTarget *ops;
    void *t;
    void (*out)(void *o, const uint8_t *buf, int len);
    void *o;

    /* receive state */
    int rx_state;
    uint8_t body[XN_GDB_BODY_MAX];
    int body_len;
    int body_overflow;
    uint8_t sum;        /* running checksum of the raw body */
    int sum_hi;         /* first checksum digit, -1 if not hex */

    int noack;
    int halted;
    int stepping;
    int killed;

    int nbp;
    uint64_t bp[XN_GDB_MAX_BP];

    /* scratch for replies */
    uint8_t mem[XN_GDB_MEM_MAX];
    uint8_t hexbuf[XN_GDB_PACKET_SIZE];
    uint8_t tx[XN_GDB_PACKET_SIZE + 8];
};

static const char hex_digits[] = "0123456789abcdef";

static int hexval(int c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

/* Frames data as $data#cc and sends it. len must be <= XN_GDB_PACKET_SIZE. */
static void send_packet(XNGdb *g, const uint8_t *data, int len)
{
    uint8_t sum = 0;
    int i, n = 0;

    g->tx[n++] = '$';
    for (i = 0; i < len; i++) {
        g->tx[n++] = data[i];
        sum += data[i];
    }
    g->tx[n++] = '#';
    g->tx[n++] = hex_digits[sum >> 4];
    g->tx[n++] = hex_digits[sum & 15];
    g->out(g->o, g->tx, n);
}

static void send_str(XNGdb *g, const char *s)
{
    send_packet(g, (const uint8_t *)s, (int)strlen(s));
}

static void send_ctrl(XNGdb *g, uint8_t c)
{
    g->out(g->o, &c, 1);
}

/* Parses a hex number at *pp (stopping at end or a non-hex byte).
   Returns the digit count; 0 if none or more than 16. */
static int parse_hex(const uint8_t **pp, const uint8_t *end, uint64_t *v)
{
    const uint8_t *p = *pp;
    uint64_t r = 0;
    int n = 0, d;

    while (p < end && (d = hexval(*p)) >= 0) {
        r = (r << 4) | (uint64_t)d;
        p++;
        n++;
    }
    *pp = p;
    *v = r;
    return n <= 16 ? n : 0;
}

static int starts(const uint8_t *p, int len, const char *s)
{
    int n = (int)strlen(s);
    return len >= n && memcmp(p, s, n) == 0;
}

static int equals(const uint8_t *p, int len, const char *s)
{
    return len == (int)strlen(s) && memcmp(p, s, len) == 0;
}

/* Register width in bytes on the wire: fflags, frm and fcsr are 32 bit. */
static int reg_bytes(int regno)
{
    return regno >= XN_GDB_REG_FFLAGS ? 4 : 8;
}

static void put_le_hex(uint8_t *dst, uint64_t v, int nbytes)
{
    int i;

    for (i = 0; i < nbytes; i++) {
        dst[2 * i] = hex_digits[(v >> (8 * i + 4)) & 15];
        dst[2 * i + 1] = hex_digits[(v >> (8 * i)) & 15];
    }
}

/* Decodes nbytes of little-endian hex from src (2 chars per byte). */
static int get_le_hex(const uint8_t *src, int nbytes, uint64_t *v)
{
    uint64_t r = 0;
    int i, hi, lo;

    for (i = 0; i < nbytes; i++) {
        hi = hexval(src[2 * i]);
        lo = hexval(src[2 * i + 1]);
        if (hi < 0 || lo < 0)
            return -1;
        r |= (uint64_t)((hi << 4) | lo) << (8 * i);
    }
    *v = r;
    return 0;
}

static int bp_find(XNGdb *g, uint64_t addr)
{
    int i;

    for (i = 0; i < g->nbp; i++)
        if (g->bp[i] == addr)
            return i;
    return -1;
}

static void resume(XNGdb *g, int step, int have_addr, uint64_t addr)
{
    if (have_addr)
        g->ops->reg_rw(g->t, XN_GDB_REG_PC, &addr, 1);
    g->halted = 0;
    g->stepping = step;
    if (g->ops->on_resume)
        g->ops->on_resume(g->t);
}

static void do_read_reg(XNGdb *g, int regno)
{
    uint64_t v;
    int nb = reg_bytes(regno);

    if (g->ops->reg_rw(g->t, regno, &v, 0) < 0) {
        send_str(g, "E01");
        return;
    }
    put_le_hex(g->hexbuf, v, nb);
    send_packet(g, g->hexbuf, 2 * nb);
}

/* qXfer:features:read:target.xml:<off>,<len> */
static void do_xfer(XNGdb *g, uint64_t off, uint64_t len)
{
    size_t total = sizeof(xn_gdb_target_xml) - 1;
    size_t n;

    if (off >= total) {
        send_str(g, "l");
        return;
    }
    n = total - (size_t)off;
    if (len < n)
        n = (size_t)len;
    if (n > XN_GDB_PACKET_SIZE - 1)
        n = XN_GDB_PACKET_SIZE - 1;
    g->hexbuf[0] = (off + n < total) ? 'm' : 'l';
    memcpy(g->hexbuf + 1, xn_gdb_target_xml + off, n);
    send_packet(g, g->hexbuf, (int)n + 1);
}

/* Handles one unescaped packet body. */
static void handle_packet(XNGdb *g, const uint8_t *p, int len)
{
    const uint8_t *end = p + len;
    const uint8_t *q;
    uint64_t a, v, l;
    int i, n;

    if (len == 0) {
        send_str(g, "");
        return;
    }
    if (starts(p, len, "qSupported")) {
        send_str(g, "PacketSize=4000;qXfer:features:read+;QStartNoAckMode+;"
                    "swbreak+;hwbreak+");
        return;
    }
    if (starts(p, len, "qXfer:features:read:target.xml:")) {
        q = p + strlen("qXfer:features:read:target.xml:");
        if (parse_hex(&q, end, &a) == 0 || q >= end || *q != ',') {
            send_str(g, "E01");
            return;
        }
        q++;
        if (parse_hex(&q, end, &l) == 0 || q != end) {
            send_str(g, "E01");
            return;
        }
        do_xfer(g, a, l);
        return;
    }
    if (equals(p, len, "qAttached")) {
        send_str(g, "1");
        return;
    }
    if (equals(p, len, "qC")) {
        send_str(g, "QC1");
        return;
    }
    if (equals(p, len, "qfThreadInfo")) {
        send_str(g, "m1");
        return;
    }
    if (equals(p, len, "qsThreadInfo")) {
        send_str(g, "l");
        return;
    }
    if (equals(p, len, "qOffsets") || equals(p, len, "qTStatus") ||
        equals(p, len, "vMustReplyEmpty") || equals(p, len, "vCont?")) {
        send_str(g, "");
        return;
    }
    if (starts(p, len, "qSymbol::")) {
        send_str(g, "OK");
        return;
    }
    if (equals(p, len, "QStartNoAckMode")) {
        send_str(g, "OK");
        g->noack = 1;
        return;
    }
    if (p[0] == 'H') {
        send_str(g, "OK");
        return;
    }
    if (equals(p, len, "?")) {
        /* Always halted when the client asks: it is only sent when stopped. */
        send_str(g, "T05thread:1;");
        return;
    }
    if (equals(p, len, "g")) {
        for (i = 0; i < XN_GDB_NGREG; i++) {
            uint64_t val;
            if (g->ops->reg_rw(g->t, i, &val, 0) < 0) {
                send_str(g, "E01");
                return;
            }
            put_le_hex(g->hexbuf + 16 * i, val, 8);
        }
        send_packet(g, g->hexbuf, 16 * XN_GDB_NGREG);
        return;
    }
    if (p[0] == 'G') {
        if (len != 1 + 16 * XN_GDB_NGREG) {
            send_str(g, "E01");
            return;
        }
        for (i = 0; i < XN_GDB_NGREG; i++) {
            if (get_le_hex(p + 1 + 16 * i, 8, &v) < 0 ||
                g->ops->reg_rw(g->t, i, &v, 1) < 0) {
                send_str(g, "E01");
                return;
            }
        }
        send_str(g, "OK");
        return;
    }
    if (p[0] == 'p') {
        q = p + 1;
        if (parse_hex(&q, end, &a) == 0 || q != end || a > 0xffff) {
            send_str(g, "E01");
            return;
        }
        do_read_reg(g, (int)a);
        return;
    }
    if (p[0] == 'P') {
        int nb;
        q = p + 1;
        if (parse_hex(&q, end, &a) == 0 || q >= end || *q != '=') {
            send_str(g, "E01");
            return;
        }
        q++;
        nb = reg_bytes((int)a);
        if (a > XN_GDB_REG_FFLAGS + 2 || end - q != 2 * nb ||
            get_le_hex(q, nb, &v) < 0 ||
            g->ops->reg_rw(g->t, (int)a, &v, 1) < 0) {
            send_str(g, "E01");
            return;
        }
        send_str(g, "OK");
        return;
    }
    if (p[0] == 'm') {
        q = p + 1;
        if (parse_hex(&q, end, &a) == 0 || q >= end || *q != ',') {
            send_str(g, "E01");
            return;
        }
        q++;
        if (parse_hex(&q, end, &l) == 0 || q != end || l > XN_GDB_MEM_MAX) {
            send_str(g, "E01");
            return;
        }
        if (g->ops->mem_rw(g->t, a, g->mem, (int)l, 0) < 0) {
            send_str(g, "E14");
            return;
        }
        for (i = 0; i < (int)l; i++) {
            g->hexbuf[2 * i] = hex_digits[g->mem[i] >> 4];
            g->hexbuf[2 * i + 1] = hex_digits[g->mem[i] & 15];
        }
        send_packet(g, g->hexbuf, 2 * (int)l);
        return;
    }
    if (p[0] == 'M') {
        q = p + 1;
        if (parse_hex(&q, end, &a) == 0 || q >= end || *q != ',') {
            send_str(g, "E01");
            return;
        }
        q++;
        if (parse_hex(&q, end, &l) == 0 || l > XN_GDB_MEM_MAX ||
            q >= end || *q != ':') {
            send_str(g, "E01");
            return;
        }
        q++;
        if (end - q != 2 * (int)l) {
            send_str(g, "E01");
            return;
        }
        for (i = 0; i < (int)l; i++) {
            if (get_le_hex(q + 2 * i, 1, &v) < 0) {
                send_str(g, "E01");
                return;
            }
            g->mem[i] = (uint8_t)v;
        }
        if (g->ops->mem_rw(g->t, a, g->mem, (int)l, 1) < 0) {
            send_str(g, "E14");
            return;
        }
        send_str(g, "OK");
        return;
    }
    if ((p[0] == 'Z' || p[0] == 'z') && len >= 4 &&
        (p[1] == '0' || p[1] == '1') && p[2] == ',') {
        int insert = (p[0] == 'Z');
        q = p + 3;
        if (parse_hex(&q, end, &a) == 0) {
            send_str(g, "E01");
            return;
        }
        if (insert) {
            if (bp_find(g, a) < 0) {
                if (g->nbp >= XN_GDB_MAX_BP) {
                    send_str(g, "E01");
                    return;
                }
                g->bp[g->nbp++] = a;
            }
        } else {
            n = bp_find(g, a);
            if (n >= 0)
                g->bp[n] = g->bp[--g->nbp];
        }
        send_str(g, "OK");
        return;
    }
    if (p[0] == 'c' || p[0] == 's') {
        int have_addr = 0;
        a = 0;
        q = p + 1;
        if (q < end) {
            if (parse_hex(&q, end, &a) == 0 || q != end) {
                send_str(g, "");
                return;
            }
            have_addr = 1;
        }
        resume(g, p[0] == 's', have_addr, a);
        return;
    }
    if (equals(p, len, "k")) {
        g->killed = 1;
        return;
    }
    if (equals(p, len, "D")) {
        g->nbp = 0;
        send_str(g, "OK");
        resume(g, 0, 0, 0);
        return;
    }
    /* Unsupported (including X): the empty reply tells gdb to fall back. */
    send_str(g, "");
}

/* Unescapes a body in place ('}' followed by byte ^ 0x20). Returns the new
   length, or -1 for a dangling escape. */
static int unescape(uint8_t *b, int len)
{
    int i, j = 0;

    for (i = 0; i < len; i++) {
        if (b[i] == '}') {
            if (i + 1 >= len)
                return -1;
            i++;
            b[j++] = b[i] ^ 0x20;
        } else {
            b[j++] = b[i];
        }
    }
    return j;
}

static void finish_packet(XNGdb *g)
{
    int n;

    if (g->body_overflow) {
        send_str(g, "");
        return;
    }
    n = unescape(g->body, g->body_len);
    if (n < 0) {
        send_str(g, "");
        return;
    }
    handle_packet(g, g->body, n);
}

static void rx_byte(XNGdb *g, uint8_t c)
{
    switch (g->rx_state) {
    case RX_IDLE:
        if (c == '$') {
            g->rx_state = RX_BODY;
            g->body_len = 0;
            g->body_overflow = 0;
            g->sum = 0;
        } else if (c == 0x03) {
            /* ctrl-C from the client: halt if running */
            if (!g->halted) {
                g->halted = 1;
                g->stepping = 0;
                send_str(g, "T02thread:1;");
            }
        }
        /* '+' and '-' from the client are acks: nothing to do. */
        break;
    case RX_BODY:
        if (c == '#') {
            g->rx_state = RX_SUM1;
        } else {
            g->sum += c;
            if (g->body_len < XN_GDB_BODY_MAX)
                g->body[g->body_len++] = c;
            else
                g->body_overflow = 1;
        }
        break;
    case RX_SUM1:
        g->sum_hi = hexval(c);
        g->rx_state = RX_SUM2;
        break;
    case RX_SUM2: {
        int lo = hexval(c);
        g->rx_state = RX_IDLE;
        if (g->sum_hi < 0 || lo < 0 || (uint8_t)((g->sum_hi << 4) | lo) != g->sum) {
            if (!g->noack)
                send_ctrl(g, '-');
            break;
        }
        if (!g->noack)
            send_ctrl(g, '+');
        finish_packet(g);
        break;
    }
    }
}

XNGdb *xn_gdb_new(const XNGdbTarget *ops, void *t,
                  void (*out)(void *o, const uint8_t *buf, int len), void *o)
{
    XNGdb *g = calloc(1, sizeof(*g));

    if (!g)
        return NULL;
    g->ops = ops;
    g->t = t;
    g->out = out;
    g->o = o;
    return g;
}

void xn_gdb_free(XNGdb *g)
{
    free(g);
}

void xn_gdb_input(XNGdb *g, const uint8_t *buf, int len)
{
    int i;

    for (i = 0; i < len; i++)
        rx_byte(g, buf[i]);
}

int xn_gdb_halted(XNGdb *g)
{
    return g->halted;
}

int xn_gdb_stepping(XNGdb *g)
{
    return g->stepping;
}

int xn_gdb_has_breakpoints(XNGdb *g)
{
    return g->nbp > 0;
}

int xn_gdb_breakpoint_at(XNGdb *g, uint64_t pc)
{
    return bp_find(g, pc) >= 0;
}

void xn_gdb_stop(XNGdb *g, int sig)
{
    uint8_t buf[16];
    int n = 0;

    g->halted = 1;
    g->stepping = 0;
    buf[n++] = 'T';
    buf[n++] = hex_digits[(sig >> 4) & 15];
    buf[n++] = hex_digits[sig & 15];
    memcpy(buf + n, "thread:1;", 9);
    n += 9;
    send_packet(g, buf, n);
}

void xn_gdb_halt_initial(XNGdb *g)
{
    g->halted = 1;
}

int xn_gdb_killed(XNGdb *g)
{
    return g->killed;
}
