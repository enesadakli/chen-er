# From ER to tables

`chen map` maps a normalized ER model to relational tables. The browser-safe
`src/core/map` module supplies the CLI and the read-only MCP `map_er` tool.
The explanations are original summaries of the course algorithm; the public
fixtures supply all examples here.

```sh
npx tsx src/cli/index.ts map bench/fixtures/campus.er.yaml --format md
npx tsx src/cli/index.ts map bench/fixtures/campus.er.yaml --format sql --out campus.sql
npx tsx src/cli/index.ts map bench/fixtures/ternary.er.yaml --format json
chen map model.er.yaml --format sql --default-type 'VARCHAR(100)'
```

The default format is `text`. Markdown underlines PK columns; text marks them
`[PK]`. Each block lists FKs, UNIQUE constraints and every step contributing to
that table, with model element ids. JSON contains `relations`, `notes` and CLI/MCP
`diagnostics`. A relation has `columns` (name, source ids, nullability),
`primaryKey`, `uniqueKeys`, `foreignKeys`, producing `step`/`reason`/`elementIds`,
and a `steps` array recording subsequent additions. MCP adds `md` to the same
JSON payload and accepts exactly one of `model` (YAML text) or `path`.

The CLI prints the mapping to stdout, or writes `--out` and prints that path.
It refuses to overwrite the input model. Errors produce exit code 1 for an
invalid model, 2 for usage/I/O failures; invalid models never write an output.
Warnings and course findings appear on stderr. Mapping runs the existing lint
rules, except `unsupported-eer`, which describes a drawing limitation. Parsing,
unknown references and every other lint error still block mapping. Missing keys
or keys involving derived/multivalued components are additional mapping errors;
the mapper never invents surrogate ids.

## Rules implemented

| Step | Result and decision |
| --- | --- |
| 1 | One table for a regular entity. Flatten composites to stored simple leaves. The first `keys` entry becomes PK; remaining candidate keys become UNIQUE and NOT NULL. Omit derived attributes and list their ids in notes. |
| 2 | Build owners first, including weak-owner chains. Copy every owner's PK as a NOT NULL FK. The weak PK combines owner PKs and expanded `partialKey`. Put identifying relationship attributes here. A binary owner end with max 1 also makes the owner FK UNIQUE. |
| 3 | Binary 1:1 uses an FK in the sole total end if one exists. With both or neither total, choose by entity name, then end id, in lexical order and report the choice. The FK is UNIQUE and is NOT NULL only if its destination end is total. Put relationship attributes beside it. |
| 4 | Binary 1:N copies the other entity's PK to the end with max 1. That entity is the relational N side under this project's participation convention. Its min ≥ 1 makes the FK NOT NULL. Put relationship attributes there. |
| 5 | Binary M:N gets its own table, both participant PKs as NOT NULL FKs, and their combination as PK. Add relationship attributes. This represents a set of pairs, not repeated events between the same participants. |
| 6 | A multivalued attribute gets a table with owner PK as NOT NULL FK and stored simple value components; all of these form the PK. Composite values and relationship-owned values are supported. A relationship mapped by FK uses the destination entity's PK as its identity. |
| 7 | An n-ary relationship gets all participant PKs as NOT NULL FKs. As requested by the course mapping rule, the PK combines FKs of many ends and excludes max 1 ends. Finite maxima greater than 1 count as many. See the semantic caveat below. |
| 8 | Option 8A keeps superclass and subclass tables. Each subclass inherits its superclass PK as both PK and NOT NULL FK; its own declared candidate keys become UNIQUE. Subclasses may omit `keys`. Specialization chains and multiple inheritance work. |

Option 8A handles total/partial and disjoint/overlapping specializations.
Notes describe alternatives: 8B stores only subclass tables (requires total
coverage, with redundant superclass data for overlapping membership); 8C stores
one table with a discriminator for disjoint subclasses; 8D stores one table with
membership flags for overlapping subclasses. These alternatives are explanatory,
not selectable output modes. Drawing specializations remains unsupported.

For multiple inheritance, a common ancestor's PK is reused and references every
superclass. Independent superclass identities remain separate: the lexically
first superclass supplies the PK, and other identities become NOT NULL UNIQUE
FKs. The subclass row represents their correspondence; notes report this choice.

## Cardinality convention and constraints

`card` counts participations of the entity at **that end**. For example,
`HOSPITAL 1..N` means each hospital has at least one relationship occurrence;
`WARD 1..1` means each ward has exactly one. Consequently `WARD` receives the
hospital FK. This follows `parseCard` and the existing lint rule
`movable-relationship-attribute`, which names max=1 ends as destinations.
Tests pin both end orders, optional/total cases and `N`, `M`, `*` and finite
maxima. Recursive relationships use the referenced end's `role` for FK names:
`supervisor_StaffId` refers to `STAFF(StaffId)` on the trainee row.

