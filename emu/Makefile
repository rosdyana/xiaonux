# Native (macOS/Linux) build of TinyEMU for debugging.
# riscv64 only: no SDL, no x86, no 128-bit, no FS_NET (libcurl/openssl).
# Outputs go to ../build/emu-native/.

SRC := tinyemu
OUT := ../build/emu-native
CC  ?= cc

CFLAGS := -Icompat -O2 -g -Wall -Wno-unused-but-set-variable -Wno-deprecated-non-prototype \
  -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE -D_GNU_SOURCE \
  -DCONFIG_VERSION=\"$(shell cat $(SRC)/VERSION)\" \
  -DCONFIG_RISCV_MAX_XLEN=64 -DCONFIG_RISCV64_ONLY -DCONFIG_SLIRP -MMD

ifeq ($(shell uname -s),Darwin)
# macOS names the struct stat timespec fields differently.
CFLAGS += -Dst_atim=st_atimespec -Dst_mtim=st_mtimespec -Dst_ctim=st_ctimespec
endif

SLIRP := bootp ip_icmp mbuf slirp tcp_output cksum ip_input misc socket \
  tcp_subr udp if ip_output sbuf tcp_input tcp_timer

COMMON := virtio pci fs cutils iomem simplefb json machine temu fs_disk \
  riscv_machine softfp $(addprefix slirp/,$(SLIRP))

OBJS := $(addprefix $(OUT)/,$(addsuffix .o,$(COMMON))) $(OUT)/riscv_cpu64.o

all: $(OUT)/temu $(OUT)/splitimg

$(OUT)/temu: $(OBJS)
	$(CC) -o $@ $^

$(OUT)/splitimg: $(OUT)/splitimg.o
	$(CC) -o $@ $^

$(OUT)/riscv_cpu64.o: $(SRC)/riscv_cpu.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -DMAX_XLEN=64 -c -o $@ $<

$(OUT)/%.o: $(SRC)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -rf $(OUT)

-include $(wildcard $(OUT)/*.d $(OUT)/slirp/*.d)
.PHONY: all clean
