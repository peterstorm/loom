# PR #204 remediation (loom#198, Cause 2: one module owns every engine path class)

- Branch: `fix/engine-owned-paths` (worktree `loom-engine-paths`)
- Scope: the full PR diff at the first push (`kind: all`, 22 files)
- Review run: `.claude/reviews/review-and-fix-runs/pr204-review-1`
- Policy publication: `.claude/reviews/review-and-fix-runs/pr204-policy-1`

## Critical findings

None surviving, none refuted. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Fix / reason |
|---|---|---|
| pr-test-analyzer-1 | accepted | defect-family tests: Pi state, Pi specs panel-runs and Pi run-layout siblings are refused as protected; project content beside them is admitted |
| pr-test-analyzer-2 | accepted | a test loads the inv-10 rule and checks its pattern against restating lines, comment prose and unrelated paths, and that it exempts only the owning module and tests |
| type-design-analyzer-1 | accepted | `RUN_LAYOUT_COMPONENTS` and the legacy digest set use `frozenSet`; a test pins runtime immutability |
| type-design-analyzer-2 | deferred | every current caller passes an already-parsed path, but under two brands (`ReviewPath`, `CanonicalRepositoryRelativePath`); one shared repository-path brand is its own change across those parsers |
| type-design-analyzer-3 | accepted | the fixHint names the module's real exports |
| comment-analyzer-1 | accepted | the header says `engine-runtime-paths.ts` keeps the State File's own lock and staging leaves |
| comment-analyzer-2 | accepted | the header and the architecture row name the real consumers; Task scope judges the State File's companions through `engine-runtime-paths.ts` |
| comment-analyzer-3 | accepted | as type-design-analyzer-3 |
| architecture-tech-lead-1 | accepted | as type-design-analyzer-3 |
| architecture-tech-lead-2 | accepted | `runsRootBesideStateFile` is the one derivation of a runs root beside a State File; both call sites use it |
| architecture-tech-lead-3 | accepted | `isEngineEvidencePath` interprets one declarative table, `ENGINE_EVIDENCE_POLICY`, and remediation records the digest of that table, so a change of behavior is a change of digest; the prose list is gone |
| code-simplifier-1 | accepted | `projectRootOfCanonicalStatePath` and `CANONICAL_TASK_GRAPH_LOCATIONS_TEXT` live in the module; both handlers use them |
| code-simplifier-2 | accepted | as architecture-tech-lead-2 |
| code-simplifier-3 | accepted | as type-design-analyzer-3 |

The module now imports `node:path` for the two derivations beside a State File, so `.claude/linter/rules/config.json` grants it, with the reason "pure path math", as it grants `phase-artifact-paths.ts`.

## Support paths (outside the frozen scope)

- `.claude/plans/2026-11-17-pr204-remediation.md`
- `.claude/linter/rules/config.json` (the `node:path` grant)
- `engine/tests/core/defect-family-accounting.test.ts` (pr-test-analyzer-1)

## Validation (mine, not remediation evidence)

As CI runs it (root and engine deps installed, Node 22): `scripts/typecheck.ts`, `scripts/lint-project.ts`, the touched suites, the full unit suite (against the two files that fail on clean main locally: `project-snapshot`, `surface-stop-check-notes`) and `test:smoke`.
