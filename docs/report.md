# Method report export

```sh
chen report model.er.yaml
chen report model.er.yaml --format html --out submission.html
chen report model.er.yaml --no-pins
```

The default writes `model.report.md` and `model.report.svg` beside the model.
Markdown references the sibling SVG by relative filename. HTML writes one file
with an inline SVG and embedded A4 print styles; open it in a browser and print
or save as PDF. There are no external resources, timestamps or absolute paths.
Existing reports may be replaced; the input model cannot be overwritten.

Sections, in order: title and source filename; Requirements (when the sibling
`.er.requirements.md` exists), with coverage states and separate rationale;
ER diagram; Model (entities, keys, attributes, relationship ends and roles);
Traceability (when requirements exist); Lint, including the correctness disclaimer;
and Relational schema, using the same mapping as `chen map`.

Requirements use the [requirements file contract](requirements.md). A trace counts
only when its element still exists. New requirements remain “Not applied yet” even
if their text describes the model; coverage is not inferred. Candidate keys are
parenthesized groups; weak entities show their partial key. Composite attributes
use `Name(First, Last)`, multivalued attributes `{Phones}`, and derived attributes
`/Age/`. Relationship degree is the number of ends.

Saved sibling layout settings apply exactly as for `chen render`; `--no-pins`
ignores pins, positions and the saved engine without changing that file. Findings
are printed on stderr; written paths appear on stdout, one per line. Exit codes:
0 success, 1 model errors (no output written), 2 usage or I/O failure. Relational
mapping failures are shown as diagnostics in the report.

The read-only MCP tool `report_er` accepts exactly one of `model` (YAML text) or
`path`, plus optional `format: "md" | "html"`. It returns `{ report, diagnostics }`
and writes nothing. Markdown uses `(diagram: call render_er)`; HTML includes the
diagram. Path input also loads sibling requirements and layout files.

## Example

The hospital operations fixture includes composite and multivalued attributes,
a weak admission entity, recursive staff roles and relationship attributes. Its
eight hand-written requirements have no applied state, so their statuses honestly
remain “Not applied yet”.

```sh
node_modules/.bin/tsx src/cli/index.ts report docs/report/campus.er.yaml
node_modules/.bin/tsx src/cli/index.ts report docs/report/campus.er.yaml --format html
```

Files: [model](report/campus.er.yaml), [requirements](report/campus.er.requirements.md),
[Markdown report](report/campus.report.md), [diagram](report/campus.report.svg),
[printable HTML report](report/campus.report.html).
