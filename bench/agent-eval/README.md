# Requirements → model evaluation

Two sets of six course-level scenarios evaluate one fresh Requirements Apply against reference Chen ER models. The original **explicit** set names the modeling choices; the **natural** set uses homework prose and checks the decisions an agent must infer. Natural scenarios cover a vet clinic, project supplies, course sections, car rental, orders (`n-siparis`) and a library network (`n-kutuphane-agi`). The last two use Turkish; the other four use English. The handwritten requirements follow [the Requirements file contract](../../docs/requirements.md) and contain no applied state. Every gold variant parses and has zero lint errors.

An optional `scenario.json` declares `{"set": "explicit" | "natural", "language": "en" | "tr"}`. Missing metadata means explicit/en, including the unchanged original scenarios. Language is recorded metadata, not a translation step.

## Run manually

From the checkout, with dependencies already installed and the selected CLI logged in:

```sh
node_modules/.bin/tsx bench/agent-eval/run.ts --help
node_modules/.bin/tsx bench/agent-eval/run.ts --agent claude --set natural
node_modules/.bin/tsx bench/agent-eval/run.ts --agent codex --scenario hospital --scenario company --runs 3 --out /tmp/chen-eval
```

`--set explicit|natural|all` defaults to `all` and intersects with any repeated `--scenario` selections. An unknown set or empty intersection fails before invoking a CLI.

The runner calls real CLIs and can consume their subscription allowance. It is never invoked by the test suite or CI. It supplies no API keys and refuses the common API-key environment variables; authenticate with each CLI's own login. A failed or limited attempt is recorded once, without a benchmark retry. The production CLI arguments retain each CLI's own internal retry behavior.

Each attempt gets a new temporary directory containing `model.er.requirements.md` and a model created with `initFile(..., {empty: true})`, exactly as `chen init --empty`. `createRequirements().plan()` calls the production `buildRequirementsPrompt`; `claudeArgs` or `codexArgs` and `lintCommandFor` construct the production command; `runAgent` runs one turn; the plan's `settle` validates requirement and element ids, extracts the trace, and atomically writes applied state. No gold models, metadata, decision checks or aliases are copied into the temporary workspace. The CLI's working directory is that workspace, and no previous session is resumed.

The default output is `bench/agent-eval/results/<UTC date-time>/`, ignored by the adjacent `.gitignore`. Existing attempt directories are refused. Temporary workspaces are removed after artifact capture. SIGINT/SIGTERM cancels the active turn, saves it and stops the batch.

Each `<agent>-<scenario>-<run>/` contains:

- `prompt.txt`: the exact production prompt (when planning succeeds).
- `reply.txt`: the original final reply, including its trace block.
- `model.er.yaml` and `model.er.requirements.md`: final file contents.
- `score.json`: the scorer report, or `null` for an unparseable model.
- `run.json`: scenario set/language, whether checks exist, status, CLI status, start/finish timestamps, wall time in milliseconds, numeric usage fields, session id, parse diagnostics, errors and score.
- `turn.json`: the settled production turn, with validated trace metadata; `null` if setup failed before planning.

Usage is captured from the CLI's terminal JSON events while delegating stream parsing to the production parser. Numeric leaves under `usage`/`modelUsage` and exposed cost, duration and turn-count fields are retained with their original dotted paths. Missing usage is `null`; no estimates are made and credentials are never recorded. CLI-success with an unparseable final model becomes evaluation `error`, while `cliStatus` remains `ok`. A trace settlement failure is recorded separately, matching the viewer's behavior of preserving the CLI outcome.

`summary.md` is updated after every attempt. Its metric columns are arithmetic means over **all attempted runs**, with failed/limited/cancelled/unparseable attempts contributing zero. A valid partial model from a failed attempt still has an individual score for inspection. Time is the mean wall time over all attempts. The runs column shows successful/attempted counts. `Set` identifies the scenario set; `Variant` is the most common selected gold variant among parseable attempts, breaking ties by primary then lexical variant name (or `—` if none). `Decisions` is mean decision accuracy with the same zero contribution for failed attempts, or `—` when the scenario has no checks. A second table lists every failed decision check per run, including checks from parseable failed attempts, with scenario, run, check id, kind and reason. Exit status is 0 for a successful batch, 1 for any failed attempt/setup error, and 130 after interruption.

The runner directly drives the requirements controller and process runner. It does not instantiate the viewer's HTTP routes, event transport, `createAgent` undo/history/change measurement, or layout-write restoration. Those are the integration gaps; prompt construction, CLI arguments, parsing, trace validation and requirements writes are shared production code. CLI user configuration, default model/version and production prompt changes can change results; keep those fixed when comparing batches. This is a repeatable procedure, not a guarantee of identical stochastic replies.

## Score

`score.ts` is pure and browser-safe. Exported APIs:

