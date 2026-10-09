# chen-er

Agent-first Chen ER diagrams. You (or an agent) write the model in YAML; chen-er lays it out,
draws it in Chen notation with (min,max) participation labels, and lints it against ER rules.

```yaml
version: 1
entities:
  BOOK: {attrs: [ISBN, Title], keys: [[ISBN]]}
  COPY: {weak: true, attrs: [CopyNo], partialKey: [CopyNo]}
relationships:
  COPY_OF:
    identifies: COPY
    ends: [{entity: BOOK, card: 0..N}, {entity: COPY, card: 1..1}]
```

```sh
npx tsx src/cli/index.ts render examples/library.er.yaml --png
```

Status: early development (v0.1). See `AGENTS.md` for the architecture and contracts.
