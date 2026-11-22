/*
 * xiaonux: native unit test for the GDB RSP stub core (emu/tinyemu/xn_gdb.c).
 * The .c file is included directly. The target is a fake machine: 69
 * registers and 64 KB of memory at address 0. Replies are captured and
 * compared as complete framed packets, so checksums are checked too.
 * Build: cc -std=c11 -Wall -Wextra -Werror -Iemu/compat -Iemu/tinyemu -o build/xn_gdb_test emu/wasm/test/xn_gdb_test.c
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdio.h>
#include <string.h>
#include "xn_gdb.c"

#define CHECK(cond, what)                                                    \
    do {                                                                     \
        if (!(cond)) {                                                       \
            printf("FAIL: %s (%s)\n", (what), #cond);                        \
            return 1;                                                        \
        }                                                                    \
    } while (0)

#define CHECK_EQ(got, want, what)                                            \
    do {                                                                     \
        unsigned long long g_ = (unsigned long long)(got);                   \
        unsigned long long w_ = (unsigned long long)(want);                  \
        if (g_ != w_) {                                                      \
            printf("FAIL: %s: got 0x%llx, want 0x%llx\n", (what), g_, w_);   \
            return 1;                                                        \
        }                                                                    \
    } while (0)

#define CHECK_STR(got, want, what)                                           \
    do {                                                                     \
        if (strcmp((got), (want)) != 0) {                                    \
            printf("FAIL: %s\n  got:  %s\n  want: %s\n", (what), (got),      \
                   (want));                                                  \
            return 1;                                                        \
        }                                                                    \
    } while (0)

/* ---- fake target ---- */

#define FAKE_NREG 69
#define FAKE_MEM  0x10000

static uint64_t fake_reg[FAKE_NREG];
static uint8_t fake_mem[FAKE_MEM];
static int resume_calls;

static int fake_reg_rw(void *t, int regno, uint64_t *val, int write)
{
    (void)t;
    if (regno < 0 || regno >= FAKE_NREG)
        return -1;
    if (write) {
        if (regno == 0)
            return 0; /* x0 is hardwired */
        fake_reg[regno] = *val;
    } else {
        *val = fake_reg[regno];
    }
    return 0;
}

static int fake_mem_rw(void *t, uint64_t addr, uint8_t *buf, int len, int write)
{
    (void)t;
    if (addr > FAKE_MEM || (uint64_t)len > FAKE_MEM - addr)
        return -1;
    if (write)
        memcpy(fake_mem + addr, buf, len);
    else
        memcpy(buf, fake_mem + addr, len);
    return 0;
}

static void fake_on_resume(void *t)
{
    (void)t;
    resume_calls++;
}

static const XNGdbTarget fake_ops = {
    fake_reg_rw, fake_mem_rw, fake_on_resume
};

/* ---- captured output ---- */

static uint8_t outbuf[16384];
static int outlen;

static void capture(void *o, const uint8_t *buf, int len)
{
    (void)o;
    if (outlen + len > (int)sizeof(outbuf))
        len = (int)sizeof(outbuf) - outlen;
    memcpy(outbuf + outlen, buf, len);
    outlen += len;
}

static void take_out(char *dst, size_t cap)
{
    if ((size_t)outlen + 1 > cap)
        outlen = (int)cap - 1;
    memcpy(dst, outbuf, outlen);
    dst[outlen] = 0;
    outlen = 0;
}

/* Expected wire form of a reply: "+" then "$payload#cc". */
static void frame(char *dst, size_t cap, const char *payload, int ack)
{
    unsigned sum = 0;
    size_t i, n = strlen(payload);
    static const char hx[] = "0123456789abcdef";

    for (i = 0; i < n; i++)
        sum += (unsigned char)payload[i];
    snprintf(dst, cap, "%s$%s#%c%c", ack ? "+" : "", payload,
            hx[(sum >> 4) & 15], hx[sum & 15]);
}