```ts
scoreModels(gold: NModel, candidate: NModel, aliases?: Aliases,
            requirements?: RequirementsDoc | string, checks?: ChecksDocument,
            goldVariant?: GoldVariantName): ScoreReport
scoreVariants(variants: readonly GoldVariant[], candidate: NModel, aliases?: Aliases,
              requirements?: RequirementsDoc | string, checks?: ChecksDocument): ScoreReport
normalizeName(name: string): string
precisionRecallF1(gold: number, candidate: number, matched: number): PRF
```

Pass models normalized with `parseModel` from `src/core/normalize.ts`; parse failures are a runner concern. Input objects are never mutated. The JSON report provides counts, matches, unmatched gold ids, extra candidate ids, key/property mistakes, degree errors and incorrect cardinalities with expected and actual `(min,max)` values.

Matching is deterministic. Matching names use NFKD, remove combining marks, fold Turkish dotted/dotless I to `i`, lowercase and ignore spaces, underscores and hyphens. Display names and model ids remain unchanged.

1. Entities first match by case/separator-insensitive name, alias, then folded-name equality, before any structural fallback. Name pairs are consumed greedily by pass, descending folded common-prefix length, gold id, then candidate id. For remaining entities, flattened folded attribute-name sets use gold attribute aliases. A structural pair qualifies with Jaccard similarity ≥ 0.5 and at least two shared names, or with an equal nonempty key attribute-name set (including partial keys). Qualifying pairs are consumed greedily by descending Jaccard, then gold id, then candidate id. Empty keys cannot create a match. Each entity match records `matchedBy: "name" | "alias" | "folded" | "structure"`. Similar generic attributes can produce ambiguous structural matches; this fallback is evidence of similarity, not proof of equivalence.
2. Relationships require an equal **multiset** of matched participant entities, preserving repeated recursive participants. Names do not gate matching. Within that participant set, name, alias and folded-name agreement win in that order, followed by recursive attribute-match overlap, then lexical id. Folded names never bypass the participant condition.
3. Attributes match only within matched owners and matched composite parents, in these passes: name, alias, folded-name equality, key role, then tokens. After folded equality, key role matches only when each side has exactly one unmatched attribute marked as a key or partial key. Token matching requires equal multivalued flags (derived is ignored) and a shorter folded name of at least three characters. It accepts a whole-name prefix/suffix (`Telefon`/`Telefonlar`, `Code`/`CourseCode`), or equal token counts where every corresponding token is a prefix of the other of at least two characters (`RegNo`/`RegistrationNo`, `ProfNo`/`ProfessorNo`). Tokens split CamelCase, acronym boundaries, digits and separators after accent folding, before lowercasing. Within a pass, pairs are consumed greedily by descending folded common-prefix length, gold id, then candidate id; every attribute matches once. The same passes recurse into matched parents. Each match records `matchedBy: "name" | "alias" | "folded" | "key" | "tokens"`. `No` alone cannot earn a token match, unrelated `Address`/`AdmissionDate` do not match, and two unmatched key attributes on either side disable the key-role pass. Every composite parent and every nested part counts as one attribute. Moving parts to top level does not match them. Exact/alias/folded matches still expose derived/multivalued mistakes in `attributeProperties`; only token matching gates on multivalued compatibility.
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

## Gold variants and decision checks

A scenario supplies `gold.er.yaml` as `primary` and may supply `gold.alt-<name>.er.yaml` for genuinely acceptable alternative designs. `scoreVariants` scores the candidate against each variant with the same aliases, requirements and checks, returning the report with the highest `overall`. Ties prefer primary, then lexical variant name. `goldVariant` records `primary` or `alt-<name>`. Car rental accepts either a multivalued insurance-options attribute or an option entity shared by cars (`alt-option-entity`). Only declared variants are accepted; arbitrary equivalent conceptual models are outside matching.

Natural scenarios must supply nonempty `checks.json`:

```json
{
  "checks": [
    {"id": "c1", "kind": "weak", "entity": "PET", "owner": "OWNER", "why": "Pet names are unique only within their owner."},
    {"id": "c2", "kind": "multivalued", "attribute": "CAR.InsuranceOptions", "variants": ["primary"], "why": "A car offers several named options."}
  ]
}
```

These examples illustrate checks from different scenarios. All references are exact **gold** names for the selected variant, mapped through the scorer's existing entity, relationship and attribute matches. Attribute paths are `OWNER.Attr[.Part]`; `relationshipAttribute` also accepts a bare attribute name scoped to its `relationship`. Key `attrs` are names within the given entity. Check ids must be unique; `why` is one line. An optional `variants` list restricts the check to those variants; excluded checks do not contribute to totals. Missing referenced candidate matches fail. The loader validates metadata, check shapes, variant names and gold references before any run.

