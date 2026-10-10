# Requirements → model evaluation

Six course-level scenarios evaluate one fresh Requirements Apply against a reference Chen ER model. Five use English; `turkish-labels` uses Turkish and Unicode identifiers. The handwritten requirements follow [the Requirements file contract](../../docs/requirements.md) and contain no applied state. Gold models parse and have zero lint errors.

## Run manually

From the checkout, with dependencies already installed and the selected CLI logged in:

```sh
node_modules/.bin/tsx bench/agent-eval/run.ts --help
node_modules/.bin/tsx bench/agent-eval/run.ts --agent claude
node_modules/.bin/tsx bench/agent-eval/run.ts --agent codex --scenario hospital --scenario company --runs 3 --out /tmp/chen-eval
```

The runner calls real CLIs and can consume their subscription allowance. It is never invoked by the test suite or CI. It supplies no API keys and refuses the common API-key environment variables; authenticate with each CLI's own login. A failed or limited attempt is recorded once, without a benchmark retry. The production CLI arguments retain each CLI's own internal retry behavior.

Each attempt gets a new temporary directory containing `model.er.requirements.md` and a model created with `initFile(..., {empty: true})`, exactly as `chen init --empty`. `createRequirements().plan()` calls the production `buildRequirementsPrompt`; `claudeArgs` or `codexArgs` and `lintCommandFor` construct the production command; `runAgent` runs one turn; the plan's `settle` validates requirement and element ids, extracts the trace, and atomically writes applied state. No gold model or aliases are copied into the temporary workspace. The CLI's working directory is that workspace, and no previous session is resumed.

The default output is `bench/agent-eval/results/<UTC date-time>/`, ignored by the adjacent `.gitignore`. Existing attempt directories are refused. Temporary workspaces are removed after artifact capture. SIGINT/SIGTERM cancels the active turn, saves it and stops the batch.

Each `<agent>-<scenario>-<run>/` contains:

- `prompt.txt`: the exact production prompt (when planning succeeds).
- `reply.txt`: the original final reply, including its trace block.
- `model.er.yaml` and `model.er.requirements.md`: final file contents.
- `score.json`: the scorer report, or `null` for an unparseable model.
- `run.json`: status, CLI status, start/finish timestamps, wall time in milliseconds, numeric usage fields, session id, parse diagnostics, errors and score.
- `turn.json`: the settled production turn, with validated trace metadata; `null` if setup failed before planning.

Usage is captured from the CLI's terminal JSON events while delegating stream parsing to the production parser. Numeric leaves under `usage`/`modelUsage` and exposed cost, duration and turn-count fields are retained with their original dotted paths. Missing usage is `null`; no estimates are made and credentials are never recorded. CLI-success with an unparseable final model becomes evaluation `error`, while `cliStatus` remains `ok`. A trace settlement failure is recorded separately, matching the viewer's behavior of preserving the CLI outcome.

`summary.md` is updated after every attempt. Its metric columns are arithmetic means over **all attempted runs**, with failed/limited/cancelled/unparseable attempts contributing zero. A valid partial model from a failed attempt still has an individual score for inspection. Time is the mean wall time over all attempts. The runs column shows successful/attempted counts. Exit status is 0 for a successful batch, 1 for any failed attempt/setup error, and 130 after interruption.

The runner directly drives the requirements controller and process runner. It does not instantiate the viewer's HTTP routes, event transport, `createAgent` undo/history/change measurement, or layout-write restoration. Those are the integration gaps; prompt construction, CLI arguments, parsing, trace validation and requirements writes are shared production code. CLI user configuration, default model/version and production prompt changes can change results; keep those fixed when comparing batches. This is a repeatable procedure, not a guarantee of identical stochastic replies.

## Score

`score.ts` is pure and browser-safe. Exported APIs:

```ts
scoreModels(gold: NModel, candidate: NModel, aliases?: Aliases,
            requirements?: RequirementsDoc | string): ScoreReport
normalizeName(name: string): string
precisionRecallF1(gold: number, candidate: number, matched: number): PRF
```

Pass models normalized with `parseModel` from `src/core/normalize.ts`; parse failures are a runner concern. Input objects are never mutated. The JSON report provides counts, matches, unmatched gold ids, extra candidate ids, key/property mistakes, degree errors and incorrect cardinalities with expected and actual `(min,max)` values.

Matching is deterministic:

