# Requirements → model evaluation

See [the evaluation README](../bench/agent-eval/README.md) for the explicit and natural sets (six scenarios each), deterministic name/alias/structure matching, gold variants, decision checks, both overall formulas and scenario authoring instructions.

Use `--set explicit|natural|all` (default `all`) to choose the set. Summaries record set, selected variant and decision accuracy, and list failed decision checks per run. The original explicit scenario files are unchanged; their score keeps the five-term formula. Natural scenarios add decision accuracy as a sixth term.

The runner shares the viewer Requirements Apply prompt and trace pipeline. It invokes real logged-in CLIs and must be run manually; tests validate only scoring and fixtures.
