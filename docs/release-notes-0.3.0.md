# chen-er 0.3.0

Layouts are denser and every edge is drawn with horizontal and vertical
segments. Models with one highly connected entity no longer spread into long,
sparse rows: related entities move closer while 1:N relationships still read
top-down. Participation labels stay clear of their own edge.

- Denser placement: an entity may sit next to its nearest child when the
  hierarchy allows it, and spacing is chosen by a bounded search. On the public
  hospital fixture the area is 28% smaller and the total edge length 48% shorter.
- No diagonal edges: `diagonalEnds` is a hard metric; edge ports avoid
  neighbouring diamonds and can use the sides of a crowded entity.
- Fewer Z-shaped routes, measured by the new `zRoutes` metric.
- Labels: `labelOnOwnEdge` is a hard metric, so a label is never crossed by its
  own edge.
- `pin-conflict` and `layout-conflict` are now warnings.

## Known limitations

- Large models (around 25 entities and 35 relationships) take about 20 seconds
  to lay out and are hard to read in one figure. Faster layout and
  subject-area diagrams are planned.

## Upgrade notes

- Layout output differs from 0.2. Render existing models again; saved pins from
  older sessions may trigger the `pins-degrade-layout` warning, and
  `chen render --no-pins` shows the unpinned result.
