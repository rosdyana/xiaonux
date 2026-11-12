# xiaonux — one command per job. Build outputs go to build/ and dist/ (git-ignored).

EMSDK ?= $(HOME)/emsdk

.PHONY: emu image web dev clean

emu:            ## native temu + splitimg (debugging)
	$(MAKE) -C emu

image:          ## kernel, rootfs, disk image (runs in the OrbStack builder VM)
	@echo "image: not yet implemented (Phase 1 steps 3-4)"; exit 1

web:            ## WASM build + Vite page
	@echo "web: not yet implemented (Phase 1 steps 6-7)"; exit 1

dev:            ## local server with COOP/COEP headers
	@echo "dev: not yet implemented (Phase 1 step 8)"; exit 1

clean:
	rm -rf build/emu-native
