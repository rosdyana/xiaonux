/*
 * xiaonux RISC-V -> WebAssembly block translator (Phase 4b).
 *
 * Hot blocks of guest code (RV64I + M + C, integer only) become WASM
 * functions `(i32 state) -> i32`. Blocks are keyed by the host pointer of
 * their first instruction (= physical address), compiled in batches into one
 * WASM module each, and called through the Emscripten function table.
 * Everything this doesn't handle is left to TinyEMU's interpreter.
 *
 * Copyright (c) 2026 xiaonux authors.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <inttypes.h>
#include <emscripten.h>

#include "cutils.h"
#include "iomem.h"
#include "riscv_cpu.h"
#include "riscv_cpu_priv.h"
#include "xn_jit.h"

/* ------------------------------------------------------------------ */
/* tuning */

#define HOT_THRESHOLD   1000
#define MAX_BLOCK_INSNS 64
#define BATCH_MAX       64
#define COUNTER_BITS    16       /* lossy hot counters, by hash of the key */
#define FAST_BITS       12       /* direct-mapped cache in front of the table */
#define TABLE_BITS      16
#define TABLE_SIZE      (1 << TABLE_BITS)
#define MAX_BLOCKS      (TABLE_SIZE / 2)   /* full reset beyond this */

/* ------------------------------------------------------------------ */
/* block cache */

enum { B_COUNTING = 0, B_QUEUED = 1, B_READY = 2, B_UNTRANSLATABLE = 3 };

typedef struct {
    uint32_t key;        /* host address of the first instruction, 0 = empty */
    int32_t fn;          /* table index when READY */
    uint16_t ninsn;
    uint8_t state;
    uint16_t count;
    int32_t next_in_page; /* entry index, -1 = end */
} Block;

static Block blocks[TABLE_SIZE];
static int n_blocks;
static uint8_t *ram_base;
static uint64_t ram_size;
static int32_t *page_head;   /* per RAM page: first block, -1 = none */
static uint8_t *code_page;   /* per RAM page: has translations */
static uint8_t *page_inval;  /* per RAM page: invalidations so far (saturating) */
static uint32_t *page_gen;    /* per RAM page: bumped on invalidation (stale async regions) */
static uint32_t *page_rseq;   /* per RAM page: last region build sequence number */
static uint32_t *page_rinst;  /* per RAM page: sequence number of the installed region */
static uint16_t *page_rn;     /* per RAM page: blocks in the last region built */
static void pend_clear(void);
static int jit_enabled = 1;
extern int xn_check_mode;
static RISCVCPUState *cpu;

static uint32_t queue[BATCH_MAX];
static int queue_len;
static uint16_t counters[1 << COUNTER_BITS];
static struct { uint32_t key; int32_t fn; int32_t ninsn; } fast[1 << FAST_BITS];

static inline uint32_t fast_idx(uint32_t key) { return (key >> 1) & ((1 << FAST_BITS) - 1); }

/* stats */
static uint64_t st_translated, st_modules, st_invalidated, st_resets, st_untranslatable, st_preloaded_hits;
static xn_block_fn preload_lookup(uint8_t *ptr, int *ninsn);
static int n_pre;

static inline uint32_t hash_key(uint32_t k)
{
    k ^= k >> 16;
    k *= 0x7feb352d;
    k ^= k >> 15;
    return k & (TABLE_SIZE - 1);
}

static Block *find(uint32_t key, int create)
{
    uint32_t i = hash_key(key);
    for (;;) {
        Block *b = &blocks[i];
        if (b->key == key)
            return b;
        if (b->key == 0) {
            if (!create)
                return NULL;
            if (n_blocks >= MAX_BLOCKS)
                return NULL;
            memset(b, 0, sizeof(*b));
            b->key = key;
            b->next_in_page = -1;
            n_blocks++;
            return b;
        }
        i = (i + 1) & (TABLE_SIZE - 1);
    }
}

/* Offset within the guest page. The host RAM buffer isn't 4 KB aligned in
   the WASM heap, so this must be relative to the RAM base (which is). */
static inline uint32_t page_off(uintptr_t host)
{
    return (uint32_t)(host - (uintptr_t)ram_base) & 4095;
}

static inline int ram_page_of(uint32_t host)
{
    uint64_t off = (uint64_t)(host - (uint32_t)(uintptr_t)ram_base);
    if (off >= ram_size)
        return -1;
    return (int)(off >> 12);
}

void xn_jit_init(RISCVCPUState *s, uint8_t *ram, uint64_t size)
{
    int n = size >> 12;
    if (!ram)
        abort(); /* must run after RAM is registered */
    cpu = s;
    ram_base = ram;
    ram_size = size;
    free(page_head);
    free(code_page);
    free(page_inval); free(page_gen); free(page_rseq); free(page_rinst); free(page_rn);
    page_head = malloc(n * sizeof(int32_t));
    code_page = mallocz(n);
    page_inval = mallocz(n);
    page_gen = mallocz(n * sizeof(uint32_t));
    page_rseq = mallocz(n * sizeof(uint32_t));
    page_rinst = mallocz(n * sizeof(uint32_t));
    page_rn = mallocz(n * sizeof(uint16_t));
    xn_jit_reset();
}

EM_JS(void, js_jit_reset_slots, (void), {
    if (Module.xnJit) Module.xnJit.next = Module.xnJit.base;
});

void xn_jit_reset(void)
{
    int i, n = ram_size >> 12;
    memset(blocks, 0, sizeof(blocks));
    n_blocks = 0;
    queue_len = 0;
    for (i = 0; i < n; i++)
        page_head[i] = -1;
    if (code_page)
        memset(code_page, 0, n);
    if (page_inval)
        memset(page_inval, 0, n);
    if (page_rn) {
        memset(page_gen, 0, n * sizeof(uint32_t));
        memset(page_rseq, 0, n * sizeof(uint32_t));
        memset(page_rinst, 0, n * sizeof(uint32_t));
        memset(page_rn, 0, n * sizeof(uint16_t));
    }
    pend_clear();
    memset(counters, 0, sizeof(counters));
    memset(fast, 0, sizeof(fast));
    js_jit_reset_slots();
    st_resets++;
}

int xn_jit_inval_hit;

/* Drop all translations in the RAM page containing host address `host`. */
void xn_jit_invalidate_host_page(uintptr_t host)
{
    int page = ram_page_of((uint32_t)host), e;
    if (page < 0 || !code_page[page])
        return;
    xn_jit_inval_hit = 1;   /* the running block/region may hold stale code: helpers make it leave */
    if (page_inval[page] < 255) page_inval[page]++;
    page_gen[page]++;   /* regions still compiling for this page are now stale */
    page_rn[page] = 0;
    /* unlink as we go: a retranslated block is linked in again later */
    for (e = page_head[page]; e >= 0; ) {
        Block *b = &blocks[e];
        int next = b->next_in_page;
        b->next_in_page = -1;
        if (fast[fast_idx(b->key)].key == b->key)
            fast[fast_idx(b->key)].key = 0;
        if (b->state == B_READY || b->state == B_QUEUED) {
            b->state = B_COUNTING;
            b->count = 0;
            b->fn = 0;
            st_invalidated++;
        }
        e = next;
    }
    page_head[page] = -1;
    code_page[page] = 0;
    /* queued keys in this page are dropped at flush time (state check) */
}

int xn_jit_page_has_code(uintptr_t host)
{
    int page = ram_page_of((uint32_t)host);
    return page >= 0 && code_page[page];
}

/* Called by the interpreter at every block fetch. */
xn_block_fn xn_jit_lookup(uint8_t *ptr, int *ninsn)
{
    uint32_t key = (uint32_t)(uintptr_t)ptr, fi = fast_idx(key);
    Block *b;
    if (fast[fi].key == key) {
        *ninsn = fast[fi].ninsn;
        return (xn_block_fn)(uintptr_t)fast[fi].fn;
    }
    if (!jit_enabled || ram_page_of(key) < 0)
        return NULL;
    b = find(key, 0);
    if (b && b->state != B_COUNTING) {
        if (b->state != B_READY)
            return NULL;
        fast[fi].key = key;
        fast[fi].fn = b->fn;
        fast[fi].ninsn = b->ninsn;
        *ninsn = b->ninsn;
        return (xn_block_fn)(uintptr_t)b->fn;
    }
    /* not translated: count (lossy), queue when hot */
    {
        uint16_t *c = &counters[hash_key(key) & ((1 << COUNTER_BITS) - 1)];
        int pg = ram_page_of(key);   /* >= 0 here, checked above */
        if (*c < 2 && n_pre) {
            /* first runs: maybe we shipped this exact code already */
            xn_block_fn f = preload_lookup(ptr, ninsn);
            if (f) return f;
        }
        if (++*c >= HOT_THRESHOLD && queue_len < BATCH_MAX && page_inval[pg] < 4) {
            *c = 0;
            b = find(key, 1);
            if (b && b->state == B_COUNTING) {
                b->state = B_QUEUED;
                queue[queue_len++] = key;
            }
        }
    }
    return NULL;
}

/* measurement counters (exposed via xn_jit_stat 27..50) */
static uint64_t st_trans[5];        /* block exits by return code: 0 end,1 exc,2 direct,3 jalr,4 loop bail */
static uint64_t st_trans_same[5];   /* ... whose next pc is in the same 4 KB guest page as the block's entry pc */
static uint64_t st_jit_insns;       /* guest instructions retired by translated code */
static uint64_t st_entry_hist[8];   /* insns per block call: [0]=1,[1]=2-3,[2]=4-7,[3]=8-15,[4]=16-31,[5]=32-63,[6]=64-127,[7]=128+ */
static uint64_t st_stop[4];         /* why xn_jit_run returned: 0 budget/interrupt/power, 1 code TLB miss, 2 lookup miss, 3 budget < block len */
static uint64_t st_runs;            /* xn_jit_run calls (entries from the interpreter) */

/* Run translated blocks back to back while the next one is translated, the
   budget covers it and no interrupt is pending (the interpreter checks
   those between blocks). Returns when the interpreter must take over. */
/* XN_JIT_STATS: per-transition counters (hot loop; off by default) */
#ifdef XN_JIT_STATS
#define ST(x) x
#else
#define ST(x) do { } while (0)
#endif

void xn_jit_run(RISCVCPUState *s, xn_block_fn f)
{
    ST(st_runs++);
    for (;;) {
        target_ulong pc;
        uint32_t idx;
        int n, rc;
#ifdef XN_JIT_STATS
        int nc0 = s->n_cycles, d, k, b = 0;
        target_ulong pc0 = s->pc;
#endif
        rc = f(s);
        (void)rc;
#ifdef XN_JIT_STATS
        d = nc0 - s->n_cycles;
        st_jit_insns += d;
        k = (unsigned)rc < 5 ? rc : 1;
        st_trans[k]++;
        if (((s->pc ^ pc0) >> 12) == 0) st_trans_same[k]++;
        while (b < 7 && d >= (2 << b)) b++;
        st_entry_hist[b]++;
#endif
        if (s->n_cycles <= 0 || (s->mip & s->mie) || s->power_down_flag) { ST(st_stop[0]++); return; }
        pc = s->pc;
        idx = (pc >> PG_SHIFT) & (TLB_SIZE - 1);
        if (s->tlb_code[idx].vaddr != (pc & ~(target_ulong)PG_MASK)) { ST(st_stop[1]++); return; } /* code TLB miss: let the interpreter refill it */
        f = xn_jit_lookup((uint8_t *)(s->tlb_code[idx].mem_addend + (uintptr_t)pc), &n);
        if (!f) { ST(st_stop[2]++); return; }
        if (s->n_cycles < n) { ST(st_stop[3]++); return; }
    }
}

