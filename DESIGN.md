---
name: xiaonux
description: Real Debian Linux in the browser tab, set up as a tiled workstation the way Linux people set up their own.
colors:
  ground: "#e6dfcf"
  tile: "#f7f3ea"
  tile-2: "#eee7d8"
  term: "#fbf8f0"
  ink: "#1d3036"
  ink-2: "#4c5d61"
  line: "#d2c8b2"
  line-strong: "#ad9f80"
  accent: "#e3a43b"
  accent-hover: "#eeb24c"
  on-accent: "#1b1306"
  link: "#855000"
  accent-wash: "#f5e3bd"
  ok: "#3d7a35"
  warn: "#8a5a00"
  err: "#b2372a"
  bar: "#0f2328"
  bar-2: "#183238"
  bar-line: "#2a4a52"
  bar-ink: "#e9e2d0"
  bar-ink-2: "#a9b4ad"
  focus: "#a5650a"
  focus-dark: "#e3a43b"
  ground-dark: "#0e1f23"
  tile-dark: "#183238"
  tile-2-dark: "#1d3b42"
  term-dark: "#12262b"
  ink-dark: "#e9e2d0"
  ink-2-dark: "#a9b4ad"
  line-dark: "#2a4a52"
  line-strong-dark: "#3d6670"
  accent-hover-dark: "#f0b856"
  link-dark: "#f0b856"
  accent-wash-dark: "#3a3a26"
  ok-dark: "#8db580"
  warn-dark: "#f0c36a"
  err-dark: "#ef8576"
  bar-dark: "#0a181b"
  bar-2-dark: "#163036"
  bar-line-dark: "#24434a"
typography:
  display:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "clamp(36px, 4.8vw, 60px)"
    fontWeight: 760
    lineHeight: 1.03
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  wordmark:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
  body:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  body-panel:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1
  tile-title:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.2
  tile-caption:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.2
  status:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1
    fontFeature: "\"tnum\" 1"
  command:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  terminal:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.15
rounded:
  dot: "2px"
  kbd: "3px"
  key: "4px"
  control: "5px"
  tile: "6px"
  frame: "8px"
spacing:
  hairline: "4px"
  gap: "8px"
  snug: "12px"
  tile-pad: "14px"
  base: "16px"
  block: "24px"
  page: "32px"
  section: "40px"
  column-gap: "56px"
  chapter: "96px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.tile}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-primary-large:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.tile}"
    padding: "14px 24px"
  button-quiet:
    backgroundColor: "{colors.tile-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.tile}"
    padding: "10px 16px"
  button-quiet-hover:
    backgroundColor: "{colors.tile}"
  button-small:
    rounded: "{rounded.tile}"
    padding: "6px 10px"
  button-danger:
    backgroundColor: "{colors.err}"
    textColor: "#ffffff"
    rounded: "{rounded.tile}"
    padding: "10px 16px"
  tile:
    backgroundColor: "{colors.tile}"
    textColor: "{colors.ink}"
    rounded: "{rounded.tile}"
  tile-head:
    textColor: "{colors.ink-2}"
    typography: "{typography.tile-caption}"
    height: "32px"
    padding: "0 8px 0 12px"
  status-bar:
    backgroundColor: "{colors.bar}"
    textColor: "{colors.bar-ink}"
    typography: "{typography.status}"
    height: "40px"
    padding: "4px 6px 4px 12px"
  bar-button:
    backgroundColor: "{colors.bar-2}"
    textColor: "{colors.bar-ink}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  bar-button-expanded:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
  network-module:
    backgroundColor: "transparent"
    textColor: "{colors.bar-ink}"
    typography: "{typography.status}"
    rounded: "0"
    padding: "6px 12px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    padding: "11px 9px 10px"
  tab-selected:
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.tile-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  option-card:
    backgroundColor: "{colors.tile-2}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  option-card-selected:
    backgroundColor: "{colors.accent-wash}"
  command-row:
    backgroundColor: "{colors.term}"
    textColor: "{colors.ink}"
    typography: "{typography.command}"
    rounded: "{rounded.key}"
    padding: "5px 5px 5px 10px"
  step-mark:
    backgroundColor: "{colors.tile-2}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.key}"
    size: "26px"
  step-mark-done:
    backgroundColor: "{colors.ok}"
    textColor: "{colors.tile}"
  offers-frame:
    backgroundColor: "{colors.bar}"
    rounded: "{rounded.frame}"
    padding: "8px"
  offer-tile:
    backgroundColor: "{colors.tile}"
    textColor: "{colors.ink}"
    rounded: "{rounded.tile}"
    padding: "16px 18px 18px"
  touch-key:
    backgroundColor: "{colors.bar-2}"
    textColor: "{colors.bar-ink}"
    rounded: "{rounded.control}"
    height: "44px"
    width: "44px"
  touch-key-pressed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
