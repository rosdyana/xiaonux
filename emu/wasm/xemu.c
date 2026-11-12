/*
 * JS emulator main
 * 
 * Copyright (c) 2016-2017 Fabrice Bellard
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <inttypes.h>
#include <assert.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>
#include <time.h>
#include <emscripten.h>

#include "cutils.h"
#include "iomem.h"
#include "virtio.h"
#include "machine.h"
#include "list.h"
#include <brotli/decode.h>

/* xiaonux: worker-oriented front end, derived from TinyEMU's jsemu.c.
   Terminal only (no framebuffer/input devices). The JS side drives the
   main loop by calling vm_run_slice() and schedules the next call itself. */

/* provided in lib.js */
extern void console_write(void *opaque, const uint8_t *buf, int len);
extern void console_get_size(int *pw, int *ph);
extern void net_recv_packet(EthernetDevice *bs,
                            const uint8_t *buf, int len);
extern void vm_on_ready(int restored);
extern void agent_output(const uint8_t *buf, int len);

/* riscv_machine.c */
int riscv_machine_snapshot_save(VirtMachine *s1, uint8_t **pbuf, size_t *plen);
int riscv_machine_snapshot_load(VirtMachine *s1, const uint8_t *buf, size_t len);

/* blk_chunk.c */
BlockDevice *blk_chunk_device(void);

static uint8_t console_fifo[4096];
static int console_fifo_windex;
static int console_fifo_rindex;
static int console_fifo_count;
static BOOL console_resize_pending;

static VirtMachine *global_vm;
static BOOL global_carrier_state;

static int console_read(void *opaque, uint8_t *buf, int len)
{
    int out_len, l;
    len = min_int(len, console_fifo_count);
    console_fifo_count -= len;
    out_len = 0;
    while (len != 0) {
        l = min_int(len, sizeof(console_fifo) - console_fifo_rindex);
        memcpy(buf + out_len, console_fifo + console_fifo_rindex, l);
        len -= l;
        out_len += l;
        console_fifo_rindex += l;
        if (console_fifo_rindex == sizeof(console_fifo))
            console_fifo_rindex = 0;
    }
    return out_len;
}

/* called from JS; returns 0 when the FIFO is full */
EMSCRIPTEN_KEEPALIVE int console_queue_char(int c)
{
    if (console_fifo_count >= sizeof(console_fifo))
        return 0;
    console_fifo[console_fifo_windex] = c;
    if (++console_fifo_windex == sizeof(console_fifo))
        console_fifo_windex = 0;
    console_fifo_count++;
    return 1;
}

/* called from JS when the terminal size changes */
EMSCRIPTEN_KEEPALIVE void console_resize(void)
{
    console_resize_pending = TRUE;
}

/* called from JS (Phase 3) */
EMSCRIPTEN_KEEPALIVE void net_write_packet(const uint8_t *buf, int buf_len)
{
    EthernetDevice *net;
    if (!global_vm)
        return;
    net = global_vm->net;
    if (net)
        net->device_write_packet(net, buf, buf_len);
}

/* called from JS: can the guest take another frame right now? */
EMSCRIPTEN_KEEPALIVE int net_can_write(void)
{
    EthernetDevice *net = global_vm ? global_vm->net : NULL;
    return net && net->device_can_write_packet(net);
}

EMSCRIPTEN_KEEPALIVE void net_set_carrier(BOOL carrier_state)
{
    EthernetDevice *net;
    global_carrier_state = carrier_state;
    if (global_vm && global_vm->net) {
        net = global_vm->net;
        net->device_set_carrier(net, carrier_state);
    }
}

/* ---- guest agent channel (/dev/hvc1) ---- */
static uint8_t agent_fifo[4096];
static int agent_fifo_len;

static void agent_write(void *opaque, const uint8_t *buf, int len)
{
    agent_output(buf, len);
}

static int agent_read(void *opaque, uint8_t *buf, int len)
{
    return 0; /* we push with virtio_console_write_data instead */
}

static CharacterDevice agent_chardev = {
    .write_data = agent_write, .read_data = agent_read,
};

/* called from JS: queue bytes for the agent; returns bytes accepted */
EMSCRIPTEN_KEEPALIVE int agent_send(const uint8_t *buf, int len)
{
    len = min_int(len, sizeof(agent_fifo) - agent_fifo_len);
    memcpy(agent_fifo + agent_fifo_len, buf, len);
    agent_fifo_len += len;
    return len;
}

static void agent_pump(void)
{
    int n;
    if (agent_fifo_len == 0 || !xn_agent_dev ||
        !virtio_console_can_write_data(xn_agent_dev))
        return;
    n = min_int(agent_fifo_len, virtio_console_get_write_len(xn_agent_dev));
    if (n <= 0)
        return;
    virtio_console_write_data(xn_agent_dev, agent_fifo, n);
    memmove(agent_fifo, agent_fifo + n, agent_fifo_len - n);
    agent_fifo_len -= n;
}

/* ---- snapshots ---- */
static uint8_t *pending_snapshot;
static size_t pending_snapshot_len;

/* called from JS before vm_start: a Brotli-compressed snapshot to restore
   right after the machine is built. Returns 0, or -1 if it won't decode. */
EMSCRIPTEN_KEEPALIVE int vm_set_snapshot(const uint8_t *buf, int len, int raw_len)
{
    size_t out_len = raw_len;
    uint8_t *out = malloc(raw_len);
    if (!out)
        return -1;
    if (BrotliDecoderDecompress(len, buf, &out_len, out) != BROTLI_DECODER_RESULT_SUCCESS ||
        out_len != (size_t)raw_len) {
        free(out);
        return -1;
    }
    pending_snapshot = out;
    pending_snapshot_len = out_len;
    return 0;
}

