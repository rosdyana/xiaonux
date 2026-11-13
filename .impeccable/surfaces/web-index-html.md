---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/src/main.ts","web/src/style.css"]
---

# xiaonux web app (start view + workspace)

Mode: Operate (the start view is the workspace's front door, not a marketing page).
Audience/job: students practising Unix; security learners inspecting a file safely. Task: get a prompt, follow a guide, move files in/out, decide on network.
Constraints: no framework, no web fonts (first-load weight), xterm.js terminal, light/dark, 390 px, keyboard-first.
Memorable moment: a guide step gets a hand-drawn red-pen check when its command has run.
Unresolved: production domain; helper hosting URL.

## Direction contract

THESIS: xiaonux is a lab session with a worksheet beside the machine. Refuses the category default of a black page with a neon accent and a floating terminal "window".
OWN-WORLD: university lab worksheet. Bond-white paper ground, cover-stock blue shell (top bar, primary buttons; blue only on things you can press), graphite text, faint blue ruling under guide steps, teacher's red pen reserved for state marks (checks, warnings). Dark: blue-black ink-wash ground, same blue lifted, pen red lifted. System sans; mono only for commands.
STORY: visitor sees what it is in one line, presses Start (or a "Try it" for their purpose), lands in the shell with a worksheet drawer; steps type into the shell and get checked off; network and safety are plain answers, not warnings.
FIRST VIEWPORT: start view: left column value line at display size, Start button, live "prompt in N s" measure; right: three worksheet rows (Learn Unix / Python & packages / Security lab) as ruled rows with "Try it". Facts row under. Workspace: blue top bar (name, status, network chip, Upload, Download, Reset, Guide toggle), terminal fills the rest, worksheet drawer at right (Guides / Network / Safety tabs).
FORM: lab worksheet, candidate 4 of 7 on my list; raises: action colour only where something can be pressed (from warm-consumer-app); completed steps stay visible and checked, nothing disappears (from ticket wallet); status fields in fixed cells with tabular numerals that change without moving the layout (from split-flap). seed:8c6f32fa877b0e46
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
