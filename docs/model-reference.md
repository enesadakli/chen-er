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
{"version":1,"engine":"layered","pins":{"E:PROJECT":{"x":240,"y":160},"A:PROJECT.Name":{"dx":40,"dy":-64}}}
```

Entity/relationship pins use absolute node centres `{x, y}` in pixels, with the origin at the top left and y increasing downward. Attribute pins use `{dx, dy}` from the immediate parent centre: an entity, a relationship or a parent attribute for composite parts. Relative pins are only valid on `A:` ids; each entry must use exactly one coordinate form. Soft positions remain absolute centres.

Version 1 files with absolute attribute pins remain readable and honour those centres exactly. On the next pin, position or engine write, the writer converts them against the parent's centre in the current diagram, without rounding the offset or moving the drawing. Starting the viewer saves accepted positions and performs this conversion too. Direct app writers (`writeLayoutFile`, `writePins`, `formatLayoutFile`) take the current `Diagram` as their final argument when converting legacy attribute pins; they reject conversion without that geometry. Inactive legacy pins whose nodes/parents are absent are retained until geometry is available. Rendering via CLI/MCP reads the file without migrating it.

Pins are human-owned; agents edit the YAML model and use reports for inspection. `chen render --report` and MCP `render_er` with `report: true` measure relative pin drift against the actual parent centre plus the offset. `pins-degrade-layout` compares against an unpinned layout and includes spoke/label clearance regressions. Stable node ids are `E:<Entity>`, `R:<Relationship>` and `A:<Owner>.<attr>[.<part>]`. Relationship end ids are `<Relationship>#<id>` or `<Relationship>#<index>` when no explicit id is provided.

Pins constrain placement. Saved positions guide incremental layout. If restored attribute positions leave no readable
participation/role label slot, only a blocking unpinned attribute position is released; real pins and restored
entity/relationship positions remain exact. CLI `--fresh` ignores positions while keeping pins; the viewer's Relayout does the same and saves the resulting positions. Diagnostics and quality reports still need human review.