| Kind | Fields beyond id/kind/why/variants | Passing decision |
| --- | --- | --- |
| `weak` | `entity`, `owner` | Matched entity is weak, has a valid nonempty partial key and an identifying connection to the matched owner. |
| `ternary` | `relationship` | Some candidate relationship has exactly the three matched gold participants. |
| `recursive` | `relationship` | Matched relationship has two ends on the same matched entity. |
| `multivalued`, `derived` | `attribute` | Matched attribute has the requested flag. |
| `composite` | `attribute`, optional `minParts` (default 2) | Matched attribute has at least that many immediate parts. |
| `relationshipAttribute` | `relationship`, `attribute` | Attribute is on the matched relationship and its name/alias is absent from all participant entities. |
| `entity` | `entity` | Gold entity matches a candidate entity. |
| `cardinality` | `relationship`, `entity`, `card`, optional `role` | Paired end has the exact normalized min/max. Use a gold role to distinguish recursive ends. |
| `key` | `entity`, `attrs` | Matched entity is strong and has a candidate key equal to the matched attribute set. Other candidate keys are allowed by this decision check. |

`decisions` is `{correct, total, accuracy, failed: [{id, kind, why, reason}]}`, or `null` without checks. Each applicable check contributes one vote; an empty applicable set has accuracy 1. `keys.accuracy` still compares the entire gold key design, including exact partial keys, independently of the decision checks.

Without checks (the original explicit set), the formula remains:

```text
overall = (entity F1 + relationship F1 + attribute F1
           + key accuracy + cardinality accuracy) / 5
```

With checks (the natural set), the formula is:

```text
overall = (entity F1 + relationship F1 + attribute F1
           + key accuracy + cardinality accuracy + decisions.accuracy) / 6
```

The explicit formula remains comparable with previous results. Natural decision checks bring selected property and structure choices into `overall`; the full `attributeProperties`, lint and trace metrics remain supplementary. A high overall score does not prove every requirement is correct. Notes, display labels, types and ordering constraints are outside matching. Keep the set and formula fixed when comparing scores.

## Offline rescore

Recompute saved attempts with the current scorer without running either CLI:

```sh
node_modules/.bin/tsx bench/agent-eval/rescore.ts --help
node_modules/.bin/tsx bench/agent-eval/rescore.ts bench/agent-eval/results/<batch>
node_modules/.bin/tsx bench/agent-eval/rescore.ts bench/agent-eval/results/<batch> --out /tmp/chen-rescored
```

The command parses `<agent>-<scenario>-<run>/` directory names (including hyphenated scenarios), reparses `model.er.yaml` and `model.er.requirements.md`, and scores against every current gold variant with current aliases and decision checks. Unknown scenarios, invalid run metadata or missing artifacts fail before reports are written. Unparseable models produce `null` scores.

By default it writes `score.rescored.json` beside each old score and `summary.rescored.md` in the results directory, using `summary.ts` and the status and wall time from `run.json`. Failed attempts retain their zero contribution to summary means even when their saved model scores perfectly. Mixed-agent directories receive a separate summary section for each agent. `--out` writes only the rescored files under the destination, preserving attempt subdirectory names. It never modifies `run.json`, `score.json`, `summary.md` or model/requirements artifacts; existing rescored files may be overwritten. Rescoring uses today's matching rules, so keep the original reports when comparing historical results.

## Add a scenario

1. Create `scenarios/<name>/requirements.md` using the documented numbered format, without applied hashes or traces. Explicit scenarios have 6–14 items; natural scenarios have 8–14 homework-prose items. State every identifier scope and every end's minimum and maximum in words; do not rely on domain assumptions.
2. Natural prose must contain no modeling vocabulary: English whole words `entity`, `entities`, `attribute(s)`, `weak`, `key(s)`, `partial`, `ternary`, `binary`, `multivalued`, `multi-valued`, `derived`, `composite`, `cardinality`, `participation`, `relationship(s)`, `identifying`; Turkish `varlık`, `nitelik`, `zayıf`, `anahtar`, `kısmi`, `üçlü`, `ikili`, `çok değerli`, `türetilmiş`, `bileşik`, `kardinalite`, `katılım`, `ilişki` (including every suffix). No all-caps words of three or more letters, snake_case or CamelCase identifiers.
3. Add `scenario.json` for a natural scenario and its language. Add `gold.er.yaml` reflecting every fact, and optional reviewed alternative gold files. Require zero parse/lint errors for every variant.
4. Add natural `checks.json` for the modeling decisions and 3–5 important cardinality ends. Scope variant-specific checks explicitly. Add 2–4 plausible aliases for every entity and ambiguously named attributes; scope synonyms to avoid merging different concepts.
5. Extend the intentional roster, self-scoring and mutation tests in `test/agent-eval-*.test.ts`. Run `npx tsc --noEmit` and `npx vitest run`. No package script or dependency change is needed.

Tests validate scoring, all fixtures, metadata/set filtering and summaries. The runner is never executed against agents in tests.
