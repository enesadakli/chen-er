# chen-er 0.4.0

From requirements to a submitted model. Write the requirements as a numbered
list, let Claude Code or Codex turn them into the diagram, check which element
implements which requirement, then export the relational schema and a method
report for the assignment.

The npm package is now **`chen-erd`**: `npm install -g chen-erd` provides the
`chen` command, `npx chen-erd render model.er.yaml` runs it once, and
`npx -y -p chen-erd chen-er-mcp` starts the MCP server. The name `chen-er` on
npm belongs to an unrelated package; the project keeps its name.

- **Requirements tab** in `chen serve`: one requirement per line, saved next to
  the model as `<model>.er.requirements.md`. **Apply to model** sends only new
  and changed lines to the agent and shows under each line the elements that
  implement it. Lines nothing implements are marked as not covered.
- **Agent panel** (`--agent claude` or `--agent codex`): change the model in
  plain language; the panel streams the agent's steps, lints the result, shows
  what changed and undoes a turn. The conversation survives a server restart.
- **`chen map`**: ER-to-relational mapping following the course steps 1–7 and
  8A, with a reason for every table, key and foreign key; text, Markdown, SQL
  or JSON. MCP tool `map_er`.
- **`chen report`**: a method report in Markdown or one printable HTML file —
  requirements and their status, the diagram, entity and relationship tables,
  untraced elements, lint findings and the relational schema. MCP tool
  `report_er`.
- **Viewer**: diagram focus, endless graph paper, a quieter grouped header,
  automatic re-layout when the model grows (pins kept, never accepted if any
  hard geometry metric gets worse), and attribute pins that follow their
  owner.
- **Faster large models**: a 26-entity, 36-relationship model lays out in about
  2 seconds instead of 20; drawings of models up to 12 entities are unchanged.

## Measured

`bench/agent-eval` runs one requirements apply per scenario through the same
code path as the viewer and scores the model against a reference (entities,
relationships, attributes, keys, (min,max) and explicit modelling decisions
such as weak entities, ternary relationships and multivalued attributes). On
12 course-level scenarios, 6 of them written as plain homework prose without
ER terms, Claude Code and Codex both matched the reference on every scenario
and every decision check (one run each, 2026-10-10). The set is too small to
separate the two agents; larger scenarios are planned.

## Known limitations

- Large models are still hard to read in one figure; subject-area diagrams are
  planned.
- The requirements tab does not remove model elements when a requirement is
  deleted.

## Upgrade notes

- Install from npm as `chen-erd`. MCP client configs that ran the server from a
  source checkout keep working.
- Old absolute attribute pins are read as before and rewritten as offsets from
  their owner on the next layout save.
