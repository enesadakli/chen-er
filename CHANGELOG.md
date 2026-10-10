# Changelog

All notable changes to chen-er are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `chen map <model> --format text|md|sql|json [--out file]` and read-only MCP
  `map_er`: deterministic, browser-safe ER-to-relational mapping with steps 1–7
  and specialization option 8A, source ids, FK/PK/UNIQUE/NOT NULL constraints,
  recursive roles, naming collision notes and unenforced participation constraints.
  SQL uses `--default-type` placeholders (default `TEXT`). Invalid models are
  refused. See `docs/mapping.md` for rules and the n-ary cardinality caveat.

- Requirements tab in `chen serve`: write the requirements one sentence per line
  (Enter opens the next line, Backspace on an empty line removes it, a pasted
  list becomes lines). They autosave to `<model>.er.requirements.md`, a
  Markdown list that reads well in Obsidian and in a PDF; ids, applied hashes
  and traces stay in HTML comments. With `--agent`, **Apply to model** sends
  only new and changed lines (the whole list as context) to Claude or Codex,
  validates the returned `chen-trace` block against the model and shows under
  each requirement the elements that implement it, as links to the drawing.
  Requirements nothing implements are marked `△ not covered` and listed in
  Notes. Undoing an apply turn also restores the lines' earlier state. See
  docs/requirements.md.

