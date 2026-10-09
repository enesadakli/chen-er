---
name: er-diagram
description: Draw or check ER diagrams in Chen notation, database conceptual models, and (min,max) participation using chen-er YAML, CLI or MCP tools.
---

# ER diagram workflow

Write `model.er.yaml`. Run `chen lint model.er.yaml`, fix errors, then run
`chen render model.er.yaml --png --report`. Open the PNG and inspect labels,
participation, crossings and attribute ownership. Rename or restructure ambiguous
facts; pin a node in `model.er.layout.json` when placement needs correction. Repeat.
With a source checkout, replace `chen` with `npx tsx src/cli/index.ts`.

If the CLI is unavailable, call MCP `get_schema`, then `lint_er`, then `render_er`.
Supply exactly one of `model` (YAML text) or `path` (server-side file path).
Inspect the returned PNG. Use `path` to load sibling layout pins; `out` writes
both an SVG and a sibling PNG.

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

Pins use stable node ids and center coordinates in pixels:

```json
{"version":1,"engine":"layered","pins":{"E:BOOK":{"x":240,"y":160}}}
```

Use `E:<Entity>`, `R:<Relationship>` or `A:<Owner>.<attr>[.<part>]` as pin keys.