1. Names are Unicode-normalized, case-insensitive and underscore/whitespace-insensitive. Accents remain significant. Entity matching traverses gold ids lexically and greedily selects a unique candidate, preferring normalized equality to an alias, then lexical candidate id.
2. Relationships require an equal **multiset** of matched participant entities, preserving repeated recursive participants. Names do not gate matching. Within that participant set, name/alias agreement wins, followed by recursive attribute-name overlap, then lexical id.
3. Attributes match only within matched owners and matched composite parents, by name/alias. Every composite parent and every nested part counts as one attribute. Moving parts to top level does not match them. Derived/multivalued flags are assessed in `attributeProperties`, separately from attribute-name F1.
4. Ends pair by matched entity. Recursive ends prefer equal roles, then equal stable id suffixes, then candidate end index. Cardinality values never influence pairing. Renamed roles and ids therefore fall back to order; the metric cannot infer their meaning.

Optional `aliases.json` maps a **gold** name to acceptable candidate names:

```json
{
  "entities": {"EMPLOYEE": ["STAFF", "WORKER"]},
  "relationships": {"WORKS_FOR": ["EMPLOYED_BY"]},
  "attributes": {"EMPLOYEE.EmployeeId": ["StaffId"], "Hours": ["WeeklyHours"]}
}
```

Attribute alias keys may be bare names, owner-qualified paths (including composite parts), or full `A:` ids. Alias values are candidate attribute names at that level. Scoped keys reduce ambiguity; aliases never cross owners or parents. Entity/relationship keys and all aliases use the same normalization. Aliases are one-way gold-to-candidate declarations.

For entities, relationships and attributes:

```text
precision = matched / candidate count
recall    = matched / gold count
F1        = 2 × matched / (gold count + candidate count)
```

An empty denominator yields 1; an empty candidate against a nonempty gold still has F1 0.

`keys.accuracy` gives one check to every gold entity and every gold relationship:

- A strong entity passes when its weak flag is false and its entire set of candidate-key attribute sets equals the gold, independent of key/component order and after attribute matching.
- A weak entity passes when the weak flag and partial-key attribute set both agree.
- A relationship passes when the identifying flag **and its matched target** agree, including agreement that neither identifies anything.

The report also separates strong-key, weak-entity and identifying accuracies. Unmatched gold entities/relationships fail their checks. Extra candidate objects affect precision but add no accuracy checks. `correct`, `total` and `evaluated` distinguish successful checks, all gold checks and checks on matched items.

`cardinality.accuracy` is exact-end accuracy: the number of matched ends with equal normalized `(min,max)` divided by **all gold ends**. Ends in unmatched relationships count as incorrect. Numeric finite maxima are compared exactly; normalized `N`, `M` and `*` are equivalent. Both minima and maxima must agree.

Degree errors are diagnostic possible replacements: an unmatched relationship of different degree is listed if its matched participants form a multiset subset/superset of an unmatched gold relationship, and one side is binary (or their names/aliases agree). Thus a ternary split into differently named binaries is visible and cannot earn a relationship match. These errors are evidence to inspect, not a proof of intent.

`structure.lintErrorCount` counts production lint diagnostics of severity `error`. `trace.coverage` is the fraction of requirements containing at least one trace id live in the candidate, or `null` when no requirements are supplied. It measures linkage, not whether the rationale or linked elements correctly implement the requirement. Derived/multivalued property accuracy, lint and trace are supplementary metrics.

The requested overall formula is:

```text
overall = (entity F1 + relationship F1 + attribute F1
           + key accuracy + cardinality accuracy) / 5
```

This formula intentionally excludes property flags, structure and trace. A high overall score alone does not prove full requirement correctness; inspect those supplementary metrics and details as well. Notes, display labels, attribute types, ordering constraints and equivalent alternative conceptual models are outside matching. In particular, these golds choose weak sections, relationship-based current loans, and entity-based reservations explicitly in their requirements.

## Add a scenario

1. Create `scenarios/<name>/requirements.md`: 6–14 numbered lines, one testable modeling fact per line, with both ends' participation limits stated in words. Include explicit keys, weak ownership/partial keys, role names for recursion, and attribute structure where needed. Use the format in `docs/requirements.md`; omit applied hashes and traces.
2. Add `gold.er.yaml`, reflecting every line. Validate it with `node_modules/.bin/tsx src/cli/index.ts lint <gold>` and require zero errors.
3. Optionally add reviewed aliases. Keep synonyms narrow enough that different concepts cannot merge.
4. Update the intentional six-scenario roster and self-score cases in the tests when expanding the set.
5. Run `npx tsc --noEmit` and `npx vitest run`. `bench` is already included in this checkout's TypeScript configuration. No package script or dependency change is needed.

Only the scorer and scenario validation are tested. The runner is never executed against agents in tests.
