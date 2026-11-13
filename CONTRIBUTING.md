# Contributing

Thanks for helping. Issues and pull requests are welcome at https://github.com/rosdyana/xiaonux.

- **Small, focused changes.** One topic per pull request, with a sentence on why.
- **Measure performance changes.** If a change could affect speed or download size, run the relevant `bench/` script before and after and put the numbers in the PR.
- **Don't commit build outputs.** Disk images, kernels, WASM and wheels go in `build/` or `dist/`, which are ignored.
- **Clean-room.** Don't copy, fetch or adapt code, WebAssembly or configuration from other browser-emulator products. Open-source code under a compatible license is fine with attribution in `NOTICE`.
- **Licensing.** By contributing you agree your contribution is licensed under Apache-2.0. New files of ours start with `SPDX-License-Identifier: Apache-2.0`. Changes inside TinyEMU's own files stay under its MIT license; mark them with a `xiaonux` comment.
- **Tests.** `cd web && pnpm typecheck && pnpm build`; with `make serve` running, `cd bench && node ui-test.mjs` and `node suite.mjs`.

## Contributing lessons


Guided lessons live in `web/src/lessons/` as JSON, one file per lesson. Each file has this shape:

```json
{
  "id": "log-basics",
  "title": "Logs: find the failed logins",
  "intro": "One sentence on what the lesson is for.",
  "steps": [
    { "text": "Count the lines in the log.", "cmd": "wc -l /root/uploads/auth.log" },
    { "text": "Show the first failed login.", "cmd": "grep -m1 'Failed password' /root/uploads/auth.log" }
  ]
}
```

Each step's `cmd` is typed into the terminal when the visitor presses Type it, and it is checked off when the shell prompt returns. Add a new lesson by creating its JSON file and importing it in the `LESSONS` list in `web/src/ui/guides.ts`. Keep each command to what the image ships.

For security issues, see [SECURITY.md](SECURITY.md).