EMSCRIPTEN_KEEPALIVE void xn_jit_set_enabled(int on)
{
    jit_enabled = on;
    if (!on)
        xn_jit_reset();
}

/* debug: print the module holding table index fn as base64 + function number */
EM_JS(void, js_jit_dump, (int fn), {
    const J = Module.xnJit; if (!J || !J.mods) return;
    const m = J.mods.findLast((m) => fn >= m.first && fn < m.first + m.n);
    if (!m) return;
    let s = ''; for (const b of m.bytes) s += String.fromCharCode(b);
    console.log('[xn-dump] func f' + (fn - m.first) + ' ' + btoa(s));
});

void xn_jit_dump(int fn) { js_jit_dump(fn); }

EMSCRIPTEN_KEEPALIVE void xn_jit_set_check(int on)
{
    xn_check_mode = on;
    xn_jit_reset();
}

extern uint64_t xn_exec1_count[9], xn_exec1_nx[9], xn_mulh_count, xn_div_count; /* riscv_cpu.c */
extern uint64_t xn_check_count, xn_check_skipped;
static uint64_t st_regions, st_region_blocks;   /* page regions built, blocks routed through them */

EMSCRIPTEN_KEEPALIVE double xn_jit_stat(int which)
{
    switch (which) {
    case 0: return (double)st_translated;
    case 1: return (double)st_modules;
    case 2: return (double)st_invalidated;
    case 3: return (double)st_resets;
    case 4: return (double)n_blocks;
    case 5: return (double)st_untranslatable;
    case 6: return (double)st_preloaded_hits;
    case 25: return (double)xn_mulh_count;
    case 26: return (double)xn_div_count;
    case 37: return (double)st_jit_insns;
    case 50: return (double)st_runs;
    case 51: return (double)st_regions;
    case 52: return (double)st_region_blocks;
    case 53: return (double)xn_check_count;
    case 54: return (double)xn_check_skipped;
    default:
        if (which >= 7 && which <= 15) return (double)xn_exec1_count[which - 7];
        if (which >= 16 && which <= 24) return (double)xn_exec1_nx[which - 16];
        if (which >= 27 && which <= 31) return (double)st_trans[which - 27];
        if (which >= 32 && which <= 36) return (double)st_trans_same[which - 32];
        if (which >= 38 && which <= 45) return (double)st_entry_hist[which - 38];
        if (which >= 46 && which <= 49) return (double)st_stop[which - 46];
        return 0;
    }
}

/* ------------------------------------------------------------------ */
/* decoder: RV64I + M + C (integer subset) */

enum {
    OP_INVALID = 0,
    OP_LUI, OP_AUIPC, OP_JAL, OP_JALR,
    OP_BEQ, OP_BNE, OP_BLT, OP_BGE, OP_BLTU, OP_BGEU,
    OP_LB, OP_LH, OP_LW, OP_LD, OP_LBU, OP_LHU, OP_LWU,
    OP_SB, OP_SH, OP_SW, OP_SD,
    OP_ADDI, OP_SLTI, OP_SLTIU, OP_XORI, OP_ORI, OP_ANDI, OP_SLLI, OP_SRLI, OP_SRAI,
    OP_ADDIW, OP_SLLIW, OP_SRLIW, OP_SRAIW,
    OP_ADD, OP_SUB, OP_SLL, OP_SLT, OP_SLTU, OP_XOR, OP_SRL, OP_SRA, OP_OR, OP_AND,
    OP_ADDW, OP_SUBW, OP_SLLW, OP_SRLW, OP_SRAW,
    OP_MUL, OP_MULH, OP_MULHSU, OP_MULHU, OP_DIV, OP_DIVU, OP_REM, OP_REMU,
    OP_MULW, OP_DIVW, OP_DIVUW, OP_REMW, OP_REMUW,
    OP_NOP,      /* fence */
    OP_FLD, OP_FSD, OP_FSGNJ_D, OP_FMV_X_D, OP_FMV_D_X, OP_FARITH_D, OP_FCMP_D,   /* inline FP (FARITH/FCMP: native fast path, exact fallback) */
    OP_EXEC1,    /* run this one instruction on the interpreter (FP, AMO, FP CSRs) */
};

typedef struct {
    uint8_t op, rd, rs1, rs2, len;   /* rd/rs1/rs2: integer registers (0 = none) */
    uint8_t stores;   /* EXEC1: may write memory (checker can't replay it) */
    uint8_t frd, frs1, frs2;         /* FP registers of inline FP ops */
    uint8_t sub;                     /* FSGNJ_D: 0 = j, 1 = jn, 2 = jx;
                                        FARITH_D: 0 add 1 sub 2 mul 3 div 4 sqrt; FCMP_D: 0 fle 1 flt 2 feq */
    uint8_t rm;                      /* FARITH_D: static rounding mode (7 = dynamic) */
    uint32_t raw;                    /* the instruction (for the FP-disabled fallback) */
    int64_t imm;
} Insn;

static inline int64_t sext(uint64_t v, int bits)
{
    return (int64_t)(v << (64 - bits)) >> (64 - bits);
}
#define BITS(x, hi, lo) (((x) >> (lo)) & ((1u << ((hi) - (lo) + 1)) - 1))

static int decode32(uint32_t x, Insn *d)
{
    uint32_t opc = x & 0x7f, f3 = BITS(x, 14, 12), f7 = BITS(x, 31, 25);
    d->rd = BITS(x, 11, 7);
    d->rs1 = BITS(x, 19, 15);
    d->rs2 = BITS(x, 24, 20);
    d->len = 4;
    d->stores = 0;
    d->frd = d->frs1 = d->frs2 = 0;
    d->raw = x;
    if (opc == 0x07 && f3 == 3) {                           /* fld */
        d->op = OP_FLD; d->frd = d->rd; d->rd = 0; d->rs2 = 0; d->imm = sext(x >> 20, 12); return 1;
    }
    if (opc == 0x27 && f3 == 3) {                           /* fsd */
        d->op = OP_FSD; d->frs2 = d->rs2; d->rs2 = 0; d->rd = 0;
        d->imm = sext((BITS(x, 31, 25) << 5) | BITS(x, 11, 7), 12); return 1;
    }
    if (opc == 0x53 && f7 == 0x11 && f3 <= 2) {            /* fsgnj{,n,x}.d */
        d->op = OP_FSGNJ_D; d->sub = f3; d->frd = d->rd; d->frs1 = d->rs1; d->frs2 = d->rs2;
        d->rd = d->rs1 = d->rs2 = 0; return 1;
    }
    if (opc == 0x53 && (f3 == 0 || f3 == 7) &&
        (f7 == 0x01 || f7 == 0x05 || f7 == 0x09 || f7 == 0x0d || (f7 == 0x2d && d->rs2 == 0))) {
        /* fadd/fsub/fmul/fdiv/fsqrt.d in RNE or dynamic rounding: native fast path */
        d->op = OP_FARITH_D; d->sub = f7 == 0x2d ? 4 : f7 >> 2; d->rm = f3;
        d->frd = d->rd; d->frs1 = d->rs1; d->frs2 = f7 == 0x2d ? 0 : d->rs2;
        d->rd = d->rs1 = d->rs2 = 0; return 1;
    }
    if (opc == 0x53 && f7 == 0x51 && f3 <= 2) {             /* fle/flt/feq.d */
        d->op = OP_FCMP_D; d->sub = f3; d->frs1 = d->rs1; d->frs2 = d->rs2;
        d->rs1 = d->rs2 = 0; return 1;                     /* rd stays: integer result */
    }
    if (opc == 0x53 && f7 == 0x71 && f3 == 0 && d->rs2 == 0) { /* fmv.x.d */
        d->op = OP_FMV_X_D; d->frs1 = d->rs1; d->rs1 = 0; return 1;
    }
    if (opc == 0x53 && f7 == 0x79 && f3 == 0 && d->rs2 == 0) { /* fmv.d.x */
        d->op = OP_FMV_D_X; d->frd = d->rd; d->rd = 0; return 1;
    }
    switch (opc) {
    /* run on the interpreter, one instruction at a time (exact FP semantics:
       rounding modes, fflags, NaN boxing). d->rd = integer destination or 0. */
    case 0x07: d->op = OP_EXEC1; d->rd = 0; d->rs2 = 0; return 1;                  /* fl* */
    case 0x27: d->op = OP_EXEC1; d->rd = 0; d->stores = 1; return 1;               /* fs* */
    case 0x43: case 0x47: case 0x4b: case 0x4f: d->op = OP_EXEC1; d->rd = 0; d->rs1 = d->rs2 = 0; return 1;
    case 0x53: {
        /* integer results: fcvt.{w,wu,l,lu}.*, fmv.x.*, fclass, feq/flt/fle */
        uint32_t f = f7 & ~1u;  /* drop the format bit */
        int int_rd = f == 0x60 || f == 0x70 || f == 0x50;
        int int_rs1 = f == 0x68 || f == 0x78;          /* fcvt.*.{w,l}, fmv.*.x */
        d->op = OP_EXEC1;
        if (!int_rd) d->rd = 0;
        if (!int_rs1) d->rs1 = 0;
        d->rs2 = 0;
        return 1;
    }
    case 0x2f: d->op = OP_EXEC1; d->stores = 1; return 1;                           /* AMO, LR/SC */
    case 0x0f: if (f3 != 0) return 0; d->op = OP_NOP; d->rd = d->rs1 = d->rs2 = 0; return 1; /* fence */
    case 0x73: {                                                                    /* FP CSRs only */
        uint32_t csr = x >> 20;
        if (f3 == 0 || f3 == 4 || csr < 1 || csr > 3) return 0;
        d->op = OP_EXEC1; d->rs2 = 0;
        if (f3 >= 5) d->rs1 = 0;  /* immediate forms */
        return 1;
    }
    case 0x37: d->op = OP_LUI; d->rs1 = d->rs2 = 0; d->imm = (int32_t)(x & 0xfffff000); return 1;
    case 0x17: d->op = OP_AUIPC; d->rs1 = d->rs2 = 0; d->imm = (int32_t)(x & 0xfffff000); return 1;
    case 0x6f:
        d->op = OP_JAL; d->rs1 = d->rs2 = 0;
        d->imm = sext((BITS(x, 31, 31) << 20) | (BITS(x, 19, 12) << 12) |
                      (BITS(x, 20, 20) << 11) | (BITS(x, 30, 21) << 1), 21);
        return 1;
    case 0x67:
        if (f3 != 0) return 0;
        d->op = OP_JALR; d->rs2 = 0; d->imm = sext(x >> 20, 12); return 1;
    case 0x63: {
        static const uint8_t ops[8] = { OP_BEQ, OP_BNE, 0, 0, OP_BLT, OP_BGE, OP_BLTU, OP_BGEU };
        if (!ops[f3]) return 0;
        d->op = ops[f3]; d->rd = 0;
        d->imm = sext((BITS(x, 31, 31) << 12) | (BITS(x, 7, 7) << 11) |
                      (BITS(x, 30, 25) << 5) | (BITS(x, 11, 8) << 1), 13);
        return 1;
    }
    case 0x03: {
        static const uint8_t ops[8] = { OP_LB, OP_LH, OP_LW, OP_LD, OP_LBU, OP_LHU, OP_LWU, 0 };
        if (!ops[f3]) return 0;
        d->op = ops[f3]; d->rs2 = 0; d->imm = sext(x >> 20, 12); return 1;
    }
    case 0x23: {
        static const uint8_t ops[8] = { OP_SB, OP_SH, OP_SW, OP_SD, 0, 0, 0, 0 };
        if (!ops[f3]) return 0;
        d->op = ops[f3]; d->rd = 0;
        d->imm = sext((BITS(x, 31, 25) << 5) | BITS(x, 11, 7), 12);
        return 1;
    }
    case 0x13:
        d->imm = sext(x >> 20, 12); d->rs2 = 0;
        switch (f3) {
        case 0: d->op = OP_ADDI; return 1;
        case 2: d->op = OP_SLTI; return 1;
        case 3: d->op = OP_SLTIU; return 1;
        case 4: d->op = OP_XORI; return 1;
        case 6: d->op = OP_ORI; return 1;
        case 7: d->op = OP_ANDI; return 1;
        case 1:
            if (BITS(x, 31, 26) != 0) return 0;
            d->op = OP_SLLI; d->imm = BITS(x, 25, 20); return 1;
        case 5:
            if (BITS(x, 31, 26) == 0x00) { d->op = OP_SRLI; d->imm = BITS(x, 25, 20); return 1; }
            if (BITS(x, 31, 26) == 0x10) { d->op = OP_SRAI; d->imm = BITS(x, 25, 20); return 1; }
            return 0;
        }
        return 0;
    case 0x1b:
        switch (f3) {
        case 0: d->op = OP_ADDIW; d->rs2 = 0; d->imm = sext(x >> 20, 12); return 1;
        case 1: if (f7 != 0) return 0; d->op = OP_SLLIW; d->imm = d->rs2; d->rs2 = 0; return 1;
        case 5:
            if (f7 == 0x00) { d->op = OP_SRLIW; d->imm = d->rs2; d->rs2 = 0; return 1; }
            if (f7 == 0x20) { d->op = OP_SRAIW; d->imm = d->rs2; d->rs2 = 0; return 1; }
            return 0;
        }
        return 0;
    case 0x33: {
        static const uint8_t base[8] = { OP_ADD, OP_SLL, OP_SLT, OP_SLTU, OP_XOR, OP_SRL, OP_OR, OP_AND };
        static const uint8_t mul[8] = { OP_MUL, OP_MULH, OP_MULHSU, OP_MULHU, OP_DIV, OP_DIVU, OP_REM, OP_REMU };
        if (f7 == 0x00) { d->op = base[f3]; return 1; }
        if (f7 == 0x01) { d->op = mul[f3]; return 1; }
        if (f7 == 0x20 && f3 == 0) { d->op = OP_SUB; return 1; }
        if (f7 == 0x20 && f3 == 5) { d->op = OP_SRA; return 1; }
        return 0;
    }
    case 0x3b:
        if (f7 == 0x00 && f3 == 0) { d->op = OP_ADDW; return 1; }
        if (f7 == 0x20 && f3 == 0) { d->op = OP_SUBW; return 1; }
        if (f7 == 0x00 && f3 == 1) { d->op = OP_SLLW; return 1; }
        if (f7 == 0x00 && f3 == 5) { d->op = OP_SRLW; return 1; }
        if (f7 == 0x20 && f3 == 5) { d->op = OP_SRAW; return 1; }
        if (f7 == 0x01) {
            static const uint8_t ops[8] = { OP_MULW, 0, 0, 0, OP_DIVW, OP_DIVUW, OP_REMW, OP_REMUW };
            if (!ops[f3]) return 0;
            d->op = ops[f3]; return 1;
        }
        return 0;
    }
    return 0;
}

