# Security

## The sandbox model

Programs inside xiaonux never run on your computer's processor. They run on an emulated RISC-V processor, written in C and compiled to WebAssembly, inside a Web Worker, inside your browser's tab sandbox. The guest has:

- **No access to your files or devices.** It only sees files you upload, which land in `/root/uploads` with mode `0600` (never executable by default). Downloads are limited to files under `/root`.
- **No network by default.** With the xiaonux-net helper on, guest connections go out from your computer, to ports 80 and 443 only, and private/local-network addresses are refused. With the relay on, only an allow-list of package hosts is reachable.
- **Local storage only.** Changes to the disk are kept in your browser (OPFS). Reset deletes them.

What does leave your browser (opt-in analytics, the site's hosting, the optional network) is listed in [PRIVACY.md](PRIVACY.md).

## Using it to look at malware

Good for learning and triage:

- static analysis of files from any system: `file`, `strings`, `xxd`, `objdump`/`readelf` (binutils-multiarch), `yara`, `binwalk`, `hexedit`, `pefile`;
- reading and running scripts (sh, bash, Python, Perl);
- running and tracing RISC-V Linux programs with `strace`, `ltrace` and `gdb`.

Limits, stated plainly:

- x86, ARM and Windows executables do not run (there is no translation of other processor architectures).
- It is **not a hardened malware lab**. Bugs in the emulator or the browser could in principle allow an escape; keep your browser up to date and don't analyse targeted or high-value samples here.
- With the network on, anything you run can reach the internet **from your IP address**.
- Don't put passwords, keys or other secrets into the machine.
- Follow the law and your course's or employer's rules.

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report a vulnerability** on https://github.com/rosdyana/xiaonux. Include steps to reproduce and the browser and version. Please don't open a public issue for an unfixed vulnerability.

Interesting areas: escapes from the emulator into the page (WebAssembly memory safety, the translator in `emu/wasm/jit.c`), the guest agent channel (`image/guest/xiaonux-agent`, file transfer), the network helper (`helper/`: pairing token, origin checks, LAN refusal) and the relay (`relay/`: allow-list, limits).
