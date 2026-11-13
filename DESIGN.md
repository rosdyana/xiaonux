---
name: xiaonux
description: Real Debian Linux in the browser tab, set out as a lab worksheet beside the machine.
colors:
  paper: "#f6f8fb"
  sheet: "#fdfeff"
  ink: "#1b2430"
  ink-2: "#4c5866"
  rule: "#d3e0f0"
  rule-strong: "#b3c8e4"
  blue: "#1d4f91"
  blue-hover: "#163f75"
  blue-wash: "#e6eef9"
  on-blue: "#ffffff"
  bar: "#1d4f91"
  bar-ink: "#e8f0fb"
  bar-ink-2: "#b7cbe6"
  pen: "#c8302b"
  margin: "#efb9c0"
  ok: "#1d7438"
  paper-dark: "#0a1018"
  sheet-dark: "#0c131c"
  ink-dark: "#dbe3ec"
  ink-2-dark: "#9aa8b8"
  rule-dark: "#1c2b3e"
  rule-strong-dark: "#2a4060"
  blue-dark: "#7fb0f0"
  blue-hover-dark: "#a2c7f6"
  blue-wash-dark: "#13243a"
  on-blue-dark: "#08111c"
  bar-dark: "#132c50"
  bar-ink-dark: "#e3ecf8"
  bar-ink-2-dark: "#9db6d6"
  pen-dark: "#ff7a6e"
  margin-dark: "#4a2a35"
  ok-dark: "#6fcf8a"
typography:
  display:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "clamp(34px, 4.6vw, 56px)"
    fontWeight: 750
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "clamp(30px, 4vw, 44px)"
    fontWeight: 700
    letterSpacing: "-0.03em"
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  wordmark:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "19px"
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
    fontSize: "13px"
    fontWeight: 600
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
  sheet: "2px"
  key: "3px"
  control: "6px"
  pill: "999px"
  mark: "50%"
spacing:
  hairline: "4px"
  tight: "8px"
  snug: "12px"
  base: "16px"
  row: "20px"
  block: "24px"
  page: "32px"
  section: "40px"
  column-gap: "56px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.on-blue}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.blue-hover}"
  button-primary-large:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.control}"
    padding: "15px 28px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.blue}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-quiet-hover:
    backgroundColor: "{colors.blue-wash}"
  button-quiet-small:
    textColor: "{colors.blue}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  bar:
    backgroundColor: "{colors.bar}"
    textColor: "{colors.bar-ink}"
    height: "48px"
    padding: "6px 10px 6px 16px"
  bar-button:
    backgroundColor: "transparent"
    textColor: "{colors.bar-ink}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  network-chip:
    textColor: "{colors.bar-ink}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    padding: "10px 10px 11px"
  tab-selected:
    textColor: "{colors.blue}"
  worksheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
  worksheet-row:
    padding: "20px 24px 20px 0"
  step-mark:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.mark}"
    size: "28px"
  command-row:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.command}"
    rounded: "{rounded.control}"
    padding: "6px 6px 6px 10px"
  option-card:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  option-card-selected:
    backgroundColor: "{colors.blue-wash}"
  touch-key:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "44px"
    width: "44px"
---

# Design System: xiaonux

## Overview

**Creative North Star: "The Lab Worksheet Beside the Machine"**

xiaonux looks like a university lab session: a terminal that fills the room, and a printed worksheet beside it. The ground is bond-white paper, the shell is bound in cover-stock blue, text is graphite, worksheet rows sit on faint blue ruling with their numbers in a printed margin, and the only red on the page is the teacher's pen marking what has happened. Dark mode is the same sheet in blue-black ink wash, with the blue and the red lifted rather than swapped for new hues.

The system is quiet and dense in the way working documents are dense. Colour carries meaning, not mood: blue means "you can press this" (plus the top bar that frames the machine), red means "a state was marked", green means "done/connected". Everything else is paper, ink and ruling. The terminal is the product, so the shell gets the room and the worksheet lives in a drawer that can close.

The world refuses the category default for in-browser Linux: a black page with a neon accent and a terminal floating in a fake window. Here the terminal is the surface itself, edge to edge under the bar, on the same sheet colour as the worksheet.