/* RVC -> the equivalent base instruction (integer subset only). */
static int decode16(uint32_t x, Insn *d)
{
    uint32_t q = x & 3, f3 = BITS(x, 15, 13);
    uint32_t rd = BITS(x, 11, 7), rs2 = BITS(x, 6, 2);
    uint32_t rdp = BITS(x, 4, 2) + 8, rs1p = BITS(x, 9, 7) + 8;
    d->len = 2;
    d->rd = d->rs1 = d->rs2 = 0;
    d->stores = 0;
    d->frd = d->frs1 = d->frs2 = 0;
    d->raw = x;
    if (q == 0 && (f3 == 1 || f3 == 5)) {   /* c.fld / c.fsd: offsets as c.ld / c.sd */
        d->op = f3 == 1 ? OP_FLD : OP_FSD;
        d->rs1 = rs1p;
        if (f3 == 1) d->frd = rdp; else d->frs2 = rdp;
        d->imm = (BITS(x, 12, 10) << 3) | (BITS(x, 6, 5) << 6);
        return 1;
    }
    if (q == 2 && f3 == 1) {                 /* c.fldsp: offsets as c.ldsp */
        d->op = OP_FLD; d->rs1 = 2; d->frd = rd;
        d->imm = (BITS(x, 12, 12) << 5) | (BITS(x, 6, 5) << 3) | (BITS(x, 4, 2) << 6);
        return 1;
    }
    if (q == 2 && f3 == 5) {                 /* c.fsdsp: offsets as c.sdsp */
        d->op = OP_FSD; d->rs1 = 2; d->frs2 = rs2;
        d->imm = (BITS(x, 12, 10) << 3) | (BITS(x, 9, 7) << 6);
        return 1;
    }
    switch (q) {
    case 0:
        switch (f3) {
        case 0: { /* c.addi4spn */
            uint32_t imm = (BITS(x, 12, 11) << 4) | (BITS(x, 10, 7) << 6) | (BITS(x, 6, 6) << 2) | (BITS(x, 5, 5) << 3);
            if (!imm) return 0;
            d->op = OP_ADDI; d->rd = rdp; d->rs1 = 2; d->imm = imm; return 1;
        }
        case 2: d->op = OP_LW; d->rd = rdp; d->rs1 = rs1p;
            d->imm = (BITS(x, 12, 10) << 3) | (BITS(x, 6, 6) << 2) | (BITS(x, 5, 5) << 6); return 1;
        case 3: d->op = OP_LD; d->rd = rdp; d->rs1 = rs1p;
            d->imm = (BITS(x, 12, 10) << 3) | (BITS(x, 6, 5) << 6); return 1;
        case 6: d->op = OP_SW; d->rs2 = rdp; d->rs1 = rs1p;
            d->imm = (BITS(x, 12, 10) << 3) | (BITS(x, 6, 6) << 2) | (BITS(x, 5, 5) << 6); return 1;
        case 7: d->op = OP_SD; d->rs2 = rdp; d->rs1 = rs1p;
            d->imm = (BITS(x, 12, 10) << 3) | (BITS(x, 6, 5) << 6); return 1;
        }
        return 0;
    case 1: {
        int64_t imm6 = sext((BITS(x, 12, 12) << 5) | BITS(x, 6, 2), 6);
        switch (f3) {
        case 0: d->op = OP_ADDI; d->rd = d->rs1 = rd; d->imm = imm6; return 1;
        case 1: if (!rd) return 0; d->op = OP_ADDIW; d->rd = d->rs1 = rd; d->imm = imm6; return 1;
        case 2: d->op = OP_ADDI; d->rd = rd; d->rs1 = 0; d->imm = imm6; return 1;
        case 3:
            if (rd == 2) {
                int64_t imm = sext((BITS(x, 12, 12) << 9) | (BITS(x, 6, 6) << 4) | (BITS(x, 5, 5) << 6) |
                                   (BITS(x, 4, 3) << 7) | (BITS(x, 2, 2) << 5), 10);
                if (!imm) return 0;
                d->op = OP_ADDI; d->rd = d->rs1 = 2; d->imm = imm; return 1;
            } else {
                int64_t imm = sext((BITS(x, 12, 12) << 17) | (BITS(x, 6, 2) << 12), 18);
                if (!imm) return 0;
                d->op = OP_LUI; d->rd = rd; d->imm = imm; return 1;
            }
        case 4: {
            uint32_t f2 = BITS(x, 11, 10);
            uint32_t sh = (BITS(x, 12, 12) << 5) | BITS(x, 6, 2);
            d->rd = d->rs1 = rs1p;
            if (f2 == 0) { d->op = OP_SRLI; d->imm = sh; return 1; }
            if (f2 == 1) { d->op = OP_SRAI; d->imm = sh; return 1; }
            if (f2 == 2) { d->op = OP_ANDI; d->imm = imm6; return 1; }
            d->rs2 = rdp;
            if (!BITS(x, 12, 12)) {
                static const uint8_t ops[4] = { OP_SUB, OP_XOR, OP_OR, OP_AND };
                d->op = ops[BITS(x, 6, 5)]; return 1;
            }
            if (BITS(x, 6, 5) == 0) { d->op = OP_SUBW; return 1; }
            if (BITS(x, 6, 5) == 1) { d->op = OP_ADDW; return 1; }
            return 0;
        }
        case 5:
            d->op = OP_JAL; d->rd = 0;
            d->imm = sext((BITS(x, 12, 12) << 11) | (BITS(x, 11, 11) << 4) | (BITS(x, 10, 9) << 8) |
                          (BITS(x, 8, 8) << 10) | (BITS(x, 7, 7) << 6) | (BITS(x, 6, 6) << 7) |
                          (BITS(x, 5, 3) << 1) | (BITS(x, 2, 2) << 5), 12);
            return 1;
        case 6: case 7:
            d->op = f3 == 6 ? OP_BEQ : OP_BNE; d->rs1 = rs1p; d->rs2 = 0;
            d->imm = sext((BITS(x, 12, 12) << 8) | (BITS(x, 11, 10) << 3) | (BITS(x, 6, 5) << 6) |
                          (BITS(x, 4, 3) << 1) | (BITS(x, 2, 2) << 5), 9);
            return 1;
        }
        return 0;
    }
    case 2:
        switch (f3) {
        case 0: d->op = OP_SLLI; d->rd = d->rs1 = rd; d->imm = (BITS(x, 12, 12) << 5) | BITS(x, 6, 2); return 1;
        case 2: if (!rd) return 0; d->op = OP_LW; d->rd = rd; d->rs1 = 2;
            d->imm = (BITS(x, 12, 12) << 5) | (BITS(x, 6, 4) << 2) | (BITS(x, 3, 2) << 6); return 1;
        case 3: if (!rd) return 0; d->op = OP_LD; d->rd = rd; d->rs1 = 2;
            d->imm = (BITS(x, 12, 12) << 5) | (BITS(x, 6, 5) << 3) | (BITS(x, 4, 2) << 6); return 1;
        case 4:
            if (!BITS(x, 12, 12)) {
                if (rs2 == 0) { if (!rd) return 0; d->op = OP_JALR; d->rd = 0; d->rs1 = rd; d->imm = 0; return 1; }
                d->op = OP_ADD; d->rd = rd; d->rs1 = 0; d->rs2 = rs2; return 1;
            }
            if (rs2 == 0) {
                if (!rd) return 0; /* c.ebreak */
                d->op = OP_JALR; d->rd = 1; d->rs1 = rd; d->imm = 0; return 1;
            }
            d->op = OP_ADD; d->rd = d->rs1 = rd; d->rs2 = rs2; return 1;
        case 6: d->op = OP_SW; d->rs1 = 2; d->rs2 = rs2;
            d->imm = (BITS(x, 12, 9) << 2) | (BITS(x, 8, 7) << 6); return 1;
        case 7: d->op = OP_SD; d->rs1 = 2; d->rs2 = rs2;
            d->imm = (BITS(x, 12, 10) << 3) | (BITS(x, 9, 7) << 6); return 1;
        }
        return 0;
    }
    return 0;
}

/* Superblocks: conditional branches are side exits, only jumps end a block. */
static int is_terminator(int op)
{
    return op == OP_JAL || op == OP_JALR;
}

/* Decode a block starting at `code` (host pointer) within its page. */
static int decode_block(const uint8_t *code, Insn *out, int *end_off)
{
    uint32_t page_left = 4096 - page_off((uintptr_t)code);
    uint32_t off = 0;
    int n = 0;
    while (n < MAX_BLOCK_INSNS && off + 2 <= page_left) {
        uint16_t lo = code[off] | (code[off + 1] << 8);
        Insn *d = &out[n];
        if ((lo & 3) == 3) {
            if (off + 4 > page_left) break; /* crosses the page: interpreter */
            uint32_t x = lo | ((uint32_t)(code[off + 2] | (code[off + 3] << 8)) << 16);
            if (!decode32(x, d)) break;
        } else {
            if (!decode16(lo, d)) break;
        }
        off += d->len;
        n++;
        if (is_terminator(d->op)) break;
    }
    *end_off = off;
    return n;
}

