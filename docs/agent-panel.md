# Agent panel (design brief and API contract)

Status: phase 2 (Claude and Codex backends, thread kept across server restarts).

## Job

A student reviewing a diagram in `chen serve` asks for model changes in plain language without leaving the
viewer. The request runs a local coding agent (Claude Code or the Codex CLI, headless) that edits the YAML model; the
diagram updates through the existing live reload. Mode: Operate. The diagram stays the task; the panel is a quiet
helper in the notebook margin.

## Principles

- The viewer still never writes the model itself. The agent writes the model. The only server-side model write is
  **Undo agent change**, an explicit user action that restores the snapshot taken before that agent turn.
- The agent never writes the layout file (pins/positions stay the human's).
- No API keys: the server runs the user's installed, logged-in CLI (`claude -p` or `codex exec`).
- The panel exists only when `chen serve` is started with `--agent`.

## CLI

```
chen serve model.er.yaml --agent claude|codex [--agent-cwd <dir>]
```

- `--agent claude` or `--agent codex` enables the panel with that CLI. Any other value is a usage error.
- `--agent-cwd` is the agent's working directory (default: the model's directory). Users who keep project memory
  elsewhere (for example a notes vault with its own agent instructions) point it there. The model's directory is
  always added with `--add-dir` (both CLIs).
- On start with `--agent`, the server prints the viewer URL including a one-time token:
  `http://127.0.0.1:<port>/?t=<token>`; `--open` opens that URL.

## Security

- Bind to 127.0.0.1 only (already the case).
- Token: 32 random bytes (base64url) generated at server start. The page reads `t` from its URL once, keeps it in
  `sessionStorage`, and removes it from the address bar with `history.replaceState`.
- Every `/api/agent/*` request must carry header `X-Chen-Token: <token>` and, when an `Origin` header is present, it
  must equal `http://127.0.0.1:<port>` or `http://localhost:<port>`. The `Host` header must be `127.0.0.1:<port>`
  or `localhost:<port>`. Otherwise respond 403 without detail.
- Agent routes return 404 when the server runs without `--agent`.

## Agent invocation (claude)

- Command (overridable for tests with env `CHEN_AGENT_BIN`, default `claude`; the same variable overrides `codex`):
  `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits
  --allowedTools 'Bash(<chen lint command>:*)' mcp__chen-er__lint_er mcp__chen-er__render_er mcp__chen-er__get_schema
  --add-dir <modelDir>
  [--resume <sessionId>]`, cwd = `--agent-cwd`. The child inherits the server's environment variables.
- `acceptEdits` covers file edits only; without `--allowedTools` a headless turn stalls waiting for permission to
  run the lint command or the chen-er MCP tools. The pre-approved set is exactly what the prompt asks for: the
  lint command (same string as in the prompt, any trailing arguments) and the chen-er MCP `lint_er`/`render_er`, plus
  the read-only `get_schema`.
- The session id comes from the stream (`session_id` field of the init/result events) and is reused with
  `--resume` for the next turn, so the conversation continues. It is stored with the thread (see Persistence).
- Prompt = short fixed preamble + user text. Preamble (English, terse): the absolute model path; the selected
  elements as `id (label)` lines; rules: edit only that YAML file; keep comments and formatting; run
  `<chen lint command> <model path>` after editing and fix errors; never edit `*.er.layout.json`; do not create or
  update notes, memory, receipts or logs outside the model file; never edit `*.er.layout.json`, `*.er.agent.json` or
  `*.er.requirements.md`;
  reply with one or two plain sentences describing what changed. `<chen lint command>` is how this server itself was
  started (e.g. `node <repo>/bin/chen.js`, or for a source checkout `<repo>/node_modules/.bin/tsx
  <repo>/src/cli/index.ts`, falling back to `npx tsx` when the checkout has no tsx; `npx` would otherwise try the
  network from another directory, which the Codex sandbox does not have). Both backends get the same prompt.
- One turn at a time. Cancel kills the child process (SIGTERM, then SIGKILL after 3 s).
- Exit/limit handling: non-zero exit -> `error` with the last 20 lines of stderr; output mentioning a usage limit
  -> status `limit`. `errorKind` classifies the cause: `not-found` (spawn ENOENT), `not-logged-in` (stderr or result
  mentions `/login`, "not logged in", "Invalid API key" or "authentication"), `limit`, otherwise `other`.

