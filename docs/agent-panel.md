# Agent panel (design brief and API contract)

Status: phase 1 (Claude backend + working panel). Codex backend and visual polish follow.

## Job

A student reviewing a diagram in `chen serve` asks for model changes in plain language without leaving the
viewer. The request runs a local coding agent (Claude Code headless, later Codex) that edits the YAML model; the
diagram updates through the existing live reload. Mode: Operate. The diagram stays the task; the panel is a quiet
helper in the notebook margin.

## Principles

- The viewer still never writes the model itself. The agent writes the model. The only server-side model write is
  **Undo agent change**, an explicit user action that restores the snapshot taken before that agent turn.
- The agent never writes the layout file (pins/positions stay the human's).
- No API keys: the server runs the user's installed, logged-in CLI (`claude -p`).
- The panel exists only when `chen serve` is started with `--agent`.

## CLI

```
chen serve model.er.yaml --agent claude [--agent-cwd <dir>]
```

- `--agent claude` enables the panel (phase 1 supports only `claude`; `codex` is reserved and rejected with a clear
  message until phase 2).
- `--agent-cwd` is the agent's working directory (default: the model's directory). Users who keep project memory
  elsewhere (for example a notes vault with its own agent instructions) point it there. The model's directory is
  always added with `--add-dir`.
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

- Command (overridable for tests with env `CHEN_AGENT_BIN`, default `claude`):
  `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits --add-dir <modelDir>
  [--resume <sessionId>]`, cwd = `--agent-cwd`.
- The session id comes from the stream (`session_id` field of the init/result events) and is reused with
  `--resume` for the next turn, so the conversation continues. Kept in memory for the server's lifetime.
- Prompt = short fixed preamble + user text. Preamble (English, terse): the absolute model path; the selected
  elements as `id (label)` lines; rules: edit only that YAML file; keep comments and formatting; run
  `<chen lint command> <model path>` after editing and fix errors; never edit `*.er.layout.json`; reply with one
  or two plain sentences describing what changed. `<chen lint command>` is how this server itself was started
  (e.g. `node <repo>/bin/chen.js` or `npx tsx <repo>/src/cli/index.ts`).
- One turn at a time. Cancel kills the child process (SIGTERM, then SIGKILL after 3 s).
- Exit/limit handling: non-zero exit -> `error` with the last 20 lines of stderr; output mentioning a usage limit
  -> status `limit`.

## Snapshot and undo

- Before a turn starts, the server stores the model file bytes (snapshot) for that turn id.
- After the turn ends, the server stores the post-turn bytes and computes the change set (below).
- `Undo agent change` for turn T is allowed only if T is the most recent turn that changed the model and the
  current model bytes equal T's post-turn bytes; it then writes the snapshot atomically (temp file + rename) and
  reports `undone`. Otherwise 409 with a reason ("the model changed after this turn").
- History is in memory (cleared on restart).

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
reply?: string, steps: Step[], changes?: { added, removed, modified, parseError? }, error?: string }`,
`Step = { kind: "tool"|"text", summary: string }` (tool steps summarized as e.g. `Edit university.er.yaml`).

## Events (existing SSE channel `/api/events`)

New event names, payload = the full `Turn` object:
`agent-turn` (sent on start, on each new step, and on finish). The existing `state` event still drives the
diagram after the agent writes the file. `/api/events` itself stays unauthenticated (it already serves the
diagram), but agent events are only emitted when the panel is enabled.

## Panel (viewer)

- Notes column gets two tabs: **Notes** (existing findings) and **Agent**. Tabs are hidden without `--agent`.
  At <= 900 px the tabs live in the existing bottom drawer.
- Thread written like pencil notes in the margin: user lines in ink, agent lines in graphite; no bubbles, avatars,
  color blocks or gradients. Each finished turn ends with a change note: `+ BirthDate (STUDENT)`, `~ ENROLLS`,
  `- HAS`, each a link that selects/focuses the element on the drawing, plus **Undo** when allowed.
- Context chips above the input show the current diagram selection (`▸ STUDENT`), removable with ×; the selection
  is sent with the request.
- Running state: one line `Claude is working… 12 s` with a Cancel button; tool steps folded under a disclosure.
- After a turn, changed elements get the existing selection-style halo for ~3 s (screen only; never in exports;
  none with prefers-reduced-motion beyond a static mark).
- Empty state: one sentence and three example requests that fill the input when clicked
  (`Add a BirthDate attribute to the selected entity`, `Make ENROLLS one-to-many`, `Explain the heuristic findings`).
- Errors: CLI not found / not logged in -> what to run (`claude` then `/login`); limit -> say the agent hit its usage
  limit; error -> short message + stderr excerpt in a disclosure.
- Keyboard: `/` focuses the input (when focus is not in a text field), Enter sends, Shift+Enter newline, Escape
  cancels a running turn. Tabs are a proper tablist.
- Follow DESIGN.md tokens (sheet, ink, graphite, rules, 13px system-ui, 28px buttons, 4px radius). Nothing new in
  exports.