/* called from JS before vm_start: an uncompressed snapshot in a buffer
   from _malloc; we take ownership. */
EMSCRIPTEN_KEEPALIVE void vm_set_snapshot_raw(uint8_t *buf, int len)
{
    free(pending_snapshot);
    pending_snapshot = buf;
    pending_snapshot_len = len;
}

/* called from JS: save the running machine. Returns a malloc'd buffer
   (length in *plen) or NULL if busy; JS frees it. */
EMSCRIPTEN_KEEPALIVE uint8_t *vm_snapshot_save(int *plen)
{
    uint8_t *buf;
    size_t len;
    if (!global_vm || riscv_machine_snapshot_save(global_vm, &buf, &len) < 0)
        return NULL;
    *plen = (int)len;
    return buf;
}

static CharacterDevice *console_init(void)
{
    CharacterDevice *dev;
    console_resize_pending = TRUE;
    dev = mallocz(sizeof(*dev));
    dev->write_data = console_write;
    dev->read_data = console_read;
    return dev;
}

typedef struct {
    VirtMachineParams *p;
    int ram_size;
    char *cmdline;
    BOOL has_network;
} VMStartState;

static void init_vm(void *arg);
static void init_vm_drive(void *arg);

/* Max RAM (KB) the HTTP block device may use to cache disk blocks. */
#define HTTP_BLOCK_CACHE_KB 131072

EMSCRIPTEN_KEEPALIVE void vm_start(const char *url, int ram_size_mb,
                                   const char *cmdline, BOOL has_network)
{
    VMStartState *s;

    s = mallocz(sizeof(*s));
    s->ram_size = ram_size_mb;
    s->cmdline = strdup(cmdline ? cmdline : "");
    s->has_network = has_network;
    s->p = mallocz(sizeof(VirtMachineParams));
    virt_machine_set_defaults(s->p);
    virt_machine_load_config_file(s->p, url, init_vm_drive, s);
}

static void init_vm_drive(void *arg)
{
    VMStartState *s = arg;
    VirtMachineParams *p = s->p;

    if (p->drive_count > 0) {
        BlockDevice *chunked = blk_chunk_device();
        assert(p->drive_count == 1);
        if (chunked) {
            /* Phase 2 disk, set up by JS before vm_start */
            p->tab_drive[0].block_dev = chunked;
            init_vm(s);
        } else {
            p->tab_drive[0].block_dev =
                block_device_init_http(p->tab_drive[0].filename,
                                       HTTP_BLOCK_CACHE_KB, init_vm, s);
        }
    } else {
        init_vm(s);
    }
}

static void init_vm(void *arg)
{
    VMStartState *s = arg;
    VirtMachine *m;
    VirtMachineParams *p = s->p;
    int i;

    p->rtc_real_time = TRUE;
    if (s->ram_size > 0)
        p->ram_size = (uint64_t)s->ram_size << 20;
    if (s->cmdline[0] != '\0')
        vm_add_cmdline(s->p, s->cmdline);
    p->console = console_init();

    if (p->eth_count > 0 && !s->has_network) {
        for(i = 0; i < p->eth_count; i++) {
            free(p->tab_eth[i].ifname);
            free(p->tab_eth[i].driver);
        }
        p->eth_count = 0;
    }
    if (p->eth_count > 0) {
        EthernetDevice *net;
        assert(p->eth_count == 1);
        net = mallocz(sizeof(EthernetDevice));
        net->mac_addr[0] = 0x02;
        for(i = 1; i < 6; i++)
            net->mac_addr[i] = (int)(emscripten_random() * 256);
        net->write_packet = net_recv_packet;
        net->opaque = NULL;
        p->tab_eth[0].net = net;
    }

    xn_agent_chardev = &agent_chardev;
    m = virt_machine_init(p);
    global_vm = m;
    virt_machine_free_config(s->p);
    if (m->net)
        m->net->device_set_carrier(m->net, global_carrier_state);
    free(s->p);
    free(s->cmdline);
    free(s);
    {
        int restored = 0;
        if (pending_snapshot) {
            restored = riscv_machine_snapshot_load(m, pending_snapshot,
                                                   pending_snapshot_len) == 0 ? 1 : -1;
            free(pending_snapshot);
            pending_snapshot = NULL;
        }
        vm_on_ready(restored);
    }
}

#define MAX_SLEEP_TIME 10 /* ms */

/* Run the guest for up to max_cycles instructions (in chunks of
   chunk_cycles, stopping early when the guest idles). Returns -1 if the
   VM isn't ready, 0 if the guest is still runnable, else the number of
   ms the guest is asleep for (waiting on its timer). */
EMSCRIPTEN_KEEPALIVE int vm_run_slice(int max_cycles, int chunk_cycles)
{
    VirtMachine *m = global_vm;
    int delay, done;

    if (!m)
        return -1;
    if (m->console_dev && virtio_console_can_write_data(m->console_dev)) {
        uint8_t buf[512];
        int ret, len;
        len = virtio_console_get_write_len(m->console_dev);
        len = min_int(len, sizeof(buf));
        ret = m->console->read_data(m->console->opaque, buf, len);
        if (ret > 0)
            virtio_console_write_data(m->console_dev, buf, ret);
        if (console_resize_pending) {
            int w, h;
            console_get_size(&w, &h);
            virtio_console_resize_event(m->console_dev, w, h);
            console_resize_pending = FALSE;
        }
    }
    agent_pump();
    done = 0;
    for(;;) {
        delay = virt_machine_get_sleep_duration(m, MAX_SLEEP_TIME);
        if (delay != 0 || done >= max_cycles)
            break;
        virt_machine_interp(m, chunk_cycles);
        done += chunk_cycles;
    }
    return delay;
}