## Agent invocation (codex)

- Command (`codex-cli` 0.160; `CHEN_AGENT_BIN` overrides `codex`), cwd = `--agent-cwd`, stdin closed:
  `codex exec --json --sandbox workspace-write --cd <agent cwd> --add-dir <modelDir> --skip-git-repo-check <prompt>`;
  later turns: `codex exec --json --sandbox workspace-write --cd <agent cwd> --add-dir <modelDir>
  --skip-git-repo-check resume <threadId> <prompt>`. `resume` does not accept `--sandbox`/`--cd`, so the exec-level
  options come before the subcommand.
- Why: `--json` streams thread events as JSONL. `workspace-write` lets the agent write only inside the working
  directory and `--add-dir` directories, and run commands without network; `codex exec` never asks for approval,
  so a headless turn cannot stall on a permission prompt (a command the sandbox denies simply fails and the agent
  sees the error). `--skip-git-repo-check` allows model folders outside a git repository. With an open stdin pipe
  codex waits for more prompt input, so the server spawns it with stdin ignored. The user's `~/.codex/config.toml`
  (model, MCP servers such as chen-er) still applies.
- Events → steps: `thread.started.thread_id` is the session id. Tool items become a step when first seen
  (`item.started`, or `item.completed` if no start was seen), once per item id: `command_execution` →
  `Shell <first word of the command inside the shell wrapper>`, `file_change` → `Edit|Create|Delete <file names>`,
  `mcp_tool_call` → `mcp__<server>__<tool>`, `web_search` → `Web search`, an `error` item → a text step.
  `agent_message` items become a text step when completed; the last one is the reply. `reasoning` and `todo_list`
  are not shown. A top-level `error` or `turn.failed` marks the result as an error with its message;
  `turn.completed` clears it again (retried stream errors arrive as `error` events too).
- Error classification is shared with Claude: spawn ENOENT → `not-found` ("Install the Codex CLI, then run
  `codex login`"); `not-logged-in` also matches `codex login` and "Unauthorized"; "usage limit" / "hit your
  limit" → `limit`; otherwise `other` with the stderr tail (codex writes "Reading additional input from stdin..."
  and MCP startup noise to stderr; only a failed turn shows it).

## Snapshot and undo

Structural model changes automatically compare incremental and fresh layouts after the turn finishes, keep all pins, and offer header/status Undo when fresh wins (decision rule: DESIGN.md).

- Before a turn starts, the server stores the model file bytes (snapshot) for that turn id.
- After the turn ends, the server stores the post-turn bytes and computes the change set (below).
- `Undo agent change` for turn T is allowed only if T is the most recent turn that changed the model and the
  current model bytes equal T's post-turn bytes; it then writes the snapshot atomically (temp file + rename) and
  reports `undone`. Otherwise 409 with a reason ("the model changed after this turn").
- The comparison uses sha256 revisions of the bytes, so it works the same after a restart.

## Persistence

- File: `<model>.er.agent.json` next to the model, named like the layout file (`club.er.yaml` →
  `club.er.agent.json`). It belongs in `.gitignore` (`*.er.agent.json`). The server's file watcher ignores it.
- Written after every turn state change (start, each step, finish, undo) atomically: a private (0600) temp file in
  the same directory, then rename. A write failure is reported once on stderr and does not stop the turn.
  The programmatic `serve()` option `agent.persist: false` keeps the thread in memory only (the CLI always persists).
- Format (JSON, `version: 1`): `{ version, model: <absolute model path>, kind: "claude"|"codex", sessionId?,
  entries: [{ turn: Turn, beforeRevision, afterRevision?, before? }] }`. Revisions are sha256 hex of the model
  bytes (or `absent`). `before` (base64, or null when there was no model file) is kept only for the latest
  model-changing turn and for a running turn; older snapshots are dropped. The URL token is never stored.
- On start the server loads the file only when it is a regular file, parses as this format, and its `model` and
  `kind` equal the current model path and `--agent`; otherwise the thread starts empty and the file is replaced at
  the next request. The stored session id is used for `--resume` / `resume`, and turn ids continue after the
  highest stored `t<n>`.