/* ------------------------------------------------------------------ */
/* WASM byte encoder */

typedef struct { uint8_t *b; int len, cap; } Buf;

static void put(Buf *o, uint8_t v)
{
    if (o->len == o->cap) { o->cap = o->cap ? o->cap * 2 : 4096; o->b = realloc(o->b, o->cap); }
    o->b[o->len++] = v;
}
static void put_bytes(Buf *o, const void *p, int n) { const uint8_t *q = p; while (n--) put(o, *q++); }
static void uleb(Buf *o, uint64_t v) { do { uint8_t c = v & 0x7f; v >>= 7; if (v) c |= 0x80; put(o, c); } while (v); }
static void sleb(Buf *o, int64_t v)
{
    for (;;) {
        uint8_t c = v & 0x7f;
        v >>= 7;
        if ((v == 0 && !(c & 0x40)) || (v == -1 && (c & 0x40))) { put(o, c); return; }
        put(o, c | 0x80);
    }
}
static void put_str(Buf *o, const char *s) { int n = strlen(s); uleb(o, n); put_bytes(o, s, n); }
static void section(Buf *mod, int id, Buf *body) { put(mod, id); uleb(mod, body->len); put_bytes(mod, body->b, body->len); body->len = 0; }

/* opcodes */
enum {
    W_UNREACHABLE = 0x00, W_BLOCK = 0x02, W_IF = 0x04, W_ELSE = 0x05, W_END = 0x0b, W_BR = 0x0c, W_BR_IF = 0x0d,
    W_RETURN = 0x0f, W_CALL = 0x10, W_SELECT = 0x1b, W_LOCAL_GET = 0x20, W_LOCAL_SET = 0x21, W_LOCAL_TEE = 0x22,
    W_I32_LOAD = 0x28, W_I64_LOAD = 0x29, W_I64_LOAD8_S = 0x30, W_I64_LOAD8_U = 0x31, W_I64_LOAD16_S = 0x32,
    W_I64_LOAD16_U = 0x33, W_I64_LOAD32_S = 0x34, W_I64_LOAD32_U = 0x35,
    W_I32_STORE = 0x36, W_I64_STORE = 0x37, W_I64_STORE8 = 0x3c, W_I64_STORE16 = 0x3d, W_I64_STORE32 = 0x3e,
    W_I32_CONST = 0x41, W_I64_CONST = 0x42,
    W_I32_EQZ = 0x45, W_I32_EQ = 0x46, W_I32_NE = 0x47,
    W_I64_EQZ = 0x50, W_I64_EQ = 0x51, W_I64_NE = 0x52, W_I64_LT_S = 0x53, W_I64_LT_U = 0x54, W_I64_GE_S = 0x59, W_I64_GE_U = 0x5a,
    W_I32_ADD = 0x6a, W_I32_SUB = 0x6b, W_I32_MUL = 0x6c, W_I32_AND = 0x71, W_I32_SHL = 0x74, W_I32_SHR_S = 0x75, W_I32_SHR_U = 0x76,
    W_I64_ADD = 0x7c, W_I64_SUB = 0x7d, W_I64_MUL = 0x7e, W_I64_AND = 0x83, W_I64_OR = 0x84, W_I64_XOR = 0x85,
    W_I64_SHL = 0x86, W_I64_SHR_S = 0x87, W_I64_SHR_U = 0x88,
    W_I32_WRAP_I64 = 0xa7, W_I64_EXTEND_I32_S = 0xac, W_I64_EXTEND_I32_U = 0xad,
};
enum {
    W_F64_LOAD = 0x2b, W_I32_LOAD8_U = 0x2d, W_F64_EQ = 0x61, W_F64_LT = 0x63, W_F64_LE = 0x65,
    W_I64_GT_U = 0x56, W_F64_SQRT = 0x9f, W_F64_ADD = 0xa0, W_F64_SUB = 0xa1, W_F64_MUL = 0xa2,
    W_F64_DIV = 0xa3, W_I64_REINTERPRET_F64 = 0xbd,
};
#define T_I32 0x7f
#define T_I64 0x7e
#define T_VOID 0x40

/* function indices: imports first */
enum { F_LD = 0, F_ST, F_MULH, F_DIV, F_EXEC1, N_IMPORTS };
/* locals: 0 = state; 1..31 = x1..x31; then temps */
enum { L_S = 0, L_PC = 32, L_A = 33, L_V = 34, L_E = 35, L_F = 36 /* regions only */, N_LOCALS_I64 = 34 /* x1..x31, pc, a, v */ };

static void op_(Buf *o, uint8_t op) { put(o, op); }
static void get(Buf *o, int l) { put(o, W_LOCAL_GET); uleb(o, l); }
static void set(Buf *o, int l) { put(o, W_LOCAL_SET); uleb(o, l); }
static void tee(Buf *o, int l) { put(o, W_LOCAL_TEE); uleb(o, l); }
static void i32c(Buf *o, int32_t v) { put(o, W_I32_CONST); sleb(o, v); }
static void i64c(Buf *o, int64_t v) { put(o, W_I64_CONST); sleb(o, v); }
static void mem(Buf *o, uint8_t op, int align, uint32_t off) { put(o, op); uleb(o, align); uleb(o, off); }

/* ------------------------------------------------------------------ */
/* code generator */

typedef struct {
    Buf *o;
    uint32_t used, dirty;   /* register bitmaps; dirty = every rd in the block */
    int n;                  /* instructions in the block */
    int region;             /* emitting one entry of a page region (see gen_region) */
    int dd;                 /* region: br depth from the block's loop body to the dispatch loop */
    int poff;               /* region: page offset of the block's first instruction */
} Gen;

#define OFF_PC     ((uint32_t)offsetof(RISCVCPUState, pc))
#define OFF_REG(r) ((uint32_t)(offsetof(RISCVCPUState, reg) + 8 * (r)))
#define OFF_NCYC   ((uint32_t)offsetof(RISCVCPUState, n_cycles))
#define OFF_MIP    ((uint32_t)offsetof(RISCVCPUState, mip))
#define OFF_FREG(r) ((uint32_t)(offsetof(RISCVCPUState, fp_reg) + 8 * (r)))
#define OFF_FS     ((uint32_t)offsetof(RISCVCPUState, fs))
#define OFF_FFLAGS ((uint32_t)offsetof(RISCVCPUState, fflags))
#define OFF_FRM    ((uint32_t)offsetof(RISCVCPUState, frm))
#define OFF_MIE    ((uint32_t)offsetof(RISCVCPUState, mie))
#define OFF_TMP    ((uint32_t)offsetof(RISCVCPUState, xn_tmp))
#define OFF_TLBR   ((uint32_t)offsetof(RISCVCPUState, tlb_read))
#define OFF_TLBW   ((uint32_t)offsetof(RISCVCPUState, tlb_write))
#define TLB_ESZ    ((uint32_t)sizeof(TLBEntry))
#define OFF_TLB_VADDR  ((uint32_t)offsetof(TLBEntry, vaddr))
#define OFF_TLB_ADDEND ((uint32_t)offsetof(TLBEntry, mem_addend))

/* push guest register r (x0 reads as 0) */
static void rget(Gen *g, int r) { if (r == 0) i64c(g->o, 0); else get(g->o, r); }
/* pop into guest register r (writes to x0 are dropped) */
static void rset(Gen *g, int r)
{
    if (r == 0) { op_(g->o, 0x1a /* drop */); return; }
    set(g->o, r);
}

static void store_dirty(Gen *g)
{
    int r;
    for (r = 1; r < 32; r++)
        if (g->dirty & (1u << r)) {
            get(g->o, L_S); get(g->o, r); mem(g->o, W_I64_STORE, 3, OFF_REG(r));
        }
}

/* s->pc = pc0 + off */
static void set_pc_off(Gen *g, int64_t off)
{
    get(g->o, L_S); get(g->o, L_PC); i64c(g->o, off); op_(g->o, W_I64_ADD); mem(g->o, W_I64_STORE, 3, OFF_PC);
}

/* s->n_cycles -= c (instruction counting happens at each exit) */
static void charge(Gen *g, int c)
{
    get(g->o, L_S); get(g->o, L_S); mem(g->o, W_I32_LOAD, 2, OFF_NCYC);
    i32c(g->o, c); op_(g->o, W_I32_SUB); mem(g->o, W_I32_STORE, 2, OFF_NCYC);
}

/* early exit after a helper raised an exception at instruction k */
static void exit_exception(Gen *g, int k, int n)
{
    (void)n;
    charge(g, k + 1); /* like the interpreter: the faulting one was fetched */
    i32c(g->o, 1); op_(g->o, W_RETURN);
}

/* Region edge: registers are already spilled; if pc0 + off stays in this page,
   continue there through the dispatch (`extra` = labels opened inside the
   block's loop at this point). Returns 0 when the target is in another page. */
static int region_edge(Gen *g, int64_t off, int extra)
{
    int64_t t = g->poff + off;
    if (!g->region || t < 0 || t >= 4096)
        return 0;
    get(g->o, L_PC); i64c(g->o, off); op_(g->o, W_I64_ADD); set(g->o, L_PC);
    put(g->o, W_BR); uleb(g->o, g->dd + extra);
    return 1;
}

/* leave the block at instruction k with s->pc = pc0 + target_off */
static void exit_to(Gen *g, int k, int64_t target_off, int extra)
{
    charge(g, k + 1);
    store_dirty(g);
    if (region_edge(g, target_off, extra))
        return;
    set_pc_off(g, target_off);
    i32c(g->o, 2); op_(g->o, W_RETURN);
}

/* after a store helper call (result on the stack): 1 = exception, 2 = the
   store dropped translations, so stop after it (registers are spilled) */
static void store_result(Gen *g, int k, int64_t next_off)
{
    Buf *o = g->o;
    set(o, L_E);
    get(o, L_E);
    put(o, W_IF); put(o, T_VOID);
      get(o, L_E); i32c(o, 1); op_(o, W_I32_EQ);
      put(o, W_IF); put(o, T_VOID); exit_exception(g, k, g->n); put(o, W_END);
      charge(g, k + 1); set_pc_off(g, next_off); i32c(o, 0); op_(o, W_RETURN);
    put(o, W_END);
}

/* back edge to the block start at instruction k. `depth` = br depth of the
   enclosing loop from here. Loops while the budget covers another pass and no
   interrupt is pending, otherwise exits to the block start. */
static void back_edge(Gen *g, int k, int depth)
{
    Buf *o = g->o;
    charge(g, k + 1);
    get(o, L_S); mem(o, W_I32_LOAD, 2, OFF_NCYC); i32c(o, g->n); op_(o, 0x4e /* i32.ge_s */);
    get(o, L_S); mem(o, W_I32_LOAD, 2, OFF_MIP); get(o, L_S); mem(o, W_I32_LOAD, 2, OFF_MIE); op_(o, W_I32_AND);
    op_(o, W_I32_EQZ); op_(o, W_I32_AND);
    put(o, W_BR_IF); uleb(o, depth);
    store_dirty(g);
    set_pc_off(g, 0);
    i32c(o, 4); op_(o, W_RETURN);
}

