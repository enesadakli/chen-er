---
name: er-diagram
description: Draw or check ER diagrams in Chen notation, database conceptual models, and (min,max) participation using chen-er YAML, CLI or MCP tools.
---

# ER diagram workflow

Write `model.er.yaml`. Run `chen lint model.er.yaml`, fix errors, then run
`chen render model.er.yaml --png --report`. Open the PNG and inspect labels,
participation, crossings and attribute ownership. Rename or restructure ambiguous
facts and repeat. Pins in `model.er.layout.json` are human-owned: the human corrects placement by dragging in the viewer. Do not write pins or soft positions.
With a source checkout, replace `chen` with `npx tsx src/cli/index.ts`.

For relational design, run `chen map model.er.yaml --format md` after checking
the model; use `--format sql --default-type TEXT --out tables.sql` for SQL or
`--format json` for table metadata. Each table explains its producing course
step (1–7, specialization option 8A) and later FK additions. Read notes for
unenforced constraints, name collisions and the n-ary participation caveat in
`docs/mapping.md`. SQL types are placeholders. Fix errors before mapping.

If the CLI is unavailable, call MCP `get_schema`, then `lint_er`, then `render_er`.
Supply exactly one of `model` (YAML text) or `path` (server-side file path).
Inspect the returned PNG. Use `path` to load sibling layout pins; `out` writes
both an SVG and a sibling PNG.

MCP `map_er` accepts the same exactly-one-of `model`/`path` source and returns
JSON relations, keys, FKs, explanations, notes, diagnostics and `md`, without
writing files. Mapping supports specializations; rendering still does not.

## Model cheat sheet

Use version 1. Name entities and relationships by their domain meaning. Use
`label` for display text. Declare attributes as names or objects; composite
`parts` need at least two members. Use `keys: [[A], [B]]` for two candidate keys,
`keys: [[A, B]]` for one composite key. Mark weak entities with `weak` and
`partialKey`. Use `identifies` on their identifying relationship. Declare every
relationship end with `entity` and `card: "min..max"`; use distinct `id` and
`role` on recursive ends. Three or more ends form one n-ary diamond. Keep
relationship facts in its `attrs`. Record assumptions in `notes`; use `title`
for the diagram heading and optional `note` on an entity or relationship.

```yaml
version: 1
title: Library conceptual model
entities:
  BOOK:
    label: Book
    attrs: [ISBN, CatalogId, Title, {name: Authors, multivalued: true}]
    keys: [[ISBN], [CatalogId]]
  COPY:
    weak: true
    attrs: [CopyNo, Shelf]
    partialKey: [CopyNo]
  MEMBER:
    attrs:
      - MemberId
      - {name: Name, parts: [First, Last]}
      - {name: Age, derived: true, label: Age in years}
    keys: [[MemberId]]
  BRANCH:
    attrs: [City, Code]
    keys: [[City, Code]]
relationships:
  COPY_OF:
    identifies: COPY
    ends: [{entity: BOOK, card: "0..N"}, {entity: COPY, card: "1..1"}]
  BORROWS_AT:
    ends:
      - {entity: MEMBER, card: "0..N"}
      - {entity: COPY, card: "0..N"}
      - {entity: BRANCH, card: "0..N"}
    attrs: [LoanDate, DueDate]
  RECOMMENDS:
    ends:
      - {id: recommender, entity: MEMBER, role: recommender, card: "0..N"}
      - {id: recipient, entity: MEMBER, role: recipient, card: "0..N"}
notes:
  - A copy exists only as a copy of a book.
  - A loan records a member, copy and branch together.
  - Loan history with repeat loans needs an explicit loan entity.
```

## Semantics and course conventions

The `(min,max)` beside an entity is THAT entity's participation in the
relationship: `min 0` means partial; `min >= 1` means total. Do not interpret it
as the opposite end's multiplicity. Keep M:N relationship attributes on the
relationship. Model a weak entity with its owner, identifying relationship,
total participation and partial key. Avoid generic relationship names like
`HAS`. Write assumptions as `notes`. **0 lint errors ≠ correct model**:
check domain meaning, keys and participation yourself. Version 1 reserves
`specializations` for EER but does not draw them.

Human-owned pins use stable node ids. Entity/relationship pins are absolute centres in pixels; attribute pins are `{dx, dy}` offsets from the immediate parent centre (composite parts use the parent attribute oval):

```json
{"version":1,"engine":"layered","pins":{"E:BOOK":{"x":240,"y":160},"A:BOOK.Title":{"dx":40,"dy":-64}}}
```

Use `E:<Entity>`, `R:<Relationship>` or `A:<Owner>.<attr>[.<part>]` as pin keys.

Legacy absolute attribute pins remain exact on read and migrate without a jump on the next viewer layout-file write. CLI `--report` and MCP `render_er` with `report: true` report pin drift against the actual parent plus offset. Rendering does not write or migrate pins.