The requested step 7 key rule normally describes multiplicity for a **fixed
combination of the other ends**. The model instead counts each entity's total
participations. For mixed max=1/many n-ary ends, the mapper follows the requested
PK rule, adds UNIQUE on each max=1 end's FK to enforce that end's participation
bound, and explicitly notes that the PK introduces an additional functional
dependency. Review this assumption against the assignment. For all-max=1 n-ary
relationships the many-end key would be empty: use all FKs as PK plus UNIQUE on
each end, and report the fallback.

A NOT NULL FK ensures a referencing row has a participant; it does not ensure
that every referenced entity is used. Notes list total participation on the
referenced side, minimum counts above 1 and finite maximum counts above 1 as
requiring assertions or triggers. Optional composite FKs require all components
to be NULL or all to be present; add `MATCH FULL` or a CHECK for your SQL dialect.
Relationship attributes beside an optional FK need a CHECK/trigger if they must
be absent when the relationship is absent. Option 8A FKs ensure subclass rows
exist in the superclass, but disjoint membership and total subclass coverage
require additional cross-table enforcement. Overlapping/partial constraints
permit membership and absence rather than requiring them.

## Names, order and SQL

Use model names, not display labels. Composite paths join names with `_`.
Relationship FKs use `<role>_<PK-column>` when the referenced end has a role.
Without a role, a single unambiguous reference uses `<ENTITY>_<PK-column>`.
When a table has multiple FKs to the same referenced relation, every unroled
reference uses `<RELATIONSHIP>_<PK-column>` instead. An entity-prefixed name
collision also switches the whole FK, including every composite PK component,
to its relationship prefix. All relationship FKs and stored attributes are
considered before allocation, including attributes added by later relationships;
the first reference is therefore just as descriptive as subsequent references.
Roles take priority over the relationship fallback.

Multivalued tables use `<owner-table>_<attribute-path>`. Table names and each
table's column names are reserved case-insensitively. Numeric suffixes `_2`,
`_3`, etc. are a last resort when descriptive FK prefixes still collide; other
table/attribute collisions use the same deterministic suffixing. Notes record
source ids and each numeric rename. Entity/relationship
construction uses lexical names, while declared key order and relationship end
order remain significant.

Tables are returned in a stable FK dependency order. SQL creates dependencies
first, with self-FKs inline. A cycle defers forward FKs to `ALTER TABLE ... ADD
FOREIGN KEY` after the tables; this requires a dialect supporting that statement
(SQLite does not). SQL uses double-quoted identifiers for keywords or unusual
names. Every column gets the `--default-type` placeholder (default `TEXT`),
validated as a type declaration rather than arbitrary SQL. The first SQL comment
says types are placeholders. Types, collations, delete/update actions and extra
business constraints need a database-specific review.

Models with missing/unstored keys, empty multivalued value identities,
ambiguous multiple identifying relationships, cyclic identity dependencies,
weak subclasses with competing inherited/owner identities are refused with
mapping diagnostics. A jointly owned weak entity is supported through a single
identifying relationship with all owner ends; additional n-ary participation
constraints remain notes.

## Public fixture examples

`bench/fixtures/campus.er.yaml` is named campus but models hospital operations.
Its 11 output tables illustrate steps 1–6. `ADMISSION` uses the patient's identity
plus `AdmittedOn`; its two references to STAFF are named `ATTENDS_StaffId` and
`DISCHARGES_StaffId`, so both meanings are visible without a numeric suffix.
Optional `OCCUPIES` is 1:1; lexical tie-breaking puts its
nullable UNIQUE bed FK in `ADMISSION`. The fixture's notes distinguish employment
from ward assignment and the two clinician relationships.

```text
WARD(WardCode [PK], Name, Specialty, HOSPITAL_HospitalId)
HOSPITAL_HospitalId → HOSPITAL(HospitalId) [NOT NULL]
Step 1: E:WARD is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
Step 4: R:HAS_WARD is 1:N (E:HOSPITAL 1..N, E:WARD 1..1); FK on E:WARD, the max=1 (relational N-side) end.
```

```sql
-- Types are placeholders: the ER model declares no data types. Review before execution.
CREATE TABLE WARD (
  WardCode TEXT NOT NULL,
  Name TEXT,
  Specialty TEXT,
  HOSPITAL_HospitalId TEXT NOT NULL,
  PRIMARY KEY (WardCode),
  FOREIGN KEY (HOSPITAL_HospitalId) REFERENCES HOSPITAL (HospitalId)
);
```

The hospital's minimum of one ward remains an explanatory note: the ward FK
cannot require every hospital to have a ward. The complete, executable table
sequence and Markdown explanations are checked-in snapshots:
[campus Markdown](mapping/campus.md) and
[campus SQL](mapping/campus.sql).

`bench/fixtures/ternary.er.yaml` produces the three entity tables and a step 7
`SUPPLY` table. All ends are many, so its PK is
`(SUPPLIER_SupplierNo, PROJECT_ProjectNo, PART_PartNo)`, with one FK per end and
`Quantity` as a relationship attribute. A part's `1..N` participation still needs
cross-table enforcement. Full snapshots:
[ternary Markdown](mapping/ternary.md) and
[ternary SQL](mapping/ternary.sql).