/* L_A = rs1 + imm; L_E = &tlb[(a >> 12) & (TLB_SIZE-1)] */
static void gen_addr(Gen *g, const Insn *d, uint32_t tlb_off)
{
    rget(g, d->rs1); i64c(g->o, d->imm); op_(g->o, W_I64_ADD); tee(g->o, L_A);
    i64c(g->o, 12); op_(g->o, W_I64_SHR_U); op_(g->o, W_I32_WRAP_I64);
    i32c(g->o, TLB_SIZE - 1); op_(g->o, W_I32_AND);
    i32c(g->o, TLB_ESZ); op_(g->o, W_I32_MUL);
    get(g->o, L_S); op_(g->o, W_I32_ADD); i32c(g->o, tlb_off); op_(g->o, W_I32_ADD);
    set(g->o, L_E);
}

/* condition: tlb[e].vaddr == (a & ~(PG_MASK & ~(size-1))) */
static void gen_tlb_hit(Gen *g, int size)
{
    get(g->o, L_E); mem(g->o, W_I64_LOAD, 3, OFF_TLB_VADDR);
    get(g->o, L_A); i64c(g->o, ~(int64_t)(PG_MASK & ~(size - 1))); op_(g->o, W_I64_AND);
    op_(g->o, W_I64_EQ);
}

/* host address of the access on a hit: tlb[e].mem_addend + (i32)a */
static void gen_host_addr(Gen *g)
{
    get(g->o, L_E); mem(g->o, W_I32_LOAD, 2, OFF_TLB_ADDEND);
    get(g->o, L_A); op_(g->o, W_I32_WRAP_I64); op_(g->o, W_I32_ADD);
}

static void gen_load(Gen *g, const Insn *d, int k, int n, int64_t pcoff)
{
    static const struct { uint8_t op; int size, kind; } L[] = {
        [OP_LB] = { W_I64_LOAD8_S, 1, 0 }, [OP_LH] = { W_I64_LOAD16_S, 2, 1 }, [OP_LW] = { W_I64_LOAD32_S, 4, 2 },
        [OP_LD] = { W_I64_LOAD, 8, 3 }, [OP_LBU] = { W_I64_LOAD8_U, 1, 4 }, [OP_LHU] = { W_I64_LOAD16_U, 2, 5 },
        [OP_LWU] = { W_I64_LOAD32_U, 4, 6 },
    };
    int size = L[d->op].size, align = size == 8 ? 3 : size == 4 ? 2 : size == 2 ? 1 : 0;
    gen_addr(g, d, OFF_TLBR);
    if (xn_check_mode) i32c(g->o, 0); else /* checker: always take the logging helper */
    gen_tlb_hit(g, size);
    put(g->o, W_IF); put(g->o, T_I64);
      gen_host_addr(g); mem(g->o, L[d->op].op, align, 0);
    put(g->o, W_ELSE);
      store_dirty(g); set_pc_off(g, pcoff);
      get(g->o, L_S); get(g->o, L_A); i32c(g->o, L[d->op].kind); put(g->o, W_CALL); uleb(g->o, F_LD);
      put(g->o, W_IF); put(g->o, T_VOID); exit_exception(g, k, n); put(g->o, W_END);
      get(g->o, L_S); mem(g->o, W_I64_LOAD, 3, OFF_TMP);
    put(g->o, W_END);
    rset(g, d->rd);
}

static void gen_store(Gen *g, const Insn *d, int k, int n, int64_t pcoff)
{
    static const struct { uint8_t op; int size, log2; } S[] = {
        [OP_SB] = { W_I64_STORE8, 1, 0 }, [OP_SH] = { W_I64_STORE16, 2, 1 },
        [OP_SW] = { W_I64_STORE32, 4, 2 }, [OP_SD] = { W_I64_STORE, 8, 3 },
    };
    int size = S[d->op].size, align = S[d->op].log2;
    gen_addr(g, d, OFF_TLBW);
    if (xn_check_mode) i32c(g->o, 0); else
    gen_tlb_hit(g, size);
    put(g->o, W_IF); put(g->o, T_VOID);
      gen_host_addr(g); rget(g, d->rs2); mem(g->o, S[d->op].op, align, 0);
    put(g->o, W_ELSE);
      store_dirty(g); set_pc_off(g, pcoff);
      get(g->o, L_S); get(g->o, L_A); rget(g, d->rs2); i32c(g->o, S[d->op].log2); put(g->o, W_CALL); uleb(g->o, F_ST);
      store_result(g, k, pcoff + d->len);
    put(g->o, W_END);
}

/* sign-extend the low 32 bits of the i64 on the stack */
static void sext32(Gen *g) { op_(g->o, W_I32_WRAP_I64); op_(g->o, W_I64_EXTEND_I32_S); }

static void gen_alu(Gen *g, const Insn *d)
{
    Buf *o = g->o;
    int a = d->rs1, b = d->rs2;
    int64_t imm = d->imm;
    switch (d->op) {
    case OP_LUI: i64c(o, imm); break;
    case OP_ADDI: rget(g, a); i64c(o, imm); op_(o, W_I64_ADD); break;
    case OP_SLTI: rget(g, a); i64c(o, imm); op_(o, W_I64_LT_S); op_(o, W_I64_EXTEND_I32_U); break;
    case OP_SLTIU: rget(g, a); i64c(o, imm); op_(o, W_I64_LT_U); op_(o, W_I64_EXTEND_I32_U); break;
    case OP_XORI: rget(g, a); i64c(o, imm); op_(o, W_I64_XOR); break;
    case OP_ORI: rget(g, a); i64c(o, imm); op_(o, W_I64_OR); break;
    case OP_ANDI: rget(g, a); i64c(o, imm); op_(o, W_I64_AND); break;
    case OP_SLLI: rget(g, a); i64c(o, imm); op_(o, W_I64_SHL); break;
    case OP_SRLI: rget(g, a); i64c(o, imm); op_(o, W_I64_SHR_U); break;
    case OP_SRAI: rget(g, a); i64c(o, imm); op_(o, W_I64_SHR_S); break;
    case OP_ADDIW: rget(g, a); i64c(o, imm); op_(o, W_I64_ADD); sext32(g); break;
    case OP_SLLIW:
        rget(g, a); op_(o, W_I32_WRAP_I64); i32c(o, imm); op_(o, W_I32_SHL); op_(o, W_I64_EXTEND_I32_S); break;
    case OP_SRLIW:
        rget(g, a); op_(o, W_I32_WRAP_I64); i32c(o, imm); op_(o, W_I32_SHR_U); op_(o, W_I64_EXTEND_I32_S); break;
    case OP_SRAIW:
        rget(g, a); op_(o, W_I32_WRAP_I64); i32c(o, imm); op_(o, W_I32_SHR_S); op_(o, W_I64_EXTEND_I32_S); break;
    case OP_ADD: rget(g, a); rget(g, b); op_(o, W_I64_ADD); break;
    case OP_SUB: rget(g, a); rget(g, b); op_(o, W_I64_SUB); break;
    case OP_SLL: rget(g, a); rget(g, b); op_(o, W_I64_SHL); break;   /* wasm masks to 6 bits, like RV64 */
    case OP_SRL: rget(g, a); rget(g, b); op_(o, W_I64_SHR_U); break;
    case OP_SRA: rget(g, a); rget(g, b); op_(o, W_I64_SHR_S); break;
    case OP_SLT: rget(g, a); rget(g, b); op_(o, W_I64_LT_S); op_(o, W_I64_EXTEND_I32_U); break;
    case OP_SLTU: rget(g, a); rget(g, b); op_(o, W_I64_LT_U); op_(o, W_I64_EXTEND_I32_U); break;
    case OP_XOR: rget(g, a); rget(g, b); op_(o, W_I64_XOR); break;
    case OP_OR: rget(g, a); rget(g, b); op_(o, W_I64_OR); break;
    case OP_AND: rget(g, a); rget(g, b); op_(o, W_I64_AND); break;
    case OP_ADDW: rget(g, a); rget(g, b); op_(o, W_I64_ADD); sext32(g); break;
    case OP_SUBW: rget(g, a); rget(g, b); op_(o, W_I64_SUB); sext32(g); break;
    case OP_SLLW:
        rget(g, a); op_(o, W_I32_WRAP_I64); rget(g, b); op_(o, W_I32_WRAP_I64); op_(o, W_I32_SHL); op_(o, W_I64_EXTEND_I32_S); break;
    case OP_SRLW:
        rget(g, a); op_(o, W_I32_WRAP_I64); rget(g, b); op_(o, W_I32_WRAP_I64); op_(o, W_I32_SHR_U); op_(o, W_I64_EXTEND_I32_S); break;
    case OP_SRAW:
        rget(g, a); op_(o, W_I32_WRAP_I64); rget(g, b); op_(o, W_I32_WRAP_I64); op_(o, W_I32_SHR_S); op_(o, W_I64_EXTEND_I32_S); break;
    case OP_MUL: rget(g, a); rget(g, b); op_(o, W_I64_MUL); break;
    case OP_MULW: rget(g, a); rget(g, b); op_(o, W_I64_MUL); sext32(g); break;
    case OP_MULH: case OP_MULHSU: case OP_MULHU:
        rget(g, a); rget(g, b); i32c(o, d->op - OP_MULH); put(o, W_CALL); uleb(o, F_MULH); break;
    case OP_DIV: case OP_DIVU: case OP_REM: case OP_REMU:
    case OP_DIVW: case OP_DIVUW: case OP_REMW: case OP_REMUW: {
        static const int kinds[] = { [OP_DIV] = 0, [OP_DIVU] = 1, [OP_REM] = 2, [OP_REMU] = 3,
                                     [OP_DIVW] = 4, [OP_DIVUW] = 5, [OP_REMW] = 6, [OP_REMUW] = 7 };
        rget(g, a); rget(g, b); i32c(o, kinds[d->op]); put(o, W_CALL); uleb(o, F_DIV); break;
    }
    default: abort();
    }
    rset(g, d->rd);
}

/* EXEC1 class for the measurement counters (0 = other, see xn_jit_stat) */
static int exec1_class(uint32_t raw)
{
    uint32_t opc = raw & 0x7f, f7 = raw >> 25, f = f7 & ~1u;
    if ((raw & 3) != 3) return 0;
    if (opc == 0x53) {
        if (f == 0x00 || f == 0x04 || f == 0x08 || f == 0x0c || f == 0x2c) return 1;
        if (f == 0x20 || f == 0x60 || f == 0x68) return 3;
        if (f == 0x50) return 4;
        return 5;
    }
    if (opc == 0x43 || opc == 0x47 || opc == 0x4b || opc == 0x4f) return 2;
    if (opc == 0x07 || opc == 0x27) return 6;
    if (opc == 0x2f) return 7;
    if (opc == 0x73) return 8;
    return 0;
}

/* FP disabled (mstatus.FS == 0): let the interpreter run the instruction
   (it raises illegal-instruction); the block then leaves either way. */
static void fp_guard(Gen *g, int k, int64_t off, const Insn *d)
{
    Buf *o = g->o;
    get(o, L_S); mem(o, 0x2d /* i32.load8_u */, 0, OFF_FS); op_(o, W_I32_EQZ);
    put(o, W_IF); put(o, T_VOID);
      store_dirty(g); set_pc_off(g, off);
      get(o, L_S); i32c(o, d->len | (d->stores << 8) | (exec1_class(d->raw) << 16)); put(o, W_CALL); uleb(o, F_EXEC1); op_(o, 0x1a);
      charge(g, k + 1); i32c(o, 1); op_(o, W_RETURN);
    put(o, W_END);
}

static void fp_dirty(Gen *g)
{
    get(g->o, L_S); i32c(g->o, 3); mem(g->o, 0x3a /* i32.store8 */, 0, OFF_FS);
}

