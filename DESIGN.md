# Design: chen-er viewer

World: **an engineering notebook page.** The diagram is drawn on a gridded notebook sheet; the reviewer's
findings are pencil notes in the margin, numbered and keyed to marks on the drawing. Exporting tears out a clean
textbook figure: grid, notes, marks and selection never reach the SVG/PNG.

Mode: Operate. The diagram and the findings are the task; chrome stays quiet. Used as a narrow side window next to
an agent's terminal and full screen for polishing, equally.

## Physical scene
A student at a desk under ordinary room light, laptop next to the course book, a terminal on the left half of
the screen. The page must read like paper in daylight; in dark mode the desk goes dark but the sheet stays paper,
because the figure is black ink on white and must look the same as the export.

## Color (Restrained: neutrals + pencil roles)
- Sheet `#FBFBF8`; grid minor `#E7ECEF` every 8px, major `#D5DDE2` every 40px (screen only).
- Margin rule: one vertical line `#E4A9A4` separating sheet from the notes column (the notebook's red margin line).
- Ink `#1F2328` (diagram, primary text). Graphite `#6B7177` (secondary text, pins, guides).
- Finding roles, always paired with a glyph and a number, never color alone:
  error = red pencil `#C4362D` + ✕ in a circle; course = blue pencil `#2F5FA8` + △; heuristic = graphite `#6B7177` + ○;
  info = graphite light `#9AA1A7` + •.
- Selection/hover halo: graphite at 35% opacity, 6px outside the shape outline.
- Dark mode: desk `#14171A`, chrome text `#D7DCE0`, chrome rules `#2A3036`; the sheet keeps its light colors.

## Type
- Diagram: Inter (bundled; layout is measured against it). Never change the diagram font in the viewer.
- UI: `system-ui` stack, 13px base, 1.45 line height; numbers tabular (`font-variant-numeric: tabular-nums`).
- Code/YAML excerpts, file paths, zone/line refs: `ui-monospace` stack, 12px.
- Page header title: model title at 15px/600; nothing larger anywhere in the UI.

## Layout
- Header strip (44px): model title · file path (mono, truncates from the left) · engine select · quality summary
  ("0 overlaps · 3 crossings") · live status ("updated 12:04:31") · Fit · Export ▾ (SVG, PNG) · Reset pins.
- Sheet (canvas) fills the rest; notes column (320px) right of the margin rule.
- ≤ 900px wide: notes column becomes a bottom drawer (40% height, draggable), header collapses secondary actions
  into an overflow menu. Never horizontal page scroll.

## Components
- Finding card (margin note): number + glyph + severity word, message, hint in graphite, "line 14" link (mono).
  Selected card expands to show the YAML excerpt (±3 lines, line numbers, target line marked with a pencil bar).
- Drawing marks: small numbered circle (16px) at the element's top-right, same color/glyph as its card.
- Pin mark: 6px graphite tick at a pinned node's top-left; pinned nodes also get a dotted outline on hover.
- Buttons: 28px high, 1px graphite rule, 4px radius, no fills except the primary Export (ink fill, sheet text).
- Engine select: native `<select>`. Menus: native-feeling, keyboard reachable.

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
Connected relationships keep every end and role/cardinality label together; unrelated drawing elements dim.
Selection preserves the camera; Focus explicitly fits the neighborhood. Dragging hides actions and starts only
after 4 screen pixels. Enter opens node actions; Escape dismisses them. Attribute nodes retain movement and
unpin shortcuts. The viewer does not edit the model; it writes only the layout file.

Undo/Redo are session controls in the header and cover layout changes only (pins, reset, relayout, engine).
Computing, saved, conflict and failure states remain visible in the status strip.
