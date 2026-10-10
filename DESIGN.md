# Design: chen-er viewer

World: **an engineering notebook page.** The diagram is drawn on a gridded notebook sheet; the reviewer's
findings are pencil notes in the margin, numbered and keyed to marks on the drawing. Exporting tears out a clean
textbook figure: grid, notes, marks and selection never reach the SVG/PNG.

Mode: Operate. The diagram and the findings are the task; chrome stays quiet. Used as a narrow side window next to
an agent's terminal and full screen for polishing, equally.

## Physical scene
A student at a desk under ordinary room light, laptop next to the course book, a terminal on the left half of
the screen. The entire canvas is endless engineering graph paper, including the space around the figure. In
dark mode only the header and menus become a dark desk; the canvas stays paper because the figure is black
ink on white and must look the same as the export. Four graphite corner marks show where the export ends.

## Color (Restrained: neutrals + pencil roles)
- Canvas paper `#FBFBF8`; grid minor `#E7ECEF` every 8 diagram px, major `#D5DDE2` every 40 diagram px
  (screen only). Lines stay 1 CSS px and follow the drawing through pan and zoom; their opacity matches the
  ink of a 0.5px (minor) / 0.7px (major) stroke at the current zoom (0.5 × zoom, 0.7 × zoom, capped at 1), so the
  paper reads as faint as the scaled sheet grid did. Minor lines also fade out from 50% to 35% zoom; major lines
  from 15% to 10%.