- `chen serve --agent codex`: the agent panel runs the local Codex CLI headless
  (`codex exec --json`, workspace-write sandbox limited to the agent's working
  directory and the model's directory, `resume` for follow-up requests) with
  the same steps, cancel, change notes, undo and error messages as Claude Code.
- The agent thread survives a server restart. It is kept in
  `<model>.er.agent.json` next to the model (written atomically after every
  change; never contains the URL token): requests, steps, change notes, the
  agent session for resume and the undo snapshot of the latest change. A
  request that was running when the server stopped is shown as cancelled with
  a notice. Add `*.er.agent.json` to `.gitignore`.

### Changed

- The agent prompt also forbids editing `*.er.agent.json` and
  `*.er.requirements.md` files; Claude turns may also call the read-only
  chen-er MCP `get_schema`.
- The notes column always shows its tabs (Notes | Requirements, plus Agent with
  `--agent`).
- From a source checkout, the lint command given to the agent uses the
  checkout's own `node_modules/.bin/tsx` when present instead of `npx tsx`,
  which needs the network when run from another directory.
- Faster layout of large models. Route, label and quality checks skip
  geometry outside a candidate's bounds, placement scoring recounts only the
  crossings of moved paths, and the spacing and Z-route searches try fewer
  candidates once a model has more than 12 entities (a fixed share of the
  model size, so the same input always gives the same drawing). A 26-entity,
  36-relationship model now lays out in about 2 seconds instead of 20; the
  drawings of models up to 12 entities are unchanged.
- New public bench fixture `bench/fixtures/large/transit-network.er.yaml`
  (26 entities, 36 relationships, 99 attributes) with a 4-second layout guard.
- Viewer: grouped header (Undo/Redo pair, Layout menu, theme switch, one
  filled Export), quieter node toolbar that is placed away from labels and
  shapes, single zoom strip, and the whole canvas is endless graph paper with
  corner marks showing the export area.

### Fixed

- Layouts with pins could push unpinned elements to negative coordinates,
  where they were cut off in the viewer and in exported SVG/PNG. The diagram
  now carries an `origin` and the SVG `viewBox` covers every element.

### Known limitations

- Large models are still hard to read in one figure. The 26-entity bench model
  is 5902×2166 px with 33 edge crossings and 23 Z-shaped routes; its longest
  end edge is about 15 entity widths. A private model of the same size still
  has two participation labels that sit too close to a neighbouring end edge
  (loose and ambiguous; one overlaps that edge) and two attribute clearance
  misses. Adding
  one attribute can move an entity by up to about 170 px. Splitting large
  models into subject-area diagrams is planned.

## [0.3.0] - 2026-10-09

### Added

- `diagonalEnds` hard metric: relationship-to-entity edges are always drawn with
  horizontal and vertical segments. A candidate layout that would need a
  diagonal end is rejected.
- `labelOnOwnEdge` hard metric: a participation or role label is never crossed
  by its own edge.
- `zRoutes` metric (end edges with two bends whose first and last segments are
  parallel), used in the layout score and reported by `chen render --report`
  and the bench.

### Changed

- Denser layouts for models with a highly connected entity: an entity may move
  down next to its nearest child when this keeps every 1:N relationship
  top-down, and row and column spacing are chosen by a bounded search. On the
  public hospital fixture the drawing area is 28% smaller and the total edge
  length 48% shorter.
- Edge ports avoid neighbouring relationship diamonds and may use an entity's
  left or right side when its top is crowded.
- Fewer Z-shaped routes: a diamond can shift by one grid row or column so a
  route becomes straight or L-shaped.
- `pin-conflict` and `layout-conflict` diagnostics use the `warning` severity.

### Known limitations

- Very large models are slow and hard to read in one figure. A 26-entity,
  36-relationship test model takes about 20 seconds to lay out and has about 30
  edge crossings. Splitting large models into subject-area diagrams is planned.

## [0.2.0] - 2026-10-09

### Added

- Semantic layout: the layout engine now generates several candidate placements
  from the model's structure and keeps the best-scoring one. 1:N relationships
  read top-down, each relationship diamond sits between its entities, and
  entities that are not constrained by a hierarchy are placed beside their
  neighbours.
- Participation labels (min,max) are attached to the entity end of their own
  edge, with a fixed distance from the entity and a check that no other edge can
  claim the label.
- Entity edge anchors are fanned out, so several edges leaving one entity no
  longer share a single attachment point.
- Compact layout for small diagrams, and shorter, straighter routes for
  recursive and n-ary relationship ends.
- Soft positions: the layout file can store the positions of unpinned nodes so a
  saved drawing stays the same when the model is rendered again. The viewer
  saves them as you work.
- Incremental layout: when the model changes, nodes that were not touched stay
  where they are, and new entities, relationships and attributes are placed next
  to their neighbours.
- Viewer: a Re-layout button lays the whole diagram out again while keeping
  pins. Reset pins still removes the pins.
- `chen render --fresh` ignores saved soft positions and lays the diagram out
  from scratch (pins still apply).
- `chen render --no-pins` ignores the layout file entirely (pins, soft positions
  and the stored engine) without modifying it.
- `chen render` prints a note on stderr when the layout file, not the command
  line, selected a non-default engine; `--engine` overrides it.
- `warning` severity, shown between `error` and `course`. It reports an
  operational problem with the rendering rather than with the model. It is
  always shown, is not hidden by `--no-course` or `--no-heuristic`, and has its
  own marker in the viewer.
- `pins-degrade-layout` warning: `chen render` compares a pinned layout with an
  unpinned one and warns when the pins clearly make the drawing worse (area
  above 1.5 times the unpinned area, at least 3 more edge crossings, or any
  overlap, label or routing metric worse).
- Layout quality metrics reported by `chen render --report` and `npm run bench`:
  `hierarchyViolations`, `diamondOffset`, `relatedDistance`,
  `proximityInversions`, `axisAligned`, `centralityOffset`, `gridMisalignment`,
  `attributeInwardRatio`, `routeDetourMax`, `routeDetourMean`, `endBendsMax`,
  `endBendsMean`, `attributeSpokeMax`, `emptyAreaRatio`, `plainSegmentRatio`,
  `edgeLength`, `meanEdgeRatio`, `density`, `longestEdgeRatio`, and the
  zero-target counts `labelLoose`, `attributeEdgeBends`, `edgeOverlap`,
  `tinySegments`, `endPortCrowding`, `diamondVertexViolations` and
  `doubleEdgeArtifacts`.
- Public examples `examples/company-project.er.yaml` and
  `examples/ternary.er.yaml`, with generated SVG and PNG images in `docs/`.
- `npm run gen:docs` regenerates the images in `docs/` from the top-level
  examples with the current engine. It ignores saved soft positions, respects
  explicit pins and stops on errors.
- Documentation: `docs/model-reference.md` (the model format) and
  `docs/npm-readiness.md` (publication checklist), and a reorganised README
  covering the model workflow.
- Public acceptance tests on a hospital model (`bench/fixtures/campus.er.yaml`)
  and per-fixture bench guard tests that run the same checks as `npm run bench`.
  Timing checks in tests run only when `CHEN_PERF=1`.
- GitHub Actions workflow that runs the type check and the test suite on every
  push and pull request.
- Package metadata for npm: repository, homepage and bugs URLs, `docs/` and the
  public examples in the published files, and a `prepublishOnly` build.

### Changed

- The default layout output differs from 0.1. Diagrams are more compact, use
  shorter routes, and have stable placement between runs. Re-render existing
  diagrams to update them.
- Heuristic findings (`parallel-relationships`, `redundant-functional-path`) that
  the author has answered with a relationship `note` are reported as `info`
  instead of `heuristic`; the message quotes the note. The hint now says to
  justify the difference in a note on one of the relationships.
- The minimum Node.js version is 24 (was 22).

### Fixed

- Layout checks that were previously too loose for participation labels are now
  strict, and a regression that lengthened routes in the company example was
  corrected.
- Attribute spokes are drawn straight, and end routes no longer double back on
  themselves, overlap or leave very short segments.
- Double (total participation) edges and diamond corners no longer produce
  drawing artifacts.
- Ambiguous end labels, where it was unclear which edge a label belonged to,
  are avoided.
- Layout is up to 6 times faster on larger models because the orthogonal router
  now searches only the neighbourhood of the two endpoints.
- The MCP `render_er` tool now returns the same rendering advice as
  `chen render`: the `pins-degrade-layout` warning in its diagnostics and the
  engine note in a `notes` field. It accepts `noPins` to ignore the layout file.
- `chen serve` reports a failure to save positions as a `warning` instead of
  `info`.
- An installed package could not start the MCP server. The package now ships a
  `chen-er-mcp` command (`bin/chen-mcp.js`).
- Recursive relationship diamonds sit closer to their entity on larger models.
- New quality metrics in `chen render --report` and the bench: `longEdgeMax`,
  `longEdgeMean`, `spokeEdgeClearance` and `spokeLabelClearance`.

## [0.1.0] - 2026-10-09

First version.

- Model format: a YAML conceptual database model with entities, weak entities,
  relationships (binary, recursive and n-ary), attributes with composite,
  multivalued and derived forms, and (min,max) participation. EER
  specializations are reserved in the schema and rejected with
  `unsupported-eer`.
- Layout engines `layered` (default), `stress` and `simple`, deterministic
  geometry, saved pins in a sibling layout file, and SVG output with bundled
  Inter fonts, plus PNG output.
- Course-aware lint with `error`, `course`, `heuristic` and `info` severities,
  source positions, repair hints and `chen rules`.
- CLI: `chen render`, `chen lint`, `chen schema`, `chen init`, `chen rules` and
  `chen serve`.
- Live browser viewer (`chen serve`): reloads on save, drag to pin nodes,
  findings in the margin, SVG and PNG export.
- MCP server with `render_er`, `lint_er` and `get_schema`, and an agent skill
  describing the model workflow.
