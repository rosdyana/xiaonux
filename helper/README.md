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

To stop it, press Ctrl+C in its window or close the window. It installs no
service and never starts by itself; run it again next time.

## Safety
- Listens on `127.0.0.1` only; accepts only the xiaonux page's origin
  (`--origin` to add one) and requests carrying the pairing token.
- Refuses loopback, private and link-local destinations (your router,
  NAS, other machines) unless started with `--allow-lan`. It checks the
  address *after* resolving, so DNS tricks can't reach your network.
- Ports 80/443 only unless `--any-port`. Logs host names and byte counts
  with `-v`, never content.

## Building releases
Releases are built by GitHub Actions (`.github/workflows/helper-release.yml`):
bump `version` in `Cargo.toml`, then push a matching tag.

```sh
git tag helper-v0.1.1 && git push origin helper-v0.1.1
```

The workflow builds Linux (static musl, x86_64 + ARM64), Windows (`.exe` and
`.msi`) and macOS (universal) binaries and publishes them as a GitHub release
with `SHA256SUMS` and `latest.json`. Set the repository variable
`XIAONUX_ORIGIN` (e.g. `https://xiaonux.dev`) to bake the published page in
as the default origin. Then `make helper-fetch` copies `latest.json` and
`SHA256SUMS` into `dist/vm/helper/`, and the page links to the release for
the downloads.

`helper/release.sh` still builds everything locally from macOS (zig +
cargo-zigbuild, `lipo`, `wixl` in the builder VM) into `dist/vm/helper/`, with
the binaries served by the page itself.