---

# Design System: xiaonux

## Overview

**Creative North Star: "The Tiling Workstation"**

xiaonux is a tiled Linux workstation set up the way Linux people set up their own: an i3 or sway desktop with gapped tiles on a ground, a thin status bar across the top, and nothing floating that does not have to. In dark mode the ground is deep teal and the tiles are a lifted teal; in light mode the ground is sand and the tiles are paper. The status bar is near-black teal in both modes, and the start page opens with the same bar the machine wears, so the page and the machine read as one setup.

Colour does a job; it is not there for mood. Sand-coloured text, teal surfaces, and one ochre that appears in three places only: on what you can press, on the next guide step, and on the tile that holds the keyboard. Sage means done or connected, coral means an error. Everything else is ground, tile, line and ink. The terminal is the product, so the terminal tile takes the room and the guide column can close.

The world turns down two category defaults. One is the fake desktop with draggable, overlapping windows. The other is the near-black page with one neon accent and a terminal floating in a window chrome. Here tiles sit side by side with the ground showing in the gaps, and a tile head is a plain mono title line, the way a tiling window manager draws it.

**Key Characteristics:**
- Gapped tiling: tiles separated by an 8px gutter of ground, framed by a 1px line, 6px corners.
- A thin near-black teal status bar in both colour schemes, with status, network module, MIPS and actions laid out as bar modules divided by vertical lines.
- Ochre restricted to pressables, the next guide step, and the focused tile's frame.
- Mono for the machine's voice (status bar, tile heads, data labels, commands, terminal); system sans for prose and titles.
- Flat tiles; one shadow, reserved for layers that float over the work.
- Light and dark from the same role tokens via `prefers-color-scheme`, with the xterm palette kept in step.

## Colors

Sand and teal neutrals, one ochre, sage for done, coral for errors, and a near-black teal bar shared by both schemes. Dark-mode values sit under the `-dark` keys; `accent`, `on-accent`, `bar-ink` and `bar-ink-2` are the same in both schemes.