/* Sends a raw body (escapes already applied) with a correct checksum. */
static void send_raw(XNGdb *g, const char *body)
{
    char pkt[8192];
    unsigned sum = 0;
    size_t i, n = strlen(body);
    static const char hx[] = "0123456789abcdef";

    for (i = 0; i < n; i++)
        sum += (unsigned char)body[i];
    snprintf(pkt, sizeof(pkt), "$%s#%c%c", body, hx[(sum >> 4) & 15], hx[sum & 15]);
    xn_gdb_input(g, (const uint8_t *)pkt, (int)strlen(pkt));
}

/* Sends a packet and checks the complete output: ack, then the framed reply. */
static int expect_reply(XNGdb *g, const char *body, const char *payload,
                        const char *what)
{
    char got[16384], want[8192];

    outlen = 0;
    send_raw(g, body);
    take_out(got, sizeof(got));
    frame(want, sizeof(want), payload, 1);
    if (strcmp(got, want) != 0) {
        printf("FAIL: %s\n  got:  %.200s\n  want: %.200s\n", what, got, want);
        return 0;
    }
    return 1;
}

/* Packet with no reply (c, s, k, D with noack handled by caller). */
static int expect_silent(XNGdb *g, const char *body, const char *what)
{
    char got[16384];

    outlen = 0;
    send_raw(g, body);
    take_out(got, sizeof(got));
    if (strcmp(got, "+") != 0) {
        printf("FAIL: %s: expected only an ack, got \"%s\"\n", what, got);
        return 0;
    }
    return 1;
}

static void reset_all(void)
{
    memset(fake_reg, 0, sizeof(fake_reg));
    memset(fake_mem, 0, sizeof(fake_mem));
    resume_calls = 0;
    outlen = 0;
}

static int test_framing(void)
{
    XNGdb *g = xn_gdb_new(&fake_ops, NULL, capture, NULL);
    char got[256], want[64];

    CHECK(g != NULL, "xn_gdb_new");
    /* good checksum: ack, then the stop reply for '?' */
    CHECK(expect_reply(g, "?", "T05thread:1;", "? with good checksum"), "good checksum");

    /* bad checksum: '-' and no reply */
    outlen = 0;
    xn_gdb_input(g, (const uint8_t *)"$?#00", 5);
    take_out(got, sizeof(got));
    CHECK_STR(got, "-", "bad checksum gets a nack");

    /* packet split across input calls, and acks from the client ignored */
    outlen = 0;
    xn_gdb_input(g, (const uint8_t *)"+$?#", 4);
    xn_gdb_input(g, (const uint8_t *)"3f", 2);
    take_out(got, sizeof(got));
    frame(want, sizeof(want), "T05thread:1;", 1);
    CHECK_STR(got, want, "split packet is reassembled");

    /* unknown packet: empty reply */
    CHECK(expect_reply(g, "vFoo:bar", "", "unknown packet"), "unknown packet");
    xn_gdb_free(g);
    return 0;
}

