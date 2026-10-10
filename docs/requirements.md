# Requirements tab (design brief and file contract)

## Job

The student writes the requirements of a database task in plain sentences, one per line ("Every course is offered by
exactly one department"). With `chen serve --agent`, **Apply to model** sends the new and changed lines to the agent,
which builds or changes the ER model. Under each requirement the viewer then shows the model elements that implement
it, so the reasoning the teacher grades (requirements → entities → relationships → constraints) stays visible and
traceable.

## Start from requirements

```sh
chen init university.er.yaml --empty --title "University"
chen serve university.er.yaml --agent claude
```

The empty model has only the title, empty entities and relationships, and no notes. It lints and renders before
anything is added. Open **Requirements**, enter the task's sentences, then **Apply to model** to fill the model.
Use `--agent codex` instead if preferred. Omitting `--empty` keeps the example starter.

## Principles

- The viewer still never writes the model. It writes two files next to it: the layout file and
  `<model>.er.requirements.md`. The agent writes the model, as in any agent turn.
- The requirements file is plain Markdown that reads well in Obsidian and in a printed PDF. Machine state stays in
  HTML comments, which reading view and PDF export do not show.
- Apply processes only lines that are new or changed since their last apply; the whole list goes along as context.
- A requirement that no model element implements is marked, never by colour alone.

## File format

`club.er.yaml` → `club.er.requirements.md` (same naming as `*.er.layout.json` and `*.er.agent.json`). Unlike the
agent file it belongs in version control and in homework: it is the student's own text.

```markdown
# Requirements: University

<!-- chen-er requirements v1: one requirement per list item. The comment after each item keeps its id and trace for chen serve; leave it in place. -->

1. Every course is offered by exactly one department. <!-- chen-er {"id":"r1","applied":"0d065169","trace":["E:COURSE","E:DEPARTMENT","R:OFFERS"],"why":"COURSE takes part in OFFERS with 1..1."} -->
   *→ COURSE, DEPARTMENT, OFFERS. COURSE takes part in OFFERS with 1..1.*
2. Rooms have a capacity. <!-- chen-er {"id":"r2","applied":"5c1e07aa","trace":[]} -->
   *△ Not reflected in the model.*
3. A student enrolls in many courses. <!-- chen-er {"id":"r4"} -->
```

- Title: the first `# ` heading (default `Requirements: <model title>`, or `Requirements`).
- One ordered-list item per requirement; the numbers are the R-numbers the viewer shows (R1, R2, …).
- The trailing comment `<!-- chen-er {json} -->` holds the machine state:
  - `id`: stable id `r<n>`. Ids are never renumbered when a line is deleted, and the viewer never hands a deleted
    line's id to a new line in the same session. Displayed numbers are ordinal.
  - `applied`: FNV-1a (32-bit, 8 hex) hash of the whitespace-normalized text at its last apply. A line is **new**
    without it, **changed** when it differs from the current text's hash, otherwise **applied** or **not covered**.
  - `trace`: element ids (`E:`, `R:`, `A:`) that implement it, validated against the model; `[]` means not covered.
  - `why`: the agent's one-line rationale.
  - `<` and `>` inside the JSON are written as `<`/`>`, so the comment can never close early.
- Under an applied, unchanged line chen-er writes one italic line: `*→ <element names>. <why>*`, or
  `*△ Not reflected in the model. <why>*`. These generated lines are skipped when reading and rewritten on every save,
  so the PDF shows the trace without the comments.
- Hand edits are welcome: bullet items (`-`, `*`, `+`) and `1)` also count as requirements; indented continuation
  lines join their item; items without a valid, unique id get the next free id in order (so the same file always
  parses the same way). Prose before the list is kept as the intro, any other prose after it. `<!--` and `-->` inside a
  requirement are written as `&lt;!--` and `--&gt;`.
- Limits: 300 requirements, 1000 characters each, 1 MB per file. The file must be a regular file without links
  (no symlink, no hard link), like the layout file.

## Line state

| State | Shown as |
| --- | --- |
| new | `new`, graphite 12px |
| changed | `changed since the last apply`, graphite |
| applying | `Claude is applying this line…`, ink |
| applied | `→` and the element names as links, the rationale in graphite |
| not covered | red pencil `△ not covered`, with the reason or rationale |

The viewer checks traces against the current drawing: an element that was removed after the apply is shown
struck through in graphite, and a line whose elements are all gone counts as not covered. Not-covered lines also
appear in the Notes tab as info findings: "Requirement R4 is not reflected in the model." (rule
`requirement-not-covered`, viewer only; `chen lint` does not read the requirements file).

## Apply turn

`POST /api/agent/requirements/apply` with `{ expectedRevision? }` (agent route: needs the token, 404 without
`--agent`). The server reads the file, takes the non-empty lines that are new or changed, and starts one turn through
the normal agent runner (Claude or Codex, same session, same steps, cancel, change note and undo). `202 { turnId }`;
`409` when a turn is running, the revision moved on, or nothing is pending.

- Turn text: `Apply requirements R2, R4 to the model`. The turn carries
  `requirements: { ids, labels, hashes, trace?, noTrace?, before? }` and is stored in the thread file like any turn.
- Prompt (`buildRequirementsPrompt`): the model path; the usual rules (edit only that YAML file, keep comments, run the
  lint command and fix errors, never edit layout/agent/requirements files, no notes or logs elsewhere); never write
  coordinates; keep elements other requirements still need; the lines to apply as `r4 (R2): text  [new]` or
  `[changed; it was linked to …]`; all lines for context; a compact model format reference; the element id syntax;
  and the trace format below. The pre-approved Claude tools gain the read-only `mcp__chen-er__get_schema`.
- **Trace comes back in the final message**: one or two sentences, then a fenced block tagged `chen-trace`:

  ````
  ```chen-trace
  {"r4": {"elements": ["E:COURSE", "R:OFFERS"], "why": "one line"}, "r5": {"elements": [], "why": "why nothing"}}
  ```
  ````

  A final message is what both CLIs already return (Claude's `result`, Codex's last `agent_message`), it needs no
  extra file write inside the sandbox, and the agent cannot touch the requirements file. The server takes the last
  `chen-trace` block (or, failing that, the last JSON block), removes it from the reply shown in the Agent tab, and
  validates it: only ids that were applied count; every element id must exist in the model after the turn (a bare
  `COURSE` resolves to `E:COURSE` or `R:COURSE` when exactly one exists); unknown ids are dropped and listed as
  `dropped`; at most 50 elements; `why` is clipped to 300 characters.
- When the turn ends `ok` and the model parses, each applied line gets `applied` = its hash at the start of the turn,
  the validated trace (empty when the agent gave none, so it shows as not covered) and the rationale. A missing block
  sets `noTrace` and the viewer says so. A line edited while the turn ran therefore shows as changed afterwards.
  Errors, limits, cancels and a model that no longer parses leave the lines unapplied.
- **Undo agent change** on an apply turn also restores the previous state of its lines (`before`), unless a later
  apply rewrote that line.

## HTTP API

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/requirements` | | `RequirementsView` |
| PUT | `/api/requirements` | `{ items: [{ id, text }], expectedRevision }` | `200 RequirementsView`; `409` stale revision; `400`; `403` links |
| POST | `/api/agent/requirements/apply` | `{ expectedRevision? }` | `202 { turnId }`; `409`; agent route rules |

`RequirementsView = { file, exists, revision, title?, items: Requirement[], agent: "claude"|"codex"|null }`,
`Requirement = { id, text, applied?, trace?, why? }`.

- The file routes follow the layout routes' protection (local Host and Origin, JSON only), so the tab also works
  without `--agent`; Apply is then replaced by a sentence naming `--agent claude` / `--agent codex`.
- `revision` is the sha256 of the id/text list only. The client owns ids and texts; applied hashes, traces and prose
  always merge server-side from the current file by id. So an apply finishing while the student types never
  conflicts, while an outside edit of the texts (Obsidian, an editor) does: the PUT answers 409 and the tab offers
  **Load the file** or **Keep these lines** (re-read the revision, then write the lines over the file's texts).
- Writes are serialized with the server's other writes and atomic: a temp file in the same directory, a recheck,
  then rename (`replaceBytes`). Saving an empty list creates no file.
- The server watches the file (fs.watch plus the stat poll) and sends `event: requirements` with the view on
  `/api/events` after its own writes and outside edits. It never triggers a re-layout.

## Editor (viewer)

Pure logic in `src/viewer/requirements-logic.ts`, DOM in `src/viewer/requirements.ts`.

- One auto-growing, single-line textarea per requirement, numbered R1, R2… (12px mono graphite). The list always ends
  with one empty line whose placeholder is the next requirement.
- Enter on a non-empty line splits at the caret into a new line below (or moves to the empty line below when the
  caret is at the end); Enter on an empty line does nothing; Shift+Enter behaves like Enter (no line breaks).
- Backspace on an empty line deletes it and moves to the end of the previous line; Backspace at the start of a line
  joins it to the previous one; Delete at the end joins the next.
- ArrowUp/ArrowDown move between lines (keeping the column on one-row lines; on wrapped lines only from the first or
  last row edge).
- A multi-line paste becomes several lines; list markers (`-`, `1.`, `R3:`) and blank lines are dropped.
- Autosave 600 ms after the last edit; one save at a time; a `requirements` event that arrives during a save waits
  for its answer. Apply saves first.
