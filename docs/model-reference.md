# Model reference

The version 1 format is defined by [JSON Schema](../schema/er.schema.json). Unknown properties are rejected. Entity and relationship names are identifiers: start with a letter or underscore, then use letters, digits, underscores or hyphens. `label` supplies different display text.

## Entities and attributes

```yaml
version: 1
entities:
  EMPLOYEE:
    attrs:
      - EmployeeId
      - Email
      - {name: Name, parts: [First, Last]}
      - {name: Phones, multivalued: true}
      - {name: Tenure, derived: true}
    keys: [[EmployeeId], [Email]]
```

`keys: [[A], [B]]` declares two candidate keys; `[[A, B]]` declares one composite key. Keys reference top-level attributes and draw solid underlines. Attributes may be identifier strings or objects with `name`, optional `label`, `parts`, `multivalued` and `derived`. Composite parts need at least two attributes. Multivalued attributes draw double ellipses; derived attributes draw dashed ellipses.

## Relationships and participation

A relationship has at least two `ends`, each with `entity` and `card`. Optional fields are `id` and `role`. The syntax `"min..max"` accepts a numeric maximum or `N` (`M` and `*` are also accepted). Numeric maxima must be positive and at least the minimum.

The label beside an entity describes that entity's participation: `"0..N"` means it participates zero or many times; `"1..1"` means exactly once. It does not describe the opposite entity's multiplicity. Relationship `attrs` describe the association, such as HoursPerWeek in [CONTRIBUTES](../examples/company-project.er.yaml).

For repeated entities, give every end a role and use distinct ids to keep layout references stable:

```yaml
relationships:
  MENTORS:
    ends:
      - {id: mentor, entity: EMPLOYEE, role: mentor, card: "0..N"}
      - {id: mentee, entity: EMPLOYEE, role: mentee, card: "0..1"}
```

Three or more ends form one n-ary diamond. The [workshop example](../examples/ternary.er.yaml) models a three-way fact. Its `(min,max)` values describe participation in that fact; they do not specify uniqueness of every pair. Record such assumptions in notes. Repeated occurrences of the same combination may need an entity with its own key.

## Weak entities

```yaml
entities:
  PROJECT: {attrs: [ProjectId], keys: [[ProjectId]]}
  TASK: {weak: true, attrs: [TaskNo], partialKey: [TaskNo]}
relationships:
  CONTAINS:
    identifies: TASK
    ends:
      - {entity: PROJECT, card: "0..N"}
      - {entity: TASK, card: "1..1"}
```

A weak entity draws a double rectangle; its identifying relationship draws a double diamond. The identified end draws double lines. A binary identifying relationship requires the weak end to be `"1..1"`. A partial key distinguishes the entity within its owner and draws a dashed underline. Missing partial keys are course findings; missing identifying relationships are errors. Identification cycles are errors.

## Notes and unsupported EER

Use `title` for the heading and top-level `notes` for text printed below the diagram. Entity/relationship `note` fields are accepted model metadata; they are not printed as diagram notes. Non-empty `specializations` currently produce an `unsupported-eer` error.

## Layout files

A sibling `model.er.layout.json` stores an optional engine (`layered`, `stress`, `simple`), hard `pins` and optional soft `positions`:

```json
{"version":1,"engine":"layered","pins":{"E:PROJECT":{"x":240,"y":160}}}
```

Coordinates are node centers in pixels, with the origin at the top left and y increasing downward. Stable node ids are `E:<Entity>`, `R:<Relationship>` and `A:<Owner>.<attr>[.<part>]`. Relationship end ids are `<Relationship>#<id>` or `<Relationship>#<index>` when no explicit id is provided.

Pins constrain placement. Saved positions guide incremental layout. CLI `--fresh` ignores positions while keeping pins; the viewer's Relayout does the same and saves the resulting positions. Diagnostics and quality reports still need human review.
