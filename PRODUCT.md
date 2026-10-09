# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Primary: a computer engineering student (Intro to Database course, Elmasri & Navathe textbook) who models
  ER diagrams for homework, exams and a term project. The teacher grades the method ("why did you model it this
  way?"), so assumptions and decisions must stay visible.
- The same person as the human reviewer of AI agents: Claude, Codex or Gemini write the model file in a terminal,
  the student watches the diagram update in a browser window beside it, reads the lint findings, and corrects the
  agent or nudges the layout by dragging.

## Product Purpose

chen-er turns a YAML ER model into a laid-out Chen-notation diagram with (min,max) participation labels and checks
it against ER rules and course conventions. Agents never place coordinates; they describe the model, the engine
lays it out, and the human fine-tunes by pinning nodes. Success: an agent can produce a correct, readable diagram
from a text description without hand-written SVG, and the student can submit the PNG as is.

## Positioning

Agent-first: the model file is the only thing an agent writes, and lint output is machine-readable so the agent can
fix its own mistakes. Course-aware: it flags textbook ER errors (weak entity without identifying relationship or
partial key, generic relationship names like HAS, the same fact reachable through two paths) that general diagram
tools never check. Notation matches the textbook exactly: Chen shapes with (min,max).

## Operating Context

- `chen serve model.er.yaml` opens a local viewer; used both as a side window next to an agent's terminal
  (glance, live reload, occasional drag) and full screen when polishing a diagram for submission (drag, export).
- The YAML is edited only by the agent or a text editor; the viewer does not edit the model. It writes only
  the layout file (`model.er.layout.json`): pins and accepted positions.
- Output goes into lecture notes (Obsidian), homework PDFs and printed reports.

## Capabilities and Constraints

- Core runs in Node and the browser (TypeScript, ESM); CLI, MCP server and viewer share it.
- Stack: TypeScript + Vite, vanilla TS for the viewer, no UI framework (user decision).
- Text is measured against the bundled Inter font so layout, SVG and PNG agree.
- Model edits happen outside the viewer (confirmed: no in-browser YAML editor; the viewer writes only the layout file).

## Brand Commitments

- The diagram itself looks like a textbook figure: plain, black on white, print-ready (user decision). Any screen
  emphasis (selection, findings) must disappear in exports.

## Evidence on Hand

- examples/library.er.yaml and bench/fixtures/*.er.yaml (recursive, ternary, dense attributes, Turkish labels, pins).
- A real course model (UNIVERSITY + curriculum) exists locally under examples/private/ and must not be published.
- No users, testimonials or benchmarks exist yet; do not invent them.

## Product Principles

1. The model file is the source of truth; the viewer never changes meaning, only positions, and never writes the model file.
2. Show the reasoning: diagnostics, notes and assumptions stay next to the diagram, not hidden.
3. The exported figure must be submittable without touch-up.
4. Every finding points to an exact element and YAML line.

## Accessibility & Inclusion

- Turkish and English labels (ı, İ, ğ, ş, ö, ü, ç) must render and measure correctly.
- Keyboard access for the findings list and node selection; findings never rely on color alone.
