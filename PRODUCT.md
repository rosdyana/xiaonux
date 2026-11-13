# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Students learning Unix.** They have a laptop (often Windows or a school Chromebook) and no Linux install. They want a real shell to practise files, pipes, permissions and processes, follow course exercises, and break things without consequences.
- **Security learners and pentesters.** They want a throwaway Linux box to inspect a suspicious file or script (static analysis, scripts, riscv64 dynamic analysis) without running it on their own machine.

Both arrive from a link, use it for a session of minutes to an hour, and come back later expecting their files to still be there.

## Product Purpose

xiaonux runs a real Debian 13 (riscv64) system inside the browser tab. Nothing to install, no account, no server running the VM. The owner's stated goal: open source under Apache-2.0 "to share with others so they can use it safely for education, without needing to install Unix, only from the browser".

Success: a visitor gets a working shell prompt in seconds, can do real Unix and Python work, can move files in and out, and understands what is and isn't safe.

## Positioning

The machine runs entirely on the visitor's own computer, in the tab: emulated RISC-V in WebAssembly, so guest code never runs on the host CPU and nothing is sent to a server. It restores from a snapshot (warm prompt about 0.4 s, cold about 2 s), keeps changes in the browser (OPFS), and keeps the network off unless the visitor turns it on.

## Operating Context

- Desktop browsers first (Chrome, Edge, Firefox, Safari); phones and tablets must work with an on-screen key row.
- Network modes: Off (default); "This computer" through the xiaonux-net helper (unsigned binaries for Windows .msi, macOS, Linux; localhost only, ports 80/443, never the LAN); Relay (free Cloudflare Worker, limited to pip/apt/GitHub hosts, Turnstile check).
- Files: upload into `/root/uploads` (mode 0600, never executable by default), download from anywhere under `/root`.
- Reset deletes all changes and returns to the shipped image.

## Capabilities and Constraints

- Debian 13 with Python 3, pip with an offline wheel index (numpy, pandas, cryptography, pillow, ...), and security tools: file, binutils-multiarch, xxd, strace, ltrace, gdb, yara, binwalk, hexedit, jq, tcpdump, nmap, netcat, python3-pefile, 7zip.
- x86, ARM and Windows executables do not run. It is not a hardened malware lab: with the helper on, a sample can reach the internet from the visitor's IP.
- Clean-room: nothing from ClairEmu may be copied or adapted.
- Production domain: https://xiaonux.dev

## Brand Commitments

- Name: xiaonux (lowercase).
- License: Apache-2.0 for xiaonux code; third-party licenses shown on a Licenses page.
- Repository: https://github.com/rosdyana/xiaonux
- Plain, honest language about safety limits; no hype.

## Evidence on Hand

- Benchmarks (warm prompt 0.37–0.46 s, cold 1.9 s at 100 Mbit, first download 13.8 MB).
- No testimonials, users, or press exist; do not invent them.

## Product Principles

1. The terminal is the product; everything else gets out of its way.
2. Be honest about safety: say what is isolated and what is not.
3. Nothing to install for the core experience; the helper is optional and clearly explained.
4. Teach by doing: guides type real commands into the real shell.
5. Fast first prompt is a feature; don't add weight to the first load.

## Accessibility & Inclusion

Keyboard-first (terminal focus, visible focus rings), readable in light and dark, works at 390 px width, respects reduced motion.
