# Changelog

All notable changes to chen-er are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
- <!-- PLACEHOLDER: add entries for the long-edge layout fixes and the MCP and package fixes that land before release. -->

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
