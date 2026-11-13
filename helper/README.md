# xiaonux-net

Lets the xiaonux browser VM use **this computer's** internet. The page's
network is off by default; running this helper turns it on for that tab.

| Platform | File | Notes |
|---|---|---|
| Windows x86_64 | `xiaonux-net-<v>-windows-x86_64.msi` (or `.exe`) | Per-user install to `%LOCALAPPDATA%\Programs\xiaonux-net`, Start Menu entry. Unsigned for now: SmartScreen asks "More info → Run anyway". |
| macOS (Intel + Apple silicon) | `xiaonux-net-<v>-macos-universal.zip` | Unsigned for now: right-click → Open the first time (or `xattr -d com.apple.quarantine xiaonux-net`). |
| Linux x86_64 / ARM64 | `xiaonux-net-<v>-linux-<arch>.tar.gz` | Static (musl), no dependencies. `tar xzf …; ./xiaonux-net` |
| from source | `cargo install --path helper` | Rust 1.80+ |

Run it and keep its window open. It prints a pairing link and opens it in
your browser (`--no-open` to skip). The page remembers the pairing.

## Safety
- Listens on `127.0.0.1` only; accepts only the xiaonux page's origin
  (`--origin` to add one) and requests carrying the pairing token.
- Refuses loopback, private and link-local destinations (your router,
  NAS, other machines) unless started with `--allow-lan`. It checks the
  address *after* resolving, so DNS tricks can't reach your network.
- Ports 80/443 only unless `--any-port`. Logs host names and byte counts
  with `-v`, never content.

## Building releases
`helper/release.sh` builds every platform from macOS (zig + cargo-zigbuild for
Linux/Windows, `lipo` for macOS, `wixl` in the builder VM for the `.msi`) into
`dist/vm/helper/`, with `SHA256SUMS` and `latest.json` (which the page reads to
offer the right download). `XIAONUX_ORIGIN=https://…` bakes the published
page in as the default origin.