- Export corners: graphite `#6B7177` at 60% opacity, four L marks with 12 screen px arms and 1px strokes.
- Margin rule: one vertical line `#E4A9A4` separating sheet from the notes column (the notebook's red margin line).
- Ink `#1F2328` (diagram, primary text). Graphite `#6B7177` (secondary text, pins, guides).
- Finding roles, always paired with a glyph and a number, never color alone:
  error = red pencil `#C4362D` + ✕ in a circle; course = blue pencil `#2F5FA8` + △; heuristic = graphite `#6B7177` + ○;
  info = graphite light `#9AA1A7` + •.
- Selection/hover halo: graphite at 35% opacity, 6px outside the shape outline.
- Dark mode: header/menu desk `#14171A`, chrome text `#D7DCE0`, chrome rules `#2A3036`; the entire canvas
  keeps its light paper colors, with no dark surround at the figure bounds.

## Type
- Diagram: Inter (bundled; layout is measured against it). Never change the diagram font in the viewer.
- UI: `system-ui` stack, 13px base, 1.45 line height; numbers tabular (`font-variant-numeric: tabular-nums`).
- Code/YAML excerpts, file paths, zone/line refs: `ui-monospace` stack, 12px.
- Page header title: model title at 15px/600; nothing larger anywhere in the UI.

## Layout
- Header strip (44px): model title (15px/600) and file basename (12px mono graphite, full path in `title`);
  quiet quality summary and live status; joined Undo/Redo icons; Layout menu (Engine, Re-layout, Reset pins);
  ghost Fit; sun/moon theme icon; filled Export menu (SVG, PNG). Actions use 8px gaps within groups and 16px
  between groups. Status retains its live region and pencil underline.
- Endless paper canvas fills the rest; notes column (320px) right of the margin rule. The sheet is transparent;
  four thin corner marks in the overlay delimit its export bounds and retain their screen size at every zoom.
  Grid and corners never reach server-generated exports, which retain their plain white background.
- ≤ 900px wide: title takes at most 40% of the header; live status is an 8px dot and a short word with full text
  available to assistive technology and in `title`. Undo/Redo stay visible; Layout, theme and exports share one
  More menu. Fit remains in the zoom strip. Notes become a bottom drawer (initially 40–60% height to match
  the sheet aspect ratio, draggable): one sticky heading combines a centred 32×4px grab bar with the Notes | Requirements | Agent tabs (Agent only when enabled). The grab bar supports
  arrow-key resizing. First load fits the sheet with 12px canvas padding. Never horizontal page scroll.

## Components
- Finding card (margin note): 18px number circle + glyph + 12px/600 graphite severity word, ink message below,
  hint in graphite, "line 14" link (mono). Selected card expands to show the YAML excerpt (±3 lines, line
  numbers, target line marked with a pencil bar). Identity never depends on color alone.
- Drawing marks: small numbered circle (16px) at the element's top-right, same color/glyph as its card.
- Pin mark: 6px graphite tick at a pinned node's top-left; pinned nodes also get a dotted outline on hover.
- Buttons: 28px high, 4px radius, ghost at rest; hover uses 9% ink/chrome ink and active 14%. A visible focus
  ring remains for keyboard navigation. Outlined controls are reserved for the history pair, native engine
  select, paper textarea, Send, Apply to model and Undo agent change. History icons share one border with a 1px divider.
- Export is the only primary button: ink fill and sheet text on a light desk; sheet fill and ink text on a
  dark desk. Icons and menu chevrons are inline SVG, 24 viewBox, 1.5 stroke, round caps/joins, currentColor,
  rendered at 18–20px; native header disclosure markers are hidden.
- Layout, Export and More menus share full-width 28px rows without underlines, 4px radius, 1px chrome rule and
  a soft `0 6px 20px rgb(0 0 0 / .18)` shadow. Light menus are sheet-colored; dark menus use the desk. Engine
  is a labelled native `<select>`. Menus are keyboard reachable, close on Escape or outside click and return
  focus to their summary.
- Node toolbar: sheet panel with a 1px major-grid rule, 4px radius, the same soft shadow, 4px padding and 2px
  gaps. Name is 12px/600, at most 160px with ellipsis; Focus/Close are 28px ghost icons. Prefer 8px above the
  node and clamp to the canvas. Pointer selection has no browser ring; keyboard focus keeps a graphite ring
  alongside the selection halo.
- Zoom strip: ghost minus, current percentage, plus, a hairline divider and Fit-to-sheet icon. Percentage
  resets to 100% (`0`). One outer 1px graphite rule, sheet background, 4px radius and the same soft shadow.
- Agent empty state shows the working directory once as a quiet "Claude works in <basename>" sentence (the
  configured agent name is used; full path in `title`), followed by its explanation and "For example:" links.
  Composer keeps the paper textarea, with a 12px graphite key hint and outlined Send aligned to its right edge.

## Motion
- Live update: crossfade 120ms; the changed status chip gets a 600ms pencil-stroke underline. No other ambient motion.
- Drag: node follows pointer 1:1 with grid snap (8px; hold Alt to free-move); on drop the layout re-runs with pins.
- Respect `prefers-reduced-motion`: no crossfade, no underline animation.

## Never
- Colored or shadowed diagram shapes; gradients; glass; glowing edges; decorative illustrations.
- Grid, marks, halos or notes in exports.
- Color-only status; tooltips as the only way to read a finding.

## Selection and focus

Entity and relationship clicks open a small paper toolbar beside the selected shape with Focus and Close.
The toolbar stays near the selected shape and chooses a viewport-clamped position that avoids nearby labels, nodes and edge segments whenever space permits.
Connected relationships keep every end and role/cardinality label together; unrelated drawing elements dim.
Selection preserves the camera; Focus explicitly fits the neighborhood. Dragging hides actions and starts only
after 4 screen pixels. Enter opens node actions; Escape dismisses them. Attribute nodes retain movement and
unpin shortcuts. The viewer does not edit the model; it writes only the layout file.

Undo/Redo are session controls in the header and cover layout changes only (pins, reset, relayout, engine).
Computing, saved, conflict and failure states remain visible in the status strip.

## Agent panel

Only with `chen serve --agent` (contract: docs/agent-panel.md). Without it, `GET /api/agent` answers 404 and the
Agent tab is hidden; Notes and Requirements stay.

- **Tabs.** The notes column is a tablist, **Notes | Requirements | Agent**: plain words on the sheet, graphite when
  idle, ink 600 with a 2px ink underline when selected, one `--grid-major` rule under the row. Arrow keys, Home and End
  move between the visible tabs. Requirements carries `· applying` while an apply turn runs. The Agent tab carries a small graphite suffix: `· working` while a turn runs, `· new` when a
  turn finished while Notes was open. At ≤ 900px the tabs sit under the drawer handle, inside the drawer.
- **Thread as margin notes.** Each turn is a note separated by the same `--grid-major` rule as findings. The
  request is ink (500), with its time in mono graphite on the right and its context below in mono graphite
  (`▸ STUDENT  ▸ ENROLLS`). Everything the agent says is graphite: the reply, the folded tool steps (a
  `<details>` whose summary reads `3 steps`, steps in 12px mono), the running line `Claude is working… 12 s`
  with a Cancel button. No bubbles, avatars, fills, shadows or color blocks.
- **Change note.** A finished turn ends with one line per element: mono sign (`+` added, `~` changed, `-` removed)
  and the element name (`BirthDate (STUDENT)`). Added and changed names are links that select the element and fit
  its neighborhood on the drawing; removed names are graphite and struck through. **Undo agent change** (outlined
  28px button) appears only under the latest model-changing turn while its status is ok; after undo the note is
  struck through and reads "Undone. The model is back to how it was before this request."
- **Changed elements on the drawing.** After a turn finishes, the added and changed elements get the selection
  halo (graphite 35%, 6px outside the outline) for 3 s, holding then fading. With `prefers-reduced-motion` the halo
  is static and simply disappears after 3 s. It lives in the overlay, never in exports.
- **Composer.** Sticky at the bottom of the column on the sheet: context chips (`▸ BOOK ×`, 1px graphite rule,
  4px radius, 12px mono) showing the current canvas selection, a paper textarea with a 1px graphite rule, a
  graphite key hint and an outlined Send. × leaves the selection out of the request until something else is
  selected; the chips are sent as `selection` ids.
- **Empty state.** One sentence on what the panel does and three example requests as dotted-underline text
  links that fill the input.
- **Errors.** Error text uses the red pencil, always as a sentence that names the problem and the fix: CLI not
  found or not logged in (names the command and `/login`, or `codex login` for Codex), usage limit, a generic
  stop with the stderr excerpt in an `Error output` disclosure (12px mono, 1px graphite rule on the left). A
  request while one is running says "A request is already running." A request the server cancelled because it
  stopped mid-turn shows the server's notice in place of "Cancelled."
- **Keys.** `/` opens the Agent tab and focuses the input from anywhere outside a text field; Enter sends,
  Shift+Enter adds a line; Escape cancels a running turn while the Agent tab is open.

## Requirements tab

Contract: docs/requirements.md. Always present; Apply needs `chen serve --agent`.

- **Lines on ruled paper.** The tab opens with the file name (`club.er.requirements.md`, 12px mono graphite) and a
  quiet save word (`editing`, `saving…`, `saved`; red pencil when not saved). Each requirement is one numbered pencil
  line: `R1` in 12px mono graphite in a narrow gutter, the sentence in ink 13px directly on the paper, a 1px `--grid`
  rule under each line like ruled notebook paper. No boxes, cards, fills or shadows; the focused line gets a 1px
  graphite rule around the text (4px radius) as its focus mark. The last line is always empty, numbered faintly with
  the next R-number, placeholder "Next requirement" (the first one shows an example sentence).
- **State under each line**, 12px: `new` and `changed since the last apply` in graphite; `Claude is applying this
  line…` in ink while its turn runs. An applied line shows a mono graphite `→` and the implementing element names as
  ink links with graphite underlines (`COURSE, OFFERS, Title (COURSE)`); a link selects the element and fits its
  neighbourhood on the drawing, exactly like the agent change note. An element removed later is graphite and struck
  through. The rationale follows in graphite. A line nothing implements reads `△ not covered` in the red pencil, with
  the reason; the glyph and the words carry the meaning, never the colour alone.
- **Apply bar.** Sticky at the bottom of the column on the sheet, above a `--grid-major` rule: a graphite summary
  (`2 new · 1 changed`, `4 applied · 1 not covered`) and the outlined 28px **Apply to model**, disabled while nothing
  is pending or another request runs. While it runs, one line `Claude is applying R2, R4… 12 s · Agent tab` with a
  Cancel button. After it, one graphite sentence (`Applied R2, R4.`); problems (no trace, errors, limits) in the red
  pencil. Without `--agent` the button is replaced by one sentence: start `chen serve` with `--agent claude` or
  `--agent codex`.
- **Conflict.** When the file changed outside the viewer while lines were unsaved, a red-pencil sentence with ✕ says
  so and offers two text buttons: **Load the file** and **Keep these lines**.
- **Notes.** Each not-covered line adds an info finding (graphite •) "Requirement R4 is not reflected in the model."
- **Keys.** Enter opens the next line (splits at the caret); Backspace on an empty line removes it and returns to the
  previous one; ArrowUp/ArrowDown move between lines; a pasted list becomes lines. Everything is reachable with Tab;
  each textarea is labelled by its R-number and described by its state line.
