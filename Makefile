# xiaonux — one command per job. Build outputs go to build/ and dist/ (git-ignored).

EMSDK ?= $(HOME)/emsdk
ORB   ?= /Applications/OrbStack.app/Contents/MacOS/bin/orb
VM    ?= builder
EMENV := . $(EMSDK)/emsdk_env.sh >/dev/null 2>&1 &&
CMDLINE ?= console=hvc0 root=/dev/vda rw earlycon=sbi
RAM ?= 256

.PHONY: emu wasm firmware kernel rootfs image stage stage-snapshot prefetch web dev boot-native boot-chrome clean vm-stop

emu:            ## native temu + splitimg (debugging)
	$(MAKE) -C emu

wasm:           ## TinyEMU -> build/wasm/xemu.{mjs,wasm}
	$(EMENV) $(MAKE) -C emu -f Makefile.wasm

firmware:       ## OpenSBI fw_jump -> build/fw_jump.bin (builder VM)
	$(ORB) -m $(VM) image/build-opensbi.sh

kernel:         ## Linux -> build/Image (builder VM)
	$(ORB) -m $(VM) image/build-kernel.sh

rootfs:         ## Debian riscv64 -> build/rootfs.img (builder VM)
	$(ORB) -m $(VM) sudo image/build-rootfs.sh

image: firmware kernel rootfs vm-stop

vm-stop:        ## stop the builder VM (8 GB Mac)
	-$(ORB) stop $(VM)

build/xiaonux.cfg: image/xiaonux.cfg.in
	sed -e 's|@CMDLINE@|$(CMDLINE)|' -e 's|@RAM@|$(RAM)|' $< > $@

boot-native: emu build/xiaonux.cfg   ## boot build/ files with native temu
	python3 bench/boot-native.py build/emu-native/temu build/xiaonux.cfg --login root:root --cmd "uname -a"

stage: wasm     ## build/ -> dist/vm, cold-boot only (chunked disk)
	python3 image/stage-vm.py --bios build/fw_jump.bin --kernel build/Image \
	  --rootfs build/rootfs.img --cmdline "$(CMDLINE)"

stage-snapshot: emu wasm   ## build/ -> dist/vm with the shipped snapshot (256 MB guest)
	python3 image/stage-vm.py --bios build/fw_jump.bin --kernel build/Image \
	  --rootfs build/rootfs.img --cmdline "$(CMDLINE)" --snapshot

prefetch:       ## record first-command chunks in Chrome (needs `make dev`) and bundle them
	cd bench && rm -rf ../build/rec-profile && node browser-boot.mjs --profile ../build/rec-profile \
	  --url "http://localhost:5180/?autoboot&record" --timeout 300 \
	  --cmd "python3 -c pass" --cmd "pip --version" --cmd "apt-get --version" --cmd "nano --version" \
	  --cmd "curl --version" --cmd "ls -la /usr/bin" --cmd "ip addr" --cmd "ping -V" > ../build/rec.json
	python3 -c "import json; t=open('build/rec.json').read(); d=json.loads(t[t.find('{'):]); json.dump(d['stats']['disk']['fetchOrder'], open('build/prefetch-order.json','w'))"
	python3 image/prefetch.py --vm dist/vm --order build/prefetch-order.json

web:            ## production page -> web/dist
	cd web && pnpm install --frozen-lockfile && pnpm build

dev:            ## dev server with COOP/COEP on http://localhost:5180
	cd web && pnpm install --frozen-lockfile && pnpm dev

boot-chrome:    ## headless Chrome test against `make dev` (snapshot path, 100 Mbit/s)
	cd bench && node browser-boot.mjs --mbit 100 --cmd "uname -a" --cmd 'python3 -c "print(2+2)"' --cmd "df -h"

clean:
	rm -rf build/emu-native build/wasm dist/vm
