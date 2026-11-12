/* xiaonux: RISC-V -> WASM block translator interface (WASM build, XN_JIT). */
#ifndef XN_JIT_H
#define XN_JIT_H
#include <stdint.h>

struct RISCVCPUState;
typedef int (*xn_block_fn)(struct RISCVCPUState *s);

#ifdef XN_JIT
void xn_jit_init(struct RISCVCPUState *s, uint8_t *ram, uint64_t ram_size);
void xn_jit_reset(void);
void xn_jit_flush(void);
xn_block_fn xn_jit_lookup(uint8_t *code, int *ninsn);
void xn_jit_invalidate_host_page(uintptr_t host);
int xn_jit_page_has_code(uintptr_t host);
#endif
#endif