- A turn stored as `running` (the process died mid-turn) becomes `cancelled` with `notice`: "The server stopped
  while this request was running, so it was cancelled. Changes are measured against the model as found at
  restart." Its change set compares the stored snapshot with the model file at restart, so it can be undone while
  the file stays as found. A graceful stop (Ctrl+C) cancels the running turn normally before exit.
- Undo after a restart follows the same rules as before: latest model-changing turn only, and only while the model
  bytes match that turn's after revision.

## Change set

Compare the normalized models before and after the turn by stable node ids (`E:`, `R:`, `A:`), reporting
`added`, `removed`, `modified` id lists (modified = same id, different attributes/cardinalities/flags/labels).
If either side fails to parse, report `parseError: true` and empty lists.

## HTTP API (all JSON; all require the token)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/agent` | | `{ enabled, kind, cwd, running: turnId or null, turns: Turn[] }` |
| POST | `/api/agent/turns` | `{ text: string (1..4000), selection: string[] (node ids, max 20) }` | `202 { turnId }`; `409` if a turn is running |
| POST | `/api/agent/turns/:id/cancel` | | `200 { status }` |
| POST | `/api/agent/turns/:id/undo` | | `200 { status: "undone" }` or `409 { error }` |

`Turn = { id, text, selection, startedAt, finishedAt?, status: "running"|"ok"|"error"|"cancelled"|"limit"|"undone",
reply?: string, steps: Step[], changes?: { added, removed, modified, parseError? }, error?: string,
errorKind?: "not-found"|"not-logged-in"|"limit"|"other", notice?: string }` (`errorKind` only on `error`/`limit` turns;
`notice` when the server ended the turn itself, shown instead of "Cancelled."),
`Step = { kind: "tool"|"text", summary: string }` (tool steps summarized as e.g. `Edit university.er.yaml`).

## Events (existing SSE channel `/api/events`)

New event names, payload = the full `Turn` object:
`agent-turn` (sent on start, on each new step, and on finish). The existing `state` event still drives the
diagram after the agent writes the file. `/api/events` itself stays unauthenticated (it already serves the
diagram), but agent events are only emitted when the panel is enabled.

## Panel (viewer)

- Notes column tabs: **Notes** (existing findings), **Requirements** (docs/requirements.md) and **Agent**. The Agent tab
  is hidden without `--agent`. Requirements apply turns (`POST /api/agent/requirements/apply`) appear in the thread like
  any other turn, with the same change note and undo.
  At <= 900 px the tabs live in the existing bottom drawer.
- Thread written like pencil notes in the margin: user lines in ink, agent lines in graphite; no bubbles, avatars,
  color blocks or gradients. Each finished turn ends with a change note: `+ BirthDate (STUDENT)`, `~ ENROLLS`,
  `- HAS`, each a link that selects/focuses the element on the drawing, plus **Undo** when allowed.
- Context chips above the input show the current diagram selection (`▸ STUDENT`), removable with ×; the selection
  is sent with the request.
- Running state: one line `Claude is working… 12 s` (`Codex is working…` with `--agent codex`) with a Cancel
  button; tool steps folded under a disclosure. All agent names in the panel come from `kind`.
- After a turn, changed elements get the existing selection-style halo for ~3 s (screen only; never in exports;
  none with prefers-reduced-motion beyond a static mark).
- Empty state: one sentence and three example requests that fill the input when clicked
  (`Add a BirthDate attribute to the selected entity`, `Make ENROLLS one-to-many`, `Explain the heuristic findings`).
- Errors: CLI not found / not logged in -> what to run (`claude` then `/login`; `codex login` for Codex); limit -> say the agent hit its usage
  limit; error -> short message + stderr excerpt in a disclosure. The panel decides by `errorKind`; text heuristics
  on `error` are only a fallback for turns without it.
- Keyboard: `/` focuses the input (when focus is not in a text field), Enter sends, Shift+Enter newline, Escape
  cancels a running turn. Tabs are a proper tablist.
- Follow DESIGN.md tokens (sheet, ink, graphite, rules, 13px system-ui, 28px buttons, 4px radius). Nothing new in
  exports.