/* spill, run instruction k on the interpreter, leave if it didn't advance normally */
static void gen_exec1(Gen *g, const Insn *d, int k, int64_t off)
{
    Buf *o = g->o;
    store_dirty(g);
    set_pc_off(g, off);
    get(o, L_S); i32c(o, d->len | (d->stores << 8) | (exec1_class(d->raw) << 16)); put(o, W_CALL); uleb(o, F_EXEC1);
    put(o, W_IF); put(o, T_VOID);
      /* pc didn't advance normally (exception, interrupt): state is
         already in memory, just count and leave */
      charge(g, k + 1); i32c(o, 1); op_(o, W_RETURN);
    put(o, W_END);
}

static void gen_fp(Gen *g, const Insn *d, int k, int64_t off)
{
    Buf *o = g->o;
    fp_guard(g, k, off, d);
    switch (d->op) {
    case OP_FLD: {
        /* like ld, but the value goes to fp_reg[frd] */
        Insn t = *d;
        gen_addr(g, &t, OFF_TLBR);
        get(o, L_S); /* address for the final store */
        if (xn_check_mode) i32c(o, 0); else gen_tlb_hit(g, 8);
        put(o, W_IF); put(o, T_I64);
          gen_host_addr(g); mem(o, W_I64_LOAD, 3, 0);
        put(o, W_ELSE);
          store_dirty(g); set_pc_off(g, off);
          get(o, L_S); get(o, L_A); i32c(o, 3); put(o, W_CALL); uleb(o, F_LD);
          put(o, W_IF); put(o, T_VOID); exit_exception(g, k, g->n); put(o, W_END);
          get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_TMP);
        put(o, W_END);
        mem(o, W_I64_STORE, 3, OFF_FREG(d->frd));
        fp_dirty(g);
        break;
    }
    case OP_FSD:
        gen_addr(g, d, OFF_TLBW);
        if (xn_check_mode) i32c(o, 0); else gen_tlb_hit(g, 8);
        put(o, W_IF); put(o, T_VOID);
          gen_host_addr(g); get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_FREG(d->frs2)); mem(o, W_I64_STORE, 3, 0);
        put(o, W_ELSE);
          store_dirty(g); set_pc_off(g, off);
          get(o, L_S); get(o, L_A); get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_FREG(d->frs2)); i32c(o, 3);
          put(o, W_CALL); uleb(o, F_ST);
          store_result(g, k, off + d->len);
        put(o, W_END);
        break;
    case OP_FSGNJ_D: {
        int64_t sign = INT64_MIN;
        get(o, L_S);
        get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_FREG(d->frs1));
        if (d->sub == 2) {          /* jx: rs1 ^ (rs2 & sign) */
            get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_FREG(d->frs2)); i64c(o, sign); op_(o, W_I64_AND);
            op_(o, W_I64_XOR);
        } else {                    /* j / jn: (rs1 & ~sign) | ([~]rs2 & sign) */
            i64c(o, ~sign); op_(o, W_I64_AND);
            get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_FREG(d->frs2));
            if (d->sub == 1) { i64c(o, -1); op_(o, W_I64_XOR); }
            i64c(o, sign); op_(o, W_I64_AND);
            op_(o, W_I64_OR);
        }
        mem(o, W_I64_STORE, 3, OFF_FREG(d->frd));
        fp_dirty(g);
        break;
    }
    case OP_FMV_X_D:
        get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_FREG(d->frs1)); rset(g, d->rd);
        break;
    case OP_FMV_D_X:
        get(o, L_S); rget(g, d->rs1); mem(o, W_I64_STORE, 3, OFF_FREG(d->frd));
        fp_dirty(g);
        break;
    case OP_FARITH_D: {
        static const uint8_t fop[] = { W_F64_ADD, W_F64_SUB, W_F64_MUL, W_F64_DIV, W_F64_SQRT };
        /* fast if RNE (static, or dynamic with frm == 0) and NX already set */
        get(o, L_S); mem(o, W_I32_LOAD, 2, OFF_FFLAGS); i32c(o, 1); op_(o, W_I32_AND);
        if (d->rm == 7) { get(o, L_S); mem(o, W_I32_LOAD8_U, 0, OFF_FRM); op_(o, W_I32_EQZ); op_(o, W_I32_AND); }
        put(o, W_IF); put(o, T_I32);
          get(o, L_S); mem(o, W_F64_LOAD, 3, OFF_FREG(d->frs1));
          if (d->sub != 4) { get(o, L_S); mem(o, W_F64_LOAD, 3, OFF_FREG(d->frs2)); }
          op_(o, fop[d->sub]); op_(o, W_I64_REINTERPRET_F64); set(o, L_V);
          /* ok iff DBL_MIN < |r| < inf: excludes NaN, inf, zero, subnormal and tininess-after-rounding */
          get(o, L_V); i64c(o, INT64_MAX); op_(o, W_I64_AND); i64c(o, 0x0010000000000000LL); op_(o, W_I64_GT_U);
          get(o, L_V); i64c(o, INT64_MAX); op_(o, W_I64_AND); i64c(o, 0x7ff0000000000000LL); op_(o, W_I64_LT_U);
          op_(o, W_I32_AND);
        put(o, W_ELSE);
          i32c(o, 0);
        put(o, W_END);
        put(o, W_IF); put(o, T_VOID);
          get(o, L_S); get(o, L_V); mem(o, W_I64_STORE, 3, OFF_FREG(d->frd));
          fp_dirty(g);
        put(o, W_ELSE);
          gen_exec1(g, d, k, off);   /* exact softfp path: flags, NaNs, other rounding */
        put(o, W_END);
        break;
    }
    case OP_FCMP_D: {
        static const uint8_t cop[] = { W_F64_LE, W_F64_LT, W_F64_EQ };
        /* no NaN operand: native compare, no flags; otherwise the interpreter (signalling rules) */
        get(o, L_S); mem(o, W_F64_LOAD, 3, OFF_FREG(d->frs1)); get(o, L_S); mem(o, W_F64_LOAD, 3, OFF_FREG(d->frs1)); op_(o, W_F64_EQ);
        get(o, L_S); mem(o, W_F64_LOAD, 3, OFF_FREG(d->frs2)); get(o, L_S); mem(o, W_F64_LOAD, 3, OFF_FREG(d->frs2)); op_(o, W_F64_EQ);
        op_(o, W_I32_AND);
        put(o, W_IF); put(o, T_I64);
          get(o, L_S); mem(o, W_F64_LOAD, 3, OFF_FREG(d->frs1));
          get(o, L_S); mem(o, W_F64_LOAD, 3, OFF_FREG(d->frs2));
          op_(o, cop[d->sub]); op_(o, W_I64_EXTEND_I32_U);
        put(o, W_ELSE);
          gen_exec1(g, d, k, off);
          if (d->rd) { get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_REG(d->rd)); } else i64c(o, 0);
        put(o, W_END);
        rset(g, d->rd);
        break;
    }
    }
}

/* Emit the body of one block function. The body sits in a WASM loop so a
   branch back to the block start iterates without leaving the function. */
static void gen_masks(Gen *g, const Insn *ins, int n)
{
    int k;
    for (k = 0; k < n; k++) {
        g->used |= (1u << ins[k].rd) | (1u << ins[k].rs1) | (1u << ins[k].rs2);
        if (ins[k].op < OP_BEQ || ins[k].op > OP_BGEU) {
            if ((ins[k].op < OP_SB || ins[k].op > OP_SD) && ins[k].op != OP_NOP && ins[k].op != OP_FSD)
                g->dirty |= 1u << ins[k].rd;
        }
    }
    g->used &= ~1u;
    g->dirty &= ~1u;
}

static void gen_locals(Buf *o)
{
    /* locals: 34 x i64 (x1..x31, pc, a, v), 1 x i32 (e) */
    uleb(o, 2);
    uleb(o, N_LOCALS_I64); put(o, T_I64);
    uleb(o, 1); put(o, T_I32);
}

static void gen_load_used(Gen *g)
{
    int r;
    for (r = 1; r < 32; r++)
        if (g->used & (1u << r)) { get(g->o, L_S); mem(g->o, W_I64_LOAD, 3, OFF_REG(r)); set(g->o, r); }
}

static void gen_body(Gen *g, const Insn *ins, int n, int end_off);

static void gen_block(Buf *o, const Insn *ins, int n, int end_off)
{
    Gen g = { .o = o, .n = n };
    gen_masks(&g, ins, n);
    gen_locals(o);
    /* entry: load pc and used registers */
    get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_PC); set(o, L_PC);
    gen_load_used(&g);
    gen_body(&g, ins, n, end_off);
    op_(o, W_END);
}

/* The block's code from its loop on. Single blocks end with the i32 result on
   the stack; region entries always end in a br or return. */
static void gen_body(Gen *g0, const Insn *ins, int n, int end_off)
{
    Gen g = *g0;
    Buf *o = g.o;
    int k;
    int64_t off = 0;

    put(o, 0x03 /* loop */); put(o, T_VOID);
    for (k = 0; k < n; k++) {
        const Insn *d = &ins[k];
        switch (d->op) {
        case OP_AUIPC:
            get(o, L_PC); i64c(o, off + d->imm); op_(o, W_I64_ADD); rset(&g, d->rd);
            break;
        case OP_LB: case OP_LH: case OP_LW: case OP_LD: case OP_LBU: case OP_LHU: case OP_LWU:
            gen_load(&g, d, k, n, off);
            break;
        case OP_SB: case OP_SH: case OP_SW: case OP_SD:
            gen_store(&g, d, k, n, off);
            break;
        case OP_JAL:
            /* rd = pc + len; pc = pc + imm */
            if (d->rd) { get(o, L_PC); i64c(o, off + d->len); op_(o, W_I64_ADD); rset(&g, d->rd); }
            if (off + d->imm == 0)
                back_edge(&g, k, 0);            /* jump to our own start: loop */
            else
                exit_to(&g, k, off + d->imm, 0);
            break;
        case OP_JALR:
            /* target first: rd may equal rs1 */
            rget(&g, d->rs1); i64c(o, d->imm); op_(o, W_I64_ADD); i64c(o, ~(int64_t)1); op_(o, W_I64_AND); set(o, L_V);
            if (d->rd) { get(o, L_PC); i64c(o, off + d->len); op_(o, W_I64_ADD); rset(&g, d->rd); }
            charge(&g, k + 1);
            store_dirty(&g);
            if (g.region) {
                /* same guest page: stay, the dispatch knows whether it's an entry */
                get(o, L_V); get(o, L_PC); op_(o, W_I64_XOR); i64c(o, 12); op_(o, W_I64_SHR_U); op_(o, W_I64_EQZ);
                put(o, W_IF); put(o, T_VOID);
                  get(o, L_V); set(o, L_PC);
                  put(o, W_BR); uleb(o, g.dd + 1);
                put(o, W_END);
            }
            get(o, L_S); get(o, L_V); mem(o, W_I64_STORE, 3, OFF_PC);
            i32c(o, 3); op_(o, W_RETURN);
            break;
        case OP_BEQ: case OP_BNE: case OP_BLT: case OP_BGE: case OP_BLTU: case OP_BGEU: {
            static const uint8_t cmp[] = { [OP_BEQ] = W_I64_EQ, [OP_BNE] = W_I64_NE, [OP_BLT] = W_I64_LT_S,
                                          [OP_BGE] = W_I64_GE_S, [OP_BLTU] = W_I64_LT_U, [OP_BGEU] = W_I64_GE_U };
            /* taken: side exit (or loop); not taken: carry on */
            rget(&g, d->rs1); rget(&g, d->rs2); op_(o, cmp[d->op]);
            put(o, W_IF); put(o, T_VOID);
            if (off + d->imm == 0)
                back_edge(&g, k, 1);            /* br over the if to the loop */
            else
                exit_to(&g, k, off + d->imm, 1);
            put(o, W_END);
            break;
        }
        case OP_NOP:
            break;
        case OP_FLD: case OP_FSD: case OP_FSGNJ_D: case OP_FMV_X_D: case OP_FMV_D_X:
        case OP_FARITH_D: case OP_FCMP_D:
            gen_fp(&g, d, k, off);
            break;
        case OP_EXEC1:
            /* spill, run it on the interpreter, reload its integer result */
            gen_exec1(&g, d, k, off);
            if (d->rd) { get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_REG(d->rd)); set(o, d->rd); }
            break;
        default:
            gen_alu(&g, d);
            break;
        }
        off += d->len;
    }
    put(o, W_END); /* loop */
    /* fell off the end (page end, unsupported instruction, or max length) */
    charge(&g, n);
    store_dirty(&g);
    if (g.region) {
        g.dd--;   /* we're outside the block's loop now */
        if (region_edge(&g, end_off, 0))
            return;
        set_pc_off(&g, end_off);
        i32c(o, 0); op_(o, W_RETURN);
        return;
    }
    set_pc_off(&g, end_off);
    i32c(o, 0);
}