static int test_queries(void)
{
    XNGdb *g = xn_gdb_new(&fake_ops, NULL, capture, NULL);
    size_t total = sizeof(xn_gdb_target_xml) - 1;
    char body[256], payload[4096];

    CHECK(expect_reply(g, "qSupported:multiprocess+",
                       "PacketSize=4000;qXfer:features:read+;QStartNoAckMode+;"
                       "swbreak+;hwbreak+", "qSupported"), "qSupported");
    CHECK(expect_reply(g, "qAttached", "1", "qAttached"), "qAttached");
    CHECK(expect_reply(g, "qC", "QC1", "qC"), "qC");
    CHECK(expect_reply(g, "qfThreadInfo", "m1", "qfThreadInfo"), "qfThreadInfo");
    CHECK(expect_reply(g, "qsThreadInfo", "l", "qsThreadInfo"), "qsThreadInfo");
    CHECK(expect_reply(g, "qOffsets", "", "qOffsets"), "qOffsets");
    CHECK(expect_reply(g, "qSymbol::", "OK", "qSymbol"), "qSymbol");
    CHECK(expect_reply(g, "qTStatus", "", "qTStatus"), "qTStatus");
    CHECK(expect_reply(g, "vMustReplyEmpty", "", "vMustReplyEmpty"), "vMustReplyEmpty");
    CHECK(expect_reply(g, "vCont?", "", "vCont?"), "vCont?");
    CHECK(expect_reply(g, "Hg0", "OK", "H"), "H");

    /* qXfer chunking: a middle chunk is 'm', the last is 'l' */
    snprintf(body, sizeof(body), "qXfer:features:read:target.xml:0,a"); /* hex: 10 bytes */
    memcpy(payload, "m", 1);
    memcpy(payload + 1, xn_gdb_target_xml, 10);
    payload[11] = 0;
    CHECK(expect_reply(g, body, payload, "qXfer first chunk"), "qXfer m chunk");

    snprintf(body, sizeof(body), "qXfer:features:read:target.xml:%x,%x",
             (unsigned)(total - 5), 100u);
    memcpy(payload, "l", 1);
    memcpy(payload + 1, xn_gdb_target_xml + total - 5, 5);
    payload[6] = 0;
    CHECK(expect_reply(g, body, payload, "qXfer last chunk"), "qXfer l chunk");

    snprintf(body, sizeof(body), "qXfer:features:read:target.xml:%x,10",
             (unsigned)total + 1);
    CHECK(expect_reply(g, body, "l", "qXfer past end"), "qXfer past end");

    CHECK(expect_reply(g, "qXfer:features:read:target.xml:05", "E01",
                       "qXfer without comma"), "qXfer malformed");
    CHECK(strstr(xn_gdb_target_xml, "org.gnu.gdb.riscv.fpu") != NULL, "xml has fpu feature");
    CHECK(strstr(xn_gdb_target_xml, "riscv:rv64") != NULL, "xml has architecture");

    /* escapes are decoded before dispatch: '}' 0x1a is ':' (0x3a ^ 0x20) */
    CHECK(expect_reply(g, "qSupported}\x1amultiprocess+",
                       "PacketSize=4000;qXfer:features:read+;QStartNoAckMode+;"
                       "swbreak+;hwbreak+", "escaped body"), "escape decoding");
    CHECK(expect_reply(g, "qSupported}", "", "dangling escape"), "dangling escape");
    xn_gdb_free(g);
    return 0;
}

static int test_registers(void)
{
    XNGdb *g = xn_gdb_new(&fake_ops, NULL, capture, NULL);
    char payload[1024];
    int i;

    reset_all();
    fake_reg[32] = 0x1000;                     /* pc */
    fake_reg[5] = 0x1122334455667788ull;       /* t0 */
    fake_reg[33] = 0x3ff0000000000000ull;      /* f0 = 1.0 */
    fake_reg[65] = 0x1f;                       /* fflags */
    fake_reg[67] = 0xe0;                       /* fcsr */

    CHECK(expect_reply(g, "p20", "0010000000000000", "p pc"), "p pc");
    CHECK(expect_reply(g, "p5", "8877665544332211", "p t0 little endian"), "p t0");
    CHECK(expect_reply(g, "p21", "000000000000f03f", "p f0"), "p f0");
    CHECK(expect_reply(g, "p41", "1f000000", "p fflags is 4 bytes"), "p fflags");
    CHECK(expect_reply(g, "p43", "e0000000", "p fcsr is 4 bytes"), "p fcsr");
    CHECK(expect_reply(g, "p45", "E01", "p unknown reg"), "p unknown");
    CHECK(expect_reply(g, "p100", "E01", "p out of range"), "p out of range");
    CHECK(expect_reply(g, "p100000000", "E01", "p 33-bit register number"),
          "p truncation guard");

    /* P write then p read back */
    CHECK(expect_reply(g, "P21=0000000000000040", "OK", "P f0"), "P f0");
    CHECK_EQ(fake_reg[33], 0x4000000000000000ull, "P stored the value");
    CHECK(expect_reply(g, "p21", "0000000000000040", "p after P"), "p after P");
    CHECK(expect_reply(g, "P41=0a000000", "OK", "P fflags"), "P fflags");
    CHECK_EQ(fake_reg[65], 0x0a, "P fflags value");
    CHECK(expect_reply(g, "P41=0a00", "E01", "P with wrong width"), "P width");

    /* g: 33 registers, 16 hex chars each */
    outlen = 0;
    send_raw(g, "g");
    {
        char got[16384];
        take_out(got, sizeof(got));
        CHECK(got[0] == '+', "g is acked");
        CHECK(got[1] == '$', "g reply starts a packet");
        /* payload is everything between '$' and '#' */
        {
            char *hash = strchr(got, '#');
            CHECK(hash != NULL, "g reply has a '#'");
            CHECK_EQ(hash - (got + 2), 33 * 16, "g length is 33*16");
            memcpy(payload, got + 2, 33 * 16);
            payload[33 * 16] = 0;
        }
    }
    CHECK(strncmp(payload + 32 * 16, "0010000000000000", 16) == 0, "g pc");

    /* G: write all 33 registers from a g-style payload */
    for (i = 0; i < 33; i++)
        fake_reg[i] = 0;
    {
        char gbody[1 + 33 * 16 + 1];
        gbody[0] = 'G';
        for (i = 0; i < 33; i++)
            strncpy(gbody + 1 + 16 * i, "0100000000000000", 16);
        gbody[1 + 33 * 16] = 0;
        CHECK(expect_reply(g, gbody, "OK", "G"), "G");
    }
    CHECK_EQ(fake_reg[32], 1, "G wrote pc");
    CHECK(expect_reply(g, "G00", "E01", "G with short payload"), "G length");
    xn_gdb_free(g);
    return 0;
}

