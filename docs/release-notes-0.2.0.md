# chen-er 0.2.0

Diagrams now read like a textbook figure. 1:N relationships run top-down,
relationship diamonds sit between their entities, and each participation label
(min,max) stays attached to its own edge. Routes are shorter and straighter, and
re-rendering a model keeps the drawing stable: nodes you did not change stay in
place and new shapes are placed next to their neighbours. Saved layout pins that
make a drawing clearly worse now produce a warning. The repository has public
acceptance tests and a CI workflow.

- Semantic layout: the engine builds several candidate placements from the
  model's hierarchy and keeps the best-scoring one, with compact output for small
  diagrams and straight attribute spokes.
- Stable re-layout: soft positions are saved in the layout file, untouched nodes
  stay where they are, and the viewer has a Re-layout button. `chen render --fresh`
  lays the diagram out from scratch.
- Shorter routes: the orthogonal router searches only around the two endpoints
  (up to 6 times faster), and end routes avoid detours, overlaps and tiny segments.
- New `warning` severity and a `pins-degrade-layout` warning when saved pins make
  the layout clearly worse than an unpinned one. `chen render --no-pins` ignores
  the layout file so the two can be compared.
- Heuristic findings answered by a relationship `note` are reported as `info`.
- More quality metrics in `chen render --report` and `npm run bench`
  (for example `hierarchyViolations`, `diamondOffset`, `routeDetourMax`,
  `labelLoose`, `endPortCrowding`).
- Public examples (`company-project`, `ternary`), model reference documentation,
  and `npm run gen:docs` to regenerate the example images.
- MCP: `render_er` returns the same warnings and notes as `chen render` and
  accepts `noPins`. An installed package starts the MCP server with
  `chen-er-mcp`.
- A public hospital acceptance fixture, bench guard tests and a GitHub Actions
  workflow that runs the type check and tests on every push and pull request.

## Upgrade notes

- The default layout output differs from 0.1. Render existing models again to
  update their diagrams.
- Pins saved in a 0.1 session may now make `chen render` print a
  `pins-degrade-layout` warning if they work against the new layout. Run
  `chen render model.er.yaml --no-pins` to compare; the layout file is not
  modified. Use Reset pins in `chen serve` to remove the pins.
- `chen render` prints a note on stderr when the layout file selects a
  non-default engine. Pass `--engine` to override it.
- The new `warning` severity does not change exit codes: only `error` findings
  make `chen lint` and `chen render` exit with code 1. `--no-course` and
  `--no-heuristic` do not hide warnings.
- The minimum Node.js version is now 24.