**Key Characteristics:**
- Paper ground, sheet surfaces, graphite ink, blue ruling lines instead of boxes and shadows.
- Cover-stock blue on the top bar and on pressable things only.
- Red pen reserved for state marks: hand-drawn checks, guide progress, errors and blocked states.
- A pale printed margin rule separating row numbers from row text.
- System sans for everything; monospace only for commands, paths and the terminal.
- Status readouts in fixed-width cells with tabular numerals, so changing numbers never move the layout.
- Light and dark from the same role tokens via `prefers-color-scheme`.

## Colors

A paper-and-ink neutral set, one pressable blue, one red pen, one done-green, and a pale pink margin rule; each role has a lifted dark-mode counterpart (the `-dark` keys).

### Primary
- **Cover-Stock Blue** (`blue`): fill of primary buttons, text and border of quiet buttons, links, the selected tab and its underline, selected network option border, the keyboard focus ring, the terminal cursor, pressed touch keys. `blue-hover` deepens it on hover (lightens it in dark mode); `blue-wash` is its pale tint for hover and selected backgrounds; `on-blue` is text on a blue fill.
- **Shell Binding** (`bar`): the workspace top bar. Same blue as `blue` in light mode, a deeper navy in dark so the bar stays a frame rather than a lamp. Text on it uses `bar-ink` (primary) and `bar-ink-2` (secondary readouts).

### Secondary
- **Teacher's Red Pen** (`pen`): the hand-drawn check on a finished step, the check that replaces a started guide's margin number, the "n of m done" progress line, the border of a failed transfer, and blocked network status. Nothing decorative.
- **Done Green** (`ok`): a finished transfer meter and "connected" network status.

### Tertiary
- **Printed Margin** (`margin`): the 1px vertical margin rule between the row numbers and the row text on the start-view worksheet. A pale tint distinct from `pen` so the margin reads as printed, not marked.

### Neutral
- **Bond Paper** (`paper`): page ground of the start view and Licenses page, the drawer background, the touch-key row.
- **Sheet** (`sheet`): the worksheet card, the terminal and workspace surface, inputs, command rows, option cards, popovers.
- **Graphite** (`ink`): primary text and headings.
- **Soft Graphite** (`ink-2`): secondary text, descriptions, row numbers, unselected tabs, captions.
- **Blue Ruling** (`rule`): 1px row dividers, card and panel borders, meter track.
- **Strong Ruling** (`rule-strong`): the 2px rule under a sheet header, input and quiet-button borders, step-mark rings, key caps, scrollbar thumbs.

The terminal palette (xterm `THEMES` in `web/src/main.ts`) is derived from these roles: background `sheet`, foreground `ink`, cursor `blue`, bright red `pen`, green `ok`, blue `blue`; ANSI colours not in the system are tuned to sit on the same sheet.

### Named Rules
**The Pressable Blue Rule.** Blue fills and blue text belong to the top bar and to things you can press (buttons, links, tabs, selected options, focus). A heading or a decoration is never blue.

**The Red Pen Rule.** `pen` marks state that has happened: a check, progress, an error, a block. If nothing changed, nothing is red.

**The Printed Margin Rule.** The margin line is `margin`, never `pen`. Printed furniture and teacher's marks stay different colours.

## Typography

**Display Font:** system-ui stack (`--sans`)
**Body Font:** system-ui stack (`--sans`)
**Label/Mono Font:** ui-monospace stack (`--mono`) for commands, paths, code and the terminal only

**Character:** One native sans in heavy weights and tight tracking for the few large lines, regular weight for reading, semibold for labels. No web fonts: the first prompt's load time is a product feature, so type identity comes from weight, size and tracking rather than a downloaded face.

### Hierarchy
- **Display** (750, clamp(34px, 4.6vw, 56px), 1.05, -0.03em): the start view's single value line, max 14ch (16ch when stacked).
- **Headline** (700, clamp(30px, 4vw, 44px), -0.03em): document page titles (Licenses). Section heads in documents run 21px, -0.01em.
- **Title** (700, 19px, 1.3, -0.01em): worksheet row titles; drawer panel heads at 18px, sub-heads at 15.5px.
- **Body** (400, 15px, 1.5): page default. Lede 18px (16px at phone width) in `ink-2`, max 44ch; drawer panel text 14px in `ink-2`; reading measure 46 to 70ch.
- **Label** (600, 13 to 14px, line-height 1): buttons, tabs, field labels, sheet header, row numbers. Sentence case; no uppercase tracking.
- **Command** (mono, 12.5 to 13.5px, 1.45): guide commands, the download path field, inline `code` at 0.88em.
- **Terminal** (mono, 14px, 1.15): xterm.