static int test_memory(void)
{
    XNGdb *g = xn_gdb_new(&fake_ops, NULL, capture, NULL);

    reset_all();
    CHECK(expect_reply(g, "M100,4:deadbeef", "OK", "M write"), "M write");
    CHECK(memcmp(fake_mem + 0x100, "\xde\xad\xbe\xef", 4) == 0, "M stored bytes");
    CHECK(expect_reply(g, "m100,4", "deadbeef", "m read"), "m read");
    CHECK(expect_reply(g, "m0,0", "", "zero-length read"), "zero-length m");
    CHECK(expect_reply(g, "m10000,4", "E14", "m fault"), "m fault");
    CHECK(expect_reply(g, "M10000,1:00", "E14", "M fault"), "M fault");
    CHECK(expect_reply(g, "M100,2:abc", "E01", "M with short data"), "M length");
    CHECK(expect_reply(g, "m100,4zz", "E01", "m with junk"), "m junk");
    xn_gdb_free(g);
    return 0;
}

static int test_breakpoints_and_run(void)
{
    XNGdb *g = xn_gdb_new(&fake_ops, NULL, capture, NULL);

    reset_all();
    CHECK(expect_reply(g, "Z0,2000,2", "OK", "Z0"), "Z0");
    CHECK(xn_gdb_has_breakpoints(g), "has breakpoints after Z0");
    CHECK(xn_gdb_breakpoint_at(g, 0x2000), "breakpoint_at after Z0");
    CHECK(!xn_gdb_breakpoint_at(g, 0x2002), "no breakpoint at a neighbour");
    CHECK(expect_reply(g, "Z1,3000,4", "OK", "Z1"), "Z1");
    CHECK(xn_gdb_breakpoint_at(g, 0x3000), "breakpoint_at after Z1");
    CHECK(expect_reply(g, "z0,2000,2", "OK", "z0"), "z0");
    CHECK(!xn_gdb_breakpoint_at(g, 0x2000), "z0 removes the breakpoint");
    CHECK(xn_gdb_has_breakpoints(g), "Z1 breakpoint remains");

    /* c resumes without a reply; the machine later reports the stop */
    xn_gdb_halt_initial(g);
    CHECK(xn_gdb_halted(g), "halt_initial");
    CHECK(expect_reply(g, "?", "T05thread:1;", "? while halted"), "? halted");
    CHECK(expect_silent(g, "c", "c"), "c is silent");
    CHECK_EQ(resume_calls, 1, "c calls on_resume");
    CHECK(!xn_gdb_halted(g), "c resumes");
    CHECK(!xn_gdb_stepping(g), "c is not a step");

    outlen = 0;
    xn_gdb_stop(g, 5);
    {
        char got[256], want[64];
        take_out(got, sizeof(got));
        frame(want, sizeof(want), "T05thread:1;", 0);
        CHECK_STR(got, want, "stop reply is T05thread:1;");
    }
    CHECK(xn_gdb_halted(g), "stop halts");

    /* s: one instruction, flagged as stepping */
    CHECK(expect_silent(g, "s", "s"), "s is silent");
    CHECK(xn_gdb_stepping(g), "s sets stepping");
    CHECK(!xn_gdb_halted(g), "s resumes");
    xn_gdb_stop(g, 5);
    CHECK(!xn_gdb_stepping(g), "stop clears stepping");
    outlen = 0;

    /* c with an address writes pc first */
    CHECK(expect_silent(g, "c1234", "c with address"), "c address");
    CHECK_EQ(fake_reg[32], 0x1234, "c address sets pc");
    xn_gdb_stop(g, 5);
    outlen = 0;

    /* ctrl-C while running halts and reports SIGINT */
    CHECK(expect_silent(g, "c", "c for ctrl-C"), "c before ctrl-C");
    outlen = 0;
    xn_gdb_input(g, (const uint8_t *)"\x03", 1);
    {
        char got[256], want[64];
        take_out(got, sizeof(got));
        frame(want, sizeof(want), "T02thread:1;", 0);
        CHECK_STR(got, want, "ctrl-C reply is T02");
    }
    CHECK(xn_gdb_halted(g), "ctrl-C halts");

    /* D clears breakpoints and resumes */
    CHECK(expect_reply(g, "D", "OK", "D"), "D");
    CHECK(!xn_gdb_has_breakpoints(g), "D clears breakpoints");
    CHECK(!xn_gdb_halted(g), "D resumes");
    CHECK(!xn_gdb_killed(g), "D is not a kill");
    xn_gdb_free(g);
    return 0;
}