/* ------------------------------------------------------------------ */
/* page regions: every translated block of one guest page in one function.
   Edges between them branch back to a dispatch on the page offset of pc
   instead of returning to xn_jit_run. Registers stay per block (each entry
   loads its own, each edge spills its own), so exits cost what they always did.

     loop $D
       block $X
         block $E[m-1] ... block $E[0]
           br_table (pc & 0xfff) -> entry j = $E[j], else $X
         end  entry 0 ... end  entry m-1      (each ends in br $D or return)
       end  $X: s->pc = pc; return 0
     end */
static void gen_region(Buf *o, const uint32_t *keys, const uint8_t *lens, int m)
{
    static Insn ins[MAX_BLOCK_INSNS];
    int j, lo = 4096, hi = -1, cnt, i;
    for (j = 0; j < m; j++) {
        int p = page_off(keys[j]);
        if (p < lo) lo = p;
        if (p > hi) hi = p;
    }
    cnt = (hi - lo) / 2 + 1;
    /* locals as gen_locals, plus L_F (i32): 1 until the first block has run */
    uleb(o, 2);
    uleb(o, N_LOCALS_I64); put(o, T_I64);
    uleb(o, 2); put(o, T_I32);
    i32c(o, 1); set(o, L_F);
    get(o, L_S); mem(o, W_I64_LOAD, 3, OFF_PC); set(o, L_PC);
    put(o, 0x03 /* loop $D */); put(o, T_VOID);
    put(o, W_BLOCK); put(o, T_VOID);                    /* $X */
    for (j = 0; j < m; j++) { put(o, W_BLOCK); put(o, T_VOID); }
    get(o, L_PC); op_(o, W_I32_WRAP_I64); i32c(o, 0xfff); op_(o, W_I32_AND);
    i32c(o, lo); op_(o, W_I32_SUB); i32c(o, 1); op_(o, W_I32_SHR_U);
    put(o, 0x0e /* br_table */); uleb(o, cnt);
    for (i = 0; i < cnt; i++) {
        int label = m;
        for (j = 0; j < m; j++)
            if (page_off(keys[j]) == lo + 2 * i) { label = j; break; }
        uleb(o, label);
    }
    uleb(o, m);
    for (j = 0; j < m; j++) {
        Gen g = { .o = o, .region = 1, .poff = page_off(keys[j]) };
        int n, end_off;
        put(o, W_END);   /* $E[j]: entry j starts here, inside $E[j+1..m-1], $X, $D */
        n = decode_block((const uint8_t *)(uintptr_t)keys[j], ins, &end_off);
        g.n = n;
        g.dd = (m - j) + 1;   /* from inside the block's own loop */
        (void)lens;
        /* the checks xn_jit_run does between blocks: budget for this one, and
           pending interrupts -- but not before the first block: the interpreter
           calls us even when an interrupt is pending yet masked, and leaving
           without running anything would livelock */
        get(o, L_S); mem(o, W_I32_LOAD, 2, OFF_NCYC); i32c(o, n); op_(o, 0x48 /* i32.lt_s */);
        get(o, L_S); mem(o, W_I32_LOAD, 2, OFF_MIP); get(o, L_S); mem(o, W_I32_LOAD, 2, OFF_MIE); op_(o, W_I32_AND);
        i32c(o, 0); op_(o, W_I32_NE);
        get(o, L_F); op_(o, W_I32_EQZ); op_(o, W_I32_AND);
        op_(o, 0x72 /* i32.or */);
        put(o, W_IF); put(o, T_VOID);
          get(o, L_S); get(o, L_PC); mem(o, W_I64_STORE, 3, OFF_PC);
          i32c(o, 0); op_(o, W_RETURN);
        put(o, W_END);
        i32c(o, 0); set(o, L_F);
        gen_masks(&g, ins, n);
        gen_load_used(&g);
        gen_body(&g, ins, n, end_off);
    }
    put(o, W_END);   /* $X: not an entry of this region */
    get(o, L_S); get(o, L_PC); mem(o, W_I64_STORE, 3, OFF_PC);
    i32c(o, 0); op_(o, W_RETURN);
    put(o, W_END);   /* $D */
    op_(o, W_UNREACHABLE);
    op_(o, W_END);
}

/* ------------------------------------------------------------------ */
/* module assembly + instantiation */

EM_JS(int, js_jit_instantiate, (const uint8_t *buf, int len, int nfuncs, int permanent), {
    const J = Module.xnJit ??= { base: -1, next: -1 };
    let inst;
    try {
        /* a shipped bundle arrives precompiled (async, off the VM thread) */
        const mod = (permanent && Module.xnJitPreModule) || new WebAssembly.Module(HEAPU8.slice(buf, buf + len));
        if (permanent) Module.xnJitPreModule = null;
        inst = new WebAssembly.Instance(mod, { e: {
            m: wasmMemory, ld: wasmExports['xn_jit_ld'], st: wasmExports['xn_jit_st'],
            mulh: wasmExports['xn_jit_mulh'], div: wasmExports['xn_jit_div'], x1: wasmExports['xn_jit_exec1'],
        } });
    } catch (e) {
        console.error('[xiaonux] jit module failed', e);
        return -1;
    }
    if (J.base < 0) { J.base = J.next = wasmTable.length; }
    (J.mods ??= []).push({ first: J.next, n: nfuncs, bytes: HEAPU8.slice(buf, buf + len) });
    if (J.mods.length > 4096) J.mods.shift();
    if (J.next + nfuncs > wasmTable.length) wasmTable.grow(J.next + nfuncs - wasmTable.length);
    const first = J.next;
    for (let i = 0; i < nfuncs; i++) wasmTable.set(first + i, inst.exports['f' + i]);
    J.next += nfuncs;
    if (permanent) J.base = J.next;   /* resets reuse slots only above these */
    return first;
});

static void type_fn(Buf *o, int np, const uint8_t *p, int nr, uint8_t r)
{
    put(o, 0x60); uleb(o, np); put_bytes(o, p, np); uleb(o, nr); if (nr) put(o, r);
}

static void mark_code_page(uint32_t key, Block *b)
{
    int page = ram_page_of(key), i;
    uintptr_t host_page = (uintptr_t)key - page_off(key);
    if (page < 0) return;
    b->next_in_page = page_head[page];
    page_head[page] = (int32_t)(b - blocks);
    if (!code_page[page]) {
        code_page[page] = 1;
        /* drop CPU write mappings so the next store to this page takes the
           slow path, which invalidates these translations */
        for (i = 0; i < TLB_SIZE; i++) {
            TLBEntry *e = &cpu->tlb_write[i];
            if (e->vaddr != (target_ulong)-1 &&
                e->mem_addend + (uintptr_t)e->vaddr == host_page) /* vaddr is page aligned */
                e->vaddr = -1;
        }
    }
}

static void type_fn(Buf *o, int np, const uint8_t *p, int nr, uint8_t r);

/* A module of nf block functions whose code-section bodies are in `code`. */
static void assemble_module(Buf *mod, Buf *code, int nf)
{
    Buf sec = { 0 };
    int i;
    put_bytes(mod, "\0asm\1\0\0\0", 8);
    uleb(&sec, 5);
    type_fn(&sec, 1, (uint8_t[]){ T_I32 }, 1, T_I32);
    type_fn(&sec, 3, (uint8_t[]){ T_I32, T_I64, T_I32 }, 1, T_I32);
    type_fn(&sec, 4, (uint8_t[]){ T_I32, T_I64, T_I64, T_I32 }, 1, T_I32);
    type_fn(&sec, 3, (uint8_t[]){ T_I64, T_I64, T_I32 }, 1, T_I64);
    type_fn(&sec, 2, (uint8_t[]){ T_I32, T_I32 }, 1, T_I32);
    section(mod, 1, &sec);
    uleb(&sec, 6);
    put_str(&sec, "e"); put_str(&sec, "m"); put(&sec, 0x02); put(&sec, 0x00); uleb(&sec, 1);
    put_str(&sec, "e"); put_str(&sec, "ld"); put(&sec, 0x00); uleb(&sec, 1);
    put_str(&sec, "e"); put_str(&sec, "st"); put(&sec, 0x00); uleb(&sec, 2);
    put_str(&sec, "e"); put_str(&sec, "mulh"); put(&sec, 0x00); uleb(&sec, 3);
    put_str(&sec, "e"); put_str(&sec, "div"); put(&sec, 0x00); uleb(&sec, 3);
    put_str(&sec, "e"); put_str(&sec, "x1"); put(&sec, 0x00); uleb(&sec, 4);
    section(mod, 2, &sec);
    uleb(&sec, nf);
    for (i = 0; i < nf; i++) uleb(&sec, 0);
    section(mod, 3, &sec);
    uleb(&sec, nf);
    for (i = 0; i < nf; i++) {
        char name[16];
        snprintf(name, sizeof(name), "f%d", i);
        put_str(&sec, name); put(&sec, 0x00); uleb(&sec, N_IMPORTS + i);
    }
    section(mod, 7, &sec);
    uleb(&sec, nf);
    put_bytes(&sec, code->b, code->len);
    section(mod, 10, &sec);
    free(sec.b);
}

#define REGION_MAX 128
#define PEND_MAX   16
static int regions_on = 1;

/* Regions compile asynchronously (off the VM thread): until one is ready its
   blocks keep running as single-block functions. */
EM_JS(void, js_jit_instantiate_async, (const uint8_t *buf, int len, int nfuncs, int token), {
    const J = Module.xnJit ??= { base: -1, next: -1 };
    WebAssembly.compile(HEAPU8.slice(buf, buf + len)).then((mod) => {
        const inst = new WebAssembly.Instance(mod, { e: {
            m: wasmMemory, ld: wasmExports['xn_jit_ld'], st: wasmExports['xn_jit_st'],
            mulh: wasmExports['xn_jit_mulh'], div: wasmExports['xn_jit_div'], x1: wasmExports['xn_jit_exec1'],
        } });
        if (J.base < 0) { J.base = J.next = wasmTable.length; }
        if (J.next + nfuncs > wasmTable.length) wasmTable.grow(J.next + nfuncs - wasmTable.length);
        const first = J.next;
        for (let i = 0; i < nfuncs; i++) wasmTable.set(first + i, inst.exports['f' + i]);
        J.next += nfuncs;
        wasmExports['xn_jit_regions_ready'](token, first);
    }).catch((e) => {
        console.error('[xiaonux] jit region module failed', e);
        wasmExports['xn_jit_regions_ready'](token, -1);
    });
});

typedef struct { uint32_t key, gen, seq; int32_t page; uint16_t r; } PendEnt;
static struct { int token, n, nr; PendEnt *e; } pend[PEND_MAX];
static int n_pend, next_token = 1;

static void pend_clear(void)
{
    int i;
    for (i = 0; i < n_pend; i++) free(pend[i].e);
    n_pend = 0;   /* modules still compiling report back with unknown tokens: ignored */
}