### Named Rules
**The Mono Means Machine Rule.** Monospace appears only where text is something you type or the machine prints: commands, paths, code, the terminal.

**The Fixed Cell Rule.** Changing numbers (status, MIPS, timings, row numbers, counts) use tabular numerals and a reserved min-width, so updates never shift neighbours.

## Layout

Two modes share one sheet.

**Start view:** a centred column, max 1120px, padded 24/32px. A head row (wordmark left, two links right), then a two-column grid (1.05fr / 1fr, 56px gap, vertically centred): value line, lede and Start action on the left, the three-row worksheet on the right. A facts row under a 1px rule, then a footer of links. Below 860px the grid stacks (32px gap); below 640px padding drops to 16px, the Start button goes full width, and the worksheet's margin narrows (numbers column 28px, margin rule at 41px).

**Workspace:** full viewport height (`100dvh`). A 48px blue bar; under it the terminal fills everything left of the drawer. The drawer is 420px (max 38vw) and animates its width open/closed. Below 960px the drawer overlays the terminal from the right (full width up to 420px) with the floating shadow, and the MIPS readout hides. Below 640px the bar shrinks the wordmark to its logo tile and drops button labels (icons only), and the status cell ellipsises. The wordmark is the Home link everywhere: in the workspace it returns to the start view through a `#machine` history entry (the browser's Back does the same), the machine keeps running, and the start view's Start button becomes "Return to Linux". The language picker lives in the start head, the drawer's tab row, and the Licenses head, never in the bar. On coarse pointers a 44px touch-key row appears under the terminal, its right edge faded to show it scrolls.

**Document view (Licenses):** centred column, max 1040px, same head row as the start view, generous section spacing (48px between groups), tables in a bordered scroll wrapper.

**Rhythm:** spacing comes from a small set of steps (4, 8, 12, 16, 20, 24, 32, 40, 56px). Worksheet rows are 20px tall-padded; drawer steps 12px.

## Elevation & Depth

Flat by default. Depth comes from paper tone (`paper` under `sheet`) and ruling, not shadows. One soft shadow exists and it is reserved for layers that float over the work: the download popover, the transfer toast, and the overlay drawer at narrow widths.

### Shadow Vocabulary
- **Floating layer** (`--shadow`: `0 6px 24px -8px rgba(20,40,70,0.28), 0 1px 3px rgba(20,40,70,0.12)`; dark `0 8px 28px -8px rgba(0,0,0,0.6), 0 1px 3px rgba(0,0,0,0.4)`): only on things that sit above the terminal temporarily.

### Named Rules
**The Paper Doesn't Float Rule.** Resting surfaces (worksheet, panels, cards, option cards) get a 1px rule border and no shadow. A shadow means "this is on top and will go away".

## Shapes

Mostly square, softened just enough for touch. Controls (buttons, inputs, command rows, option cards, popover, touch keys) share a 6px radius. The worksheet itself is a 2px sheet: nearly square, like paper. Pills (999px) are reserved for the network chip on the bar; circles for step marks and status dots. Lines do the structural work: 1px `rule` dividers, a 2px `rule-strong` rule under sheet headers, 2px tab underlines. Icons are inline 18px SVG strokes (1.7 width, round caps); the check mark is a hand-drawn stroke path.

## Components

### Buttons
Plain and firm: a solid block or a ruled outline, no gradients, no lift.
- **Shape:** gently rounded (6px).
- **Primary:** `blue` fill, `on-blue` text, 600 14px, 10px 16px. Large (Start Linux) is 17px, 15px 28px.
- **Hover / Focus:** fill deepens to `blue-hover` over 160ms on the system ease; focus is a 2px `blue` outline offset 2px (on the bar, `bar-ink`). Disabled drops to 55% opacity with a progress cursor.
- **Quiet:** transparent, `blue` text, `rule-strong` border; hover fills `blue-wash` and the border turns `blue`. Used for "Try it", Cancel, and (small, 13px, 6px 10px) "Type it" on guide commands.

### Chips
- **Network chip:** a pill on the bar, white at 8% fill with a 22% white border, 500 13px `bar-ink`, with an 8px status dot. Dot is `bar-ink-2` when off; signal-lamp green, amber, or coral (fixed values tuned for the dark bar) for on, waiting and blocked.

### Cards / Containers
- **Corner Style:** 6px for controls-as-cards; 2px for the worksheet.
- **Background:** `sheet` on `paper`.
- **Shadow Strategy:** none at rest (see Elevation).
- **Border:** 1px `rule`; `rule-strong` where the card is "mine" or interactive.
- **Internal Padding:** 10px 12px for list and option cards; 12px 14px for the transfer toast; 16px for the popover.

### Inputs / Fields
- **Style:** `sheet` fill, 1px `rule-strong` border, 6px radius, 500 14px (path field in mono 13.5px), 8px 10px.
- **Focus:** border turns `blue` on hover; keyboard focus is the global 2px `blue` ring.
- **Labels:** stacked above, 600 13px `ink-2`, 6px gap.
- **Option cards (radio):** whole card is the label; checked card gets a `blue` border and `blue-wash` fill; native radios tinted with `accent-color: blue`.

### Navigation
- **Reset dialog:** a modal `<dialog>` on `sheet` with the title underlined in `pen`; "Keep my files" (quiet, focused first) and "Delete my files" (`pen` fill). Escape keeps. Reset also clears guide checks.
- **Terminal focus:** Tab stays in the shell; Ctrl+Shift+G moves focus between the terminal and the drawer (hint under the Guide picker, hidden on touch).
- **Top bar:** `bar` fill, 48px min height; wordmark (logo tile + name, a Home link), live status cell, network chip, spacer, MIPS readout, then icon+label bar buttons (Upload, Download, Reset, Guide). Bar buttons are transparent, hover white 12%, expanded state white 16% with a faint border.
- **Drawer tabs:** 600 13.5px `ink-2` text with a 2px transparent underline; selected is `blue` text and `blue` underline sitting on the 1px tab-row rule.
- **Page head:** wordmark (700 19px, `ink`) left, plain underlined links right.

### Worksheet (signature)
A `sheet` card with a header line (bold title left, `ink-2` caption right) over a 2px `rule-strong` rule, then numbered rows divided by 1px `rule`. Numbers sit in a 36px margin column, right-aligned in tabular 600 13px `ink-2`, separated from the text by the 1px `margin` line. When a guide has been started, its number is replaced by a red-pen check and a `pen` "n of m" progress line appears under the description.

### Guide Steps (signature)
Each step is a 32px mark column plus body, divided by `rule`. The mark is a 28px circle ringed in `rule-strong` holding the step number. When the step's command has run, the ring disappears, the number fades to 35%, and a red-pen check strokes in over 420ms (stroke-dashoffset), drawn slightly off-centre like a hand mark. Finished steps stay visible; their text drops to `ink-2`. Below the text, a command row: mono command on `sheet` in a `rule`-bordered 6px box with a small quiet "Type it" button.

### Transfer Toast
Bottom-centred over the terminal, `sheet` with `rule-strong` border and the floating shadow, rises 8px in over 260ms. A 4px meter on a `rule` track fills `blue` while moving, `ok` when done; an error swaps the meter for a `pen` border.

## Do's and Don'ts

### Do:
- **Do** keep blue for the top bar and pressable things: buttons, links, tabs, selected options, focus rings.
- **Do** use `pen` only for marks of state: checks, progress, errors, blocked.
- **Do** separate surfaces with 1px `rule` lines and the `paper`/`sheet` tone step before reaching for anything else.
- **Do** keep finished steps visible and checked; completed work never disappears.
- **Do** put changing numbers in fixed-width cells with tabular numerals.
- **Do** derive every dark-mode value from the same role (lift blue and pen; ink-wash ground), and keep the xterm palette in step with the role tokens.
- **Do** honour `prefers-reduced-motion` by collapsing animations and transitions to 1ms.
- **Do** keep touch targets at 44px on the touch-key row.

### Don't:
- **Don't** make the product a black page with a neon accent and a terminal in a floating window.
- **Don't** colour headings or decorations blue to add emphasis.
- **Don't** use `pen` red for decoration, emphasis or the printed margin.
- **Don't** put shadows on resting surfaces; the floating-layer shadow is for popover, toast and overlay drawer only.
- **Don't** load web fonts; the first prompt's load time outranks a custom face.
- **Don't** set prose, labels or headings in monospace.
