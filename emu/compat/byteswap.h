/* macOS has no <byteswap.h>; map glibc names to clang builtins. */
#ifndef XIAONUX_COMPAT_BYTESWAP_H
#define XIAONUX_COMPAT_BYTESWAP_H
#define bswap_16(x) __builtin_bswap16(x)
#define bswap_32(x) __builtin_bswap32(x)
#define bswap_64(x) __builtin_bswap64(x)
#endif