### Primary
- **Workstation Ochre** (`accent`): fill of primary buttons, the expanded Guide bar button and pressed touch keys; the hover fill of quiet buttons in the guide list; the selected tab's underline; the checked network option's border; the keyboard focus ring and the frame of the focused tile in dark (light uses `focus` #a5650a, which holds 3:1 on sand); the "Type it" button on the next guide step; the logo tile. `accent-hover` lifts it on hover, `on-accent` is the near-black brown text on an ochre fill, and `accent-wash` is the pale (light) or olive-dark (dark) fill under a checked option card.
- **Ochre Ink** (`link`): ochre as text. A deep amber-brown in light mode so links read on paper; the lifted ochre in dark mode.

### Secondary
- **Sage** (`ok`): a finished guide step's filled mark, a started guide's progress line, a completed transfer meter, connected network status, the "Isolated" ledger marker.
- **Coral** (`err`): the danger button, the reset dialog's frame, a failed transfer's border, blocked network status.

### Tertiary
- **Amber Warning** (`warn`): the "Not isolated" ledger marker. Used once; do not spread it.

### Neutral
- **Ground** (`ground`): what shows between tiles. Sand in light mode, deep teal in dark mode. Page ground of the start view, the workspace and the Licenses page.
- **Tile** (`tile`): the surface of every tile, popover, dialog, toast and consent card.
- **Tile Inset** (`tile-2`): controls and insets sitting inside a tile: quiet buttons, inputs, option cards, file rows, step marks, kbd caps, the hovered list row.
- **Terminal Paper** (`term`): the terminal's own ground and the command rows that quote it.
- **Ink** (`ink`) and **Soft Ink** (`ink-2`): primary text; secondary text, tile captions, unselected tabs, row numbers. Teal-black in light mode, sand in dark mode.
- **Line** (`line`) and **Strong Line** (`line-strong`): 1px tile borders and row dividers; section rules, kbd caps, step-mark rings, scrollbar thumbs, the hover border of inputs.
- **Status Bar** (`bar`, `bar-2`, `bar-line`, `bar-ink`, `bar-ink-2`): the bar's ground, its button and hover fill, its module dividers, its text and its secondary readouts. The services offer's frame also uses `bar`.

The terminal palette (xterm `THEMES` in `web/src/main.ts`) follows the roles: background `term`, foreground `ink`, red `err`, green `ok`, yellow `warn` (light) or `accent` (dark). The dark cursor is `accent`; the light cursor is a deeper ochre so it reads on paper.

### Named Rules
**The Three Places Rule.** Ochre goes on things you can press, on the next guide step, and on the tile that has focus. A heading, a divider, a decoration or a resting status is never ochre.

**The One Bar Rule.** The status bar is near-black teal in both schemes, and the start page's head is the same bar. Its lamps are fixed values tuned for the dark bar, not the page's role colours.

**The Sage and Coral Rule.** Sage marks something done or connected; coral marks an error or a block. Neither is used for emphasis.

## Typography

**Display Font:** system-ui stack (`--sans`)
**Body Font:** system-ui stack (`--sans`)
**Label/Mono Font:** ui-monospace stack (`--mono`) for the status bar, tile heads, data labels, commands and the terminal

**Character:** One native sans in heavy weights and tight tracking for the few large lines, regular weight for reading, semibold for buttons. Mono is the workstation's voice: lowercase tile titles, bar readouts and key/value labels set in it read like a window manager's chrome. No web fonts; the first prompt's load time matters more than a custom face.

### Hierarchy
- **Display** (760, clamp(36px, 4.8vw, 60px), 1.03, -0.035em): the start view's single headline, max 14ch (16ch when stacked).
- **Headline** (700, 22px, 1.2, -0.015em): document section titles in the start view's label column. The Licenses page title runs clamp(30px, 4vw, 44px) at -0.03em.
- **Title** (700, 18px, 1.3, -0.01em): guide rows in the start view's guides tile and the reset dialog. Drawer panel heads 17px; offer tiles 650 16px; group heads 600 17px; list item heads 600 15px.
- **Body** (400, 15px, 1.5): page default. Lede 18px in `ink-2`, max 44ch (16px at phone width); section body 15px/1.55 at max 64ch; drawer panel and tile text 14px in `ink-2`.
- **Label** (600, 14px, 1): buttons. Large buttons 16px, small 12.5px; bar buttons 600 12.5px.
- **Tile title / caption** (mono 600 12.5px and mono 12px, 1.2): the tile head's bold title and its caption; lowercase. The same 12px mono labels the facts row, field labels, the network legend and table heads.
- **Status** (mono 12.5px, 1, tabular): everything on the status bar except the wordmark and bar buttons.
- **Command** (mono 12.5px, 1.45): command rows; inline `code` at 0.88em; the download path field at 13.5px.
- **Terminal** (mono 14px, 1.15): xterm.

### Named Rules
**The Machine Speaks Mono Rule.** Mono is for what the machine shows or what you type: the status bar, tile heads, data labels, package names, commands, the terminal. Prose, headings and buttons stay in the sans.

**The Fixed Cell Rule.** Changing numbers (status, MIPS, timings, step numbers, transfer progress) use tabular numerals, and the bar reserves their width (status 16ch, MIPS 10ch) so updates never move a neighbour.

## Layout

Everything is a tiling. Tiles sit on the ground with an 8px gap (`--gap`) between them and around the edge; they never overlap and never touch.

**Workspace:** full viewport height (`100dvh`). A 40px status bar across the top: wordmark (logo tile and name, the Home link), status cell, network module, spacer, MIPS readout, then Upload, Download, Reset and Guide buttons. Under it, an 8px-padded work area holds the terminal tile on the left and the right column on the right. The column is 440px (max 38vw) and animates its width open and closed over 280ms. It stacks the guide tile (tabs: guides, network, safety) over a dismissible services tile, with an 8px gap between them. Below 960px the column overlays the terminal from the right (full width up to 440px) with the floating shadow, and the MIPS readout hides. Below 640px the work area's gap drops to 4px, the terminal's tile head hides, the wordmark shrinks to its logo tile, bar buttons go icon-only, and the status cell ellipsises. On coarse pointers a row of 44px touch keys sits under the work area on bar colours, its right edge faded to show it scrolls.

**Start view:** a centred column, max 1160px, padded 16px top and 32px sides. The cover opens with the status bar as the page head (wordmark with its ochre square, then section anchors, GitHub, the safety link and the language picker). Below it, a two-column grid (1fr / 1fr, 56px gap, vertically centred, padded clamp(48px, 10vh, 104px) above and 56px below) holds the headline, lede and Start action on the left and the guides tile on the right. A row of four fact tiles follows (four, then two below 860px, then one below 480px). Document sections follow, each a 220px label column (sticky from 960px) beside the content, opened by a 1px `line-strong` rule and spaced 96px apart (64px at 640px and below): package tiles in an auto-fit grid (min 210px), use-case rows with their commands, nested tiles for how it works beside ruled notes, a two-column safety ledger, the services offer as a gapped 2x2 tiling inside a dark `bar` frame (one column below 640px), and the closing Start action. Below 860px the label column and the hero stack; below 640px side padding drops to 12px and large buttons go full width.

**Document view (Licenses):** centred column, max 1040px, padded 24px 32px; 48px between groups; tables in a bordered tile that scrolls sideways, turning into stacked rows below 640px.

**Rhythm:** 4, 8, 12, 14, 16, 24, 32, 40, 56 and 96px carry the layout. Tile insets are 12 to 18px; list rows inside tiles run 6 to 18px vertical padding by density.

### Named Rules
**The Gapped Tiling Rule.** Neighbouring tiles are separated by the 8px ground gap, never by a shared border and never by overlap. A group of tiles that belongs together sits inside a frame of `bar` with the same 8px padding.

## Elevation & Depth

Flat. Depth comes from the tone step between ground, tile and tile inset, and from 1px lines. One shadow exists, for layers that float over the work and go away: the transfer toast, the download popover, the reset dialog, the consent card and the overlay column at narrow widths.

### Shadow Vocabulary
- **Floating layer** (`--shadow`: light `0 10px 30px -10px rgba(15, 35, 40, 0.35), 0 2px 6px rgba(15, 35, 40, 0.12)`; dark `0 14px 36px -10px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4)`): only on layers above the tiling. The reset dialog's backdrop is `rgba(6, 16, 18, 0.55)`.

### Named Rules
**The Tiles Don't Float Rule.** Resting tiles get a line border and no shadow. A shadow means "this sits on top and will leave".

## Shapes

Square-ish, softened just enough for touch. Tiles, buttons, popover and dialog share a 6px corner; the services frame is 8px so it wraps its tiles evenly. Small controls step down: 5px for bar buttons, inputs, option cards, file rows, touch keys and the language picker; 4px for command rows, step marks, nav links and the close button; 3px for kbd caps. Status dots, ledger markers and the wordmark's square are 2px-cornered squares; there are no pills and no circles. Lines do the structure: 1px `line` tile borders and dividers, 1px `line-strong` section rules, 2px tab underlines, and 2px borders on workspace tiles so the focus frame changes colour without shifting the layout. Icons are inline 16px SVG strokes (1.8 width, round caps and joins); the logo is an ochre rounded square holding a `>_` prompt stroked in `on-accent`.

## Components

### Buttons
Solid and plain: a filled block or an inset block, no gradients, no lift.
- **Shape:** 6px corners.
- **Primary:** `accent` fill, `on-accent` text, 600 14px, 10px 16px. Large (Start Linux, Email) 16px at 14px 24px; small (Contact) 12.5px at 6px 10px.
- **Hover / Focus:** fill lifts to `accent-hover` over 160ms on the system ease (`cubic-bezier(0.16, 1, 0.3, 1)`). Focus is a 2px `accent` outline offset 2px. Disabled drops to 55% opacity with a progress cursor.
- **Quiet:** `tile-2` fill, `ink` text, 1px `line` border; hover moves the border to `accent` and the fill to `tile`. In the guides tile, hover fills it fully with `accent`.
- **Danger:** `err` fill, white text (near-black in dark mode); hover darkens with `brightness(0.92)`. Only in the reset dialog.

### Chips
- **Network module:** not a pill; a bar module divided from its neighbours by a 1px `bar-line` left border, mono 12.5px `bar-ink`, 6px 12px, with an 8px square lamp. The lamp is `bar-ink-2` when off and a fixed bar lamp when on (sage), waiting (ochre) or blocked (coral). Hover fills `bar-2`.

### Cards / Containers
- **The tile:** the one container of this world. `tile` fill, 1px `line` border (2px in the workspace), 6px corners, no shadow.
- **Tile head:** a 32px mono title line over a 1px `line` divider: bold 12.5px `ink` title, then a 12px `ink-2` caption that ellipsises, both lowercase. The terminal tile's head reads "terminal · bash · Debian 13 · riscv64"; the services tile's head carries a 26px close button.
- **Internal padding:** 10px 14px for fact tiles, 12px 14px for nested layers and the toast, 16px 18px for offer tiles, 16px for drawer panels and the popover, 20px for the dialog.
- **Nested tiles:** the how-it-works diagram nests tiles 12px deep, alternating `tile` and `tile-2`.

### Inputs / Fields
- **Style:** `tile-2` fill, 1px `line` border, 5px corners, 500 14px sans (the path field in mono 13.5px), 8px 10px.
- **Hover / Focus:** border turns `line-strong` on hover; keyboard focus is the global 2px `focus` ring (`#a5650a` light, `#e3a43b` dark).
- **Labels:** stacked above, 12px mono `ink-2`, 6px gap.
- **Option cards (radio):** the whole card is the label; hover moves the border to `line-strong`; checked moves it to `accent` with an `accent-wash` fill; native radios take `accent-color: accent`.

### Navigation
- **Status bar:** `bar` fill, 40px min height, 1px `bar-line` bottom edge, mono 12.5px. Modules (status, network, MIPS) are divided by 1px `bar-line` verticals. Bar buttons sit on `bar-2` with a `bar-line` border and 5px corners; hover lifts the border to `line-strong`; the expanded Guide button fills `accent`.
- **Start page head:** the same bar as a 44px rounded strip; the wordmark's 12px ochre square stands in for the logo; links are plain `bar-ink` with a `bar-2` hover fill.
- **Drawer tabs:** mono 600 12.5px, lowercase, `ink-2`, 2px transparent underline; hover goes to `ink`; selected is `ink` with an `accent` underline sitting on the tab row's 1px line.
- **Keyboard:** Tab stays in the shell; Ctrl+Shift+G moves focus between the terminal and the guide tile (key chip on the terminal tile head and a hint under the steps, both hidden on touch).

### Focused Tile (signature)
Whichever workspace tile holds the keyboard wears the ochre frame. Workspace tiles (terminal, guide, services) carry a 2px `line` border; when focus is inside one, that border turns `focus` over 160ms (deep ochre `#a5650a` in light so it reads at 3:1 on sand; `#e3a43b` in dark). Ctrl+Shift+G moves the frame between the terminal and the guide. Only one tile has it at a time, and nothing else in the workspace draws an ochre outline at rest.

### Guide Steps (signature)
Each step is a 30px mark column beside its body, divided by `line`. The mark is a 26px square tile-inset with a 1px `line-strong` ring and a 4px corner, holding the step number in mono 600 12px. When the step's command has run, the mark fills `ok`, the number fades out, and a check strokes in over 420ms in the tile colour. Finished steps stay; their text drops to `ink-2`. Under the text, a command row on `term` (1px `line`, 4px corners, mono 12.5px) with a small "Type it" button. Only the next step to run has an ochre "Type it"; the rest are quiet until hovered.

### Services Tiling
On the start page the offer is a 2x2 tiling of `tile` tiles inside an 8px-padded `bar` frame with 8px corners, followed by a large primary Email button. In the workspace it shrinks to a dismissible services tile under the guide, with the address in mono and a small primary Contact button.

### Transfer Toast
Bottom-centred over the terminal: a `tile` with a `line-strong` border and the floating shadow, rising 8px over 260ms. A 4px meter on a `line` track fills `accent` while moving and `ok` when done; an error replaces the meter with an `err` border.

## Do's and Don'ts

### Do:
- **Do** keep ochre to pressables, the next guide step and the focused tile's frame.
- **Do** separate tiles with the 8px ground gap, and group related tiles inside a `bar` frame padded by the same gap.
- **Do** give workspace tiles a 2px border so the focus frame swaps colour without moving anything.
- **Do** open every tile that names itself with a 32px mono, lowercase tile head.
- **Do** keep the status bar near-black teal in both schemes, and use its modules (divided by `bar-line` verticals) for live readouts.
- **Do** put changing numbers in fixed-width cells with tabular numerals.
- **Do** keep finished guide steps visible and filled sage.
- **Do** derive every dark-mode value from the same role and keep the xterm palette in step with the role tokens.
- **Do** honour `prefers-reduced-motion` by collapsing animations and transitions to 1ms.
- **Do** keep touch keys at 44px.

### Don't:
- **Don't** build a fake desktop: no draggable, overlapping or title-barred windows.
- **Don't** drop the ground to neutral black or swap ochre for a saturated neon.
- **Don't** use ochre on headings, section rules, dividers, resting decorations or non-pressable hover states.
- **Don't** put shadows on resting tiles; the floating-layer shadow is for toast, popover, dialog, consent card and the overlay column only.
- **Don't** use pills or circles; corners stay between 2px and 8px.
- **Don't** use text glyphs as icons; icons are inline SVG strokes.
- **Don't** load web fonts.
- **Don't** set prose, headings or buttons in mono.
