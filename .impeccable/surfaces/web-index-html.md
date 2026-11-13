---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/src/main.ts","web/src/style.css","web/src/i18n/en.ts"]
---

# xiaonux web app (start view + workspace)

Mode: Operate for the workspace and the start view's cover; the start page's "Your own xiaonux" section is Persuade (services offer, contact@xiaonux.dev).
Audience/job: students practising Unix; security learners inspecting a file safely; schools, course authors and security teams who may buy custom images, self-hosting/embedding, workshops, or support. Task: get a prompt, follow a guide, move files in/out, decide on network; for buyers, understand the offer and email.
Constraints: no framework, no web fonts (first-load weight), xterm.js terminal, light/dark, 390 px, keyboard-first. No prices, customers or testimonials (none exist).
Memorable moment: whichever tile holds the keyboard wears the ochre frame; Ctrl+Shift+G moves it between terminal and guide.
Unresolved: helper hosting URL; translations of the svc.* strings (other locales fall back to English).

## Direction contract

THESIS: xiaonux is a tiled Linux workstation, set up the way Linux people set up their own. Refuses both the fake desktop with draggable windows and the near-black page with one neon accent.
OWN-WORLD: i3/sway tiling setups. Deep teal ground with gapped tiles (dark), sand ground with paper tiles (light); a thin near-black status bar in both; sand text; ochre only on pressable primaries, the next guide step, and the focused tile; sage for done/connected, coral for errors. System sans for prose and titles; mono for the status bar, tile heads, labels that are data, and commands.
STORY: start page opens with the same status bar the machine wears, the headline, Start, and the guides as a tile; below, tiles for what's on the machine, use cases, nested tiles for how it works, safety, then the services offer as a gapped 2x2 tiling inside a dark frame with an Email button. Workspace: status bar (name, status, network module, MIPS, Upload, Download, Reset, Guide), terminal tile, right column with the guide tile (guides/network/safety tabs) and a dismissible services tile.
FIRST VIEWPORT: matches .impeccable/mocks/decision/tiling.html (chosen sketch).
FORM: Tiling Workstation, grounded candidate chosen over the rolled Silicon Datasheet, Debian Desktop pick, and cloud-shell canon. seed:ae4c70c96f12932f
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md.