static int test_noack(void)
{
    XNGdb *g = xn_gdb_new(&fake_ops, NULL, capture, NULL);
    char got[256], want[64];

    reset_all();
    outlen = 0;
    send_raw(g, "QStartNoAckMode");
    take_out(got, sizeof(got));
    CHECK_STR(got, "+$OK#9a", "QStartNoAckMode is acked then OK");

    /* after the switch: no '-' for a bad sum, and no '+' before replies */
    outlen = 0;
    xn_gdb_input(g, (const uint8_t *)"$?#00", 5);
    take_out(got, sizeof(got));
    CHECK_STR(got, "", "bad checksum is silent in no-ack mode");
    outlen = 0;
    send_raw(g, "?");
    take_out(got, sizeof(got));
    frame(want, sizeof(want), "T05thread:1;", 0);
    CHECK_STR(got, want, "reply carries no '+' in no-ack mode");
    xn_gdb_free(g);
    return 0;
}

static int test_interrupt_and_kill(void)
{
    XNGdb *g = xn_gdb_new(&fake_ops, NULL, capture, NULL);

    reset_all();
    CHECK(!xn_gdb_killed(g), "not killed at start");
    outlen = 0;
    send_raw(g, "k");
    CHECK(xn_gdb_killed(g), "k marks killed");
    CHECK_EQ(outlen, 1, "k sends only the ack");
    outlen = 0;
    xn_gdb_free(g);
    return 0;
}

static int test_unsupported_and_bad(void)
{
    XNGdb *g = xn_gdb_new(&fake_ops, NULL, capture, NULL);

    reset_all();
    CHECK(expect_reply(g, "X100,2:ab", "", "X is unsupported"), "X");
    CHECK(expect_reply(g, "Z2,100,4", "", "watchpoint unsupported"), "Z2");
    CHECK(expect_reply(g, "Zfoo", "", "malformed Z"), "Z malformed");
    CHECK(expect_reply(g, "p", "E01", "p without a register number"), "empty p");
    CHECK(expect_reply(g, "M100,4", "E01", "M without data"), "M no data");
    xn_gdb_free(g);
    return 0;
}

int main(void)
{
    int fails = 0;

    fails += test_framing();
    fails += test_queries();
    fails += test_registers();
    fails += test_memory();
    fails += test_breakpoints_and_run();
    fails += test_noack();
    fails += test_interrupt_and_kill();
    fails += test_unsupported_and_bad();
    if (fails)
        return 1;
    puts("ok");
    return 0;
}