/* A region module finished compiling: point its blocks at it, unless their page
   changed meanwhile or a newer region for the page is already installed. */
EMSCRIPTEN_KEEPALIVE void xn_jit_regions_ready(int token, int base)
{
    int i, p;
    for (p = 0; p < n_pend && pend[p].token != token; p++) ;
    if (p == n_pend) return;
    if (base >= 0) {
        st_modules++;
        st_regions += pend[p].nr;
        for (i = 0; i < pend[p].n; i++) {
            PendEnt *e = &pend[p].e[i];
            Block *b;
            uint32_t fi = fast_idx(e->key);
            if (page_gen[e->page] != e->gen || e->seq < page_rinst[e->page]) continue;
            b = find(e->key, 0);
            if (!b || b->state != B_READY) continue;
            page_rinst[e->page] = e->seq;
            b->fn = base + e->r;
            if (fast[fi].key == e->key) fast[fi].fn = b->fn;
            st_region_blocks++;
        }
    }
    free(pend[p].e);
    pend[p] = pend[--n_pend];
}

/* (Re)build one region per page touched by this flush, over every READY block
   of that page -- only once the page has grown enough since its last region,
   so a warming page isn't recompiled for every new block. */
static void build_regions(const uint32_t *keys, int nf)
{
    static Insn ins[MAX_BLOCK_INSNS];
    static uint32_t rkeys[BATCH_MAX][REGION_MAX];
    static int rn[BATCH_MAX], rpage[BATCH_MAX];
    Buf code = { 0 }, body = { 0 }, mod = { 0 };
    PendEnt *ents;
    int i, j, r, nr = 0, ne = 0;

    if (n_pend >= PEND_MAX) return;   /* compiler busy: try again on a later flush */
    for (i = 0; i < nf; i++) {
        int page = ram_page_of(keys[i]), e, m = 0, dup = 0, last;
        if (page < 0) continue;
        for (r = 0; r < nr; r++) if (rpage[r] == page) dup = 1;
        if (dup) continue;
        for (e = page_head[page]; e >= 0 && m < REGION_MAX; e = blocks[e].next_in_page) {
            int end_off;
            if (blocks[e].state != B_READY) continue;
            if (!decode_block((const uint8_t *)(uintptr_t)blocks[e].key, ins, &end_off)) continue;
            rkeys[nr][m++] = blocks[e].key;
        }
        last = page_rn[page];
        if (m < 2 || (last && m < last + (last / 2 > 4 ? last / 2 : 4))) continue;
        body.len = 0;
        gen_region(&body, rkeys[nr], NULL, m);
        uleb(&code, body.len);
        put_bytes(&code, body.b, body.len);
        page_rn[page] = m;
        rpage[nr] = page; rn[nr] = m; ne += m; nr++;
    }
    if (!nr) goto done;
    ents = malloc(ne * sizeof(PendEnt));
    for (r = 0, i = 0; r < nr; r++) {
        uint32_t seq = ++page_rseq[rpage[r]];
        for (j = 0; j < rn[r]; j++, i++) {
            ents[i].key = rkeys[r][j]; ents[i].page = rpage[r]; ents[i].r = r;
            ents[i].gen = page_gen[rpage[r]]; ents[i].seq = seq;
        }
    }
    assemble_module(&mod, &code, nr);
    pend[n_pend].token = next_token++;
    pend[n_pend].n = ne; pend[n_pend].nr = nr; pend[n_pend].e = ents;
    n_pend++;
    js_jit_instantiate_async(mod.b, mod.len, nr, pend[n_pend - 1].token);   /* copies the bytes */
 done:
    free(mod.b); free(code.b); free(body.b);
}

/* Compile all queued blocks into one module. Called between slices. */
void xn_jit_flush(void)
{
    static Insn ins[MAX_BLOCK_INSNS];
    static uint32_t keys[BATCH_MAX];
    static uint16_t lens[BATCH_MAX];
    Buf mod = { 0 }, code = { 0 }, body = { 0 };
    int i, nf = 0, base;

    if (!queue_len)
        return;
    /* code section first, so we know which blocks made it */
    for (i = 0; i < queue_len; i++) {
        Block *b = find(queue[i], 0);
        int n, end_off;
        if (!b || b->state != B_QUEUED)
            continue;   /* invalidated while queued */
        n = decode_block((const uint8_t *)(uintptr_t)queue[i], ins, &end_off);
        if (n == 0) {
            b->state = B_UNTRANSLATABLE;
            st_untranslatable++;
            continue;
        }
        body.len = 0;
        gen_block(&body, ins, n, end_off);
        uleb(&code, body.len);
        put_bytes(&code, body.b, body.len);
        keys[nf] = queue[i];
        lens[nf] = n;
        nf++;
    }
    queue_len = 0;
    if (!nf)
        goto done;

    assemble_module(&mod, &code, nf);

    base = js_jit_instantiate(mod.b, mod.len, nf, 0);
    if (base < 0) {
        for (i = 0; i < nf; i++) {
            Block *b = find(keys[i], 0);
            if (b) { b->state = B_UNTRANSLATABLE; st_untranslatable++; }
        }
        goto done;
    }
    st_modules++;
    for (i = 0; i < nf; i++) {
        Block *b = find(keys[i], 0);
        if (!b || b->state != B_QUEUED)
            continue;
        b->fn = base + i;
        b->ninsn = lens[i];
        b->state = B_READY;
        mark_code_page(keys[i], b);
        st_translated++;
    }
    if (regions_on)
        build_regions(keys, nf);
 done:
    free(mod.b); free(code.b); free(body.b);
    if (n_blocks >= MAX_BLOCKS)
        xn_jit_reset();
}

/* ------------------------------------------------------------------ */
/* 4e: shipped translations, keyed by block content */

typedef struct { uint64_t hash; const uint8_t *bytes; uint16_t len, ninsn; int32_t fn; } Pre;
static Pre *pre;
static int pre_cap;   /* open addressing, cap = power of two */

static uint64_t fnv(const uint8_t *p, int n)
{
    uint64_t h = 1469598103934665603ULL ^ (uint64_t)n;
    while (n--) { h ^= *p++; h *= 1099511628211ULL; }
    return h;
}

/* Identifies everything a translation depends on besides the guest bytes. */
EMSCRIPTEN_KEEPALIVE uint32_t xn_jit_build_id(void)
{
    uint32_t v[] = { 6 /* codegen version */, OFF_PC, OFF_REG(0), OFF_NCYC, OFF_TMP, OFF_TLBR, OFF_TLBW,
                     TLB_ESZ, TLB_SIZE, OFF_MIP, OFF_MIE, OFF_FREG(0), OFF_FS, MAX_BLOCK_INSNS,
                     OFF_FFLAGS, OFF_FRM };
    return (uint32_t)fnv((const uint8_t *)v, sizeof(v));
}

static Pre *pre_find(uint64_t h)
{
    uint32_t i;
    if (!pre_cap) return NULL;
    for (i = (uint32_t)h & (pre_cap - 1); pre[i].len; i = (i + 1) & (pre_cap - 1))
        if (pre[i].hash == h) return &pre[i];
    return NULL;
}

/* Is the block starting at ptr one we shipped? Then use it right away. */
static xn_block_fn preload_lookup(uint8_t *ptr, int *ninsn)
{
    static Insn ins[MAX_BLOCK_INSNS];
    int n, end_off;
    uint64_t h;
    Pre *p;
    Block *b;
    if (!n_pre) return NULL;
    n = decode_block(ptr, ins, &end_off);
    if (!n) return NULL;
    h = fnv(ptr, end_off);
    p = pre_find(h);
    if (!p || p->len != end_off || p->ninsn != n || memcmp(p->bytes, ptr, end_off) != 0)
        return NULL;
    b = find((uint32_t)(uintptr_t)ptr, 1);
    if (!b || b->state == B_READY) return NULL;
    b->state = B_READY;
    b->fn = p->fn;
    b->ninsn = n;
    mark_code_page((uint32_t)(uintptr_t)ptr, b);
    st_preloaded_hits++;
    *ninsn = n;
    return (xn_block_fn)(uintptr_t)p->fn;
}

/* Bundle: "XNJ1" | build_id u32 | n u32 | wasm_len u32 | wasm | n x (len u16, ninsn u16, bytes) */
EMSCRIPTEN_KEEPALIVE int xn_jit_preload(const uint8_t *buf, int len)
{
    uint32_t n, wasm_len, i, off;
    const uint8_t *idx;
    int base;
    if (len < 16 || memcmp(buf, "XNJ1", 4) != 0) return -1;
    if (*(const uint32_t *)(buf + 4) != xn_jit_build_id()) return -2;   /* other emulator build */
    n = *(const uint32_t *)(buf + 8);
    wasm_len = *(const uint32_t *)(buf + 12);
    if (16 + wasm_len > (uint32_t)len) return -1;
    base = js_jit_instantiate(buf + 16, wasm_len, n, 1);
    if (base < 0) return -3;
    /* keep the index bytes: we compare guest code against them */
    {
        uint32_t idx_len = len - 16 - wasm_len;
        uint8_t *copy = malloc(idx_len);
        memcpy(copy, buf + 16 + wasm_len, idx_len);
        idx = copy;
        pre_cap = 1;
        while (pre_cap < (int)n * 2) pre_cap <<= 1;
        pre = calloc(pre_cap, sizeof(Pre));
        for (i = 0, off = 0; i < n && off + 4 <= idx_len; i++) {
            uint16_t blen = idx[off] | (idx[off + 1] << 8), ni = idx[off + 2] | (idx[off + 3] << 8);
            const uint8_t *bytes = idx + off + 4;
            uint64_t h = fnv(bytes, blen);
            uint32_t j = (uint32_t)h & (pre_cap - 1);
            while (pre[j].len) j = (j + 1) & (pre_cap - 1);
            pre[j].hash = h; pre[j].bytes = bytes; pre[j].len = blen; pre[j].ninsn = ni; pre[j].fn = base + i;
            off += 4 + blen;
            n_pre++;
        }
    }
    return n_pre;
}

/* Regenerate every translated block from the code now in RAM into one module
   plus the content index. Returns a malloc'd bundle (caller frees). */
EMSCRIPTEN_KEEPALIVE uint8_t *xn_jit_export(int *out_len)
{
    static Insn ins[MAX_BLOCK_INSNS];
    Buf code = { 0 }, body = { 0 }, index = { 0 }, mod = { 0 }, out = { 0 };
    int i, nf = 0;
    for (i = 0; i < TABLE_SIZE; i++) {
        Block *b = &blocks[i];
        int n, end_off;
        uint64_t h;
        if (!b->key || b->state != B_READY) continue;
        n = decode_block((const uint8_t *)(uintptr_t)b->key, ins, &end_off);
        if (!n) continue;
        h = fnv((const uint8_t *)(uintptr_t)b->key, end_off);
        if (pre_find(h) && 0) continue;
        body.len = 0;
        gen_block(&body, ins, n, end_off);
        uleb(&code, body.len);
        put_bytes(&code, body.b, body.len);
        put(&index, end_off & 0xff); put(&index, end_off >> 8);
        put(&index, n & 0xff); put(&index, n >> 8);
        put_bytes(&index, (const void *)(uintptr_t)b->key, end_off);
        nf++;
    }
    assemble_module(&mod, &code, nf);
    {
        uint32_t hdr[4];
        memcpy(hdr, "XNJ1", 4);
        hdr[1] = xn_jit_build_id();
        hdr[2] = nf;
        hdr[3] = mod.len;
        put_bytes(&out, hdr, 16);
    }
    put_bytes(&out, mod.b, mod.len);
    put_bytes(&out, index.b, index.len);
    free(code.b); free(body.b); free(index.b); free(mod.b);
    *out_len = out.len;
    return out.b;
}
