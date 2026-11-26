# #242 review-and-fix — remediation plan (DECLARED)

## Subject

Branch `fix/242-jvm-report-counts` in worktree `/home/peterstorm/dev/claude-plugins/loom-242-jvm-counts`,
commit `3b9282ac` ("fix(reports): a JUnit suite counts its testcases, not its attributes") — the loom#242
fix: a JUnit suite that lists `<testcase>` elements is counted from them (Surefire + jqwik mixed-engine
and `@Nested` layouts), with ADR-0103 amending ADR-0100.

## Exact scope (engine-frozen)

The 11 changed files of commit `3b9282ac` vs main `25219d45` (review kind `all`, files derived by the
engine): `.claude/plans/2026-11-26-242-junit-counts.md`, `docs/adr/ADR-0100-a-testrun-passes-only-when-a-test-executed.md`,
`docs/adr/ADR-0103-a-junit-suite-is-counted-from-its-testcases.md`, `docs/adr/README.md`,
`docs/feature-guard-map.md`, `docs/verification.md`, `engine/src/core/structured-test-report.ts`,
`engine/tests/core/junit-testcases.test.ts`, `engine/tests/core/report-summary-reconcile.matrix.test.ts`,
`engine/tests/core/structured-test-report-files.test.ts`,
`engine/tests/machine/structured-test-report-security.test.ts`.

## Run Directories

- Review: `.claude/reviews/review-and-fix-runs/run.1HqKiKZayc` (result digest
  `c8a6e6c58b36bc52342ea724eadbca303bd1d1d4e47f951a140353fc1908b379`)
- Policy publication: `.claude/reviews/review-and-fix-runs/run.VyLzhQuKsa` —
  `standalone-disposition-published`, `artifacts/disposition.json` digest
  `5c5de603ff2650b93f2d1b2d3291e81abef961ba86646b59b385636addadb8ff`
- Remediation: `.claude/reviews/review-and-fix-runs/run.<fresh>` (started in Phase 4)

## Review verdict (observed, from `inspect`)

7 reviewer slots issued, 7 captured attempt 1, 0 rejected. **0 critical, 7 advisory; after refutation:
0 surviving critical, 0 refuted critical, 7 advisory.**

## Surviving-critical dispositions

None — zero surviving criticals. No Declared Repair Groups, no selected checks, no Historical RED
declaration, and remediation will carry `defectFamily: {"kind":"not-required"}`.

## Refuted-finding audit

None — no critical reached the refutation panel.

## Advisory dispositions (published in run.VyLzhQuKsa, in issued order)

| # | Finding | Decision | Reason (declared) |
|---|---------|----------|-------------------|
| 1 | silent-failure-hunter-1 | deferred | The complete fix enriches the shared `malformed-counts` refusal union with suite name and claimed-vs-observed counts — a wire-shape change consumed by `describeTestRunSummaryRefusal`, findReport's stderr wording and refusal-shape assertions outside the frozen scope; the refusal already names its reason and fails closed. Diagnosability polish for its own reviewed change. |
| 2 | pr-test-analyzer-1 | accepted | No testcase-bearing suite in the tests carries a disagreeing or non-numeric `skipped`/`disabled` attribute, so the metadata status of those attributes is unpinned; add the two proposed assertions. |
| 3 | pr-test-analyzer-2 | accepted | The nested-suite overclaim refusal is untested; add the flat testsuites document with one overclaiming nested suite. |
| 4 | type-design-analyzer-1 | accepted | Name the three-way attribute contract in the doc comment (with comment-analyzer-1's correction). |
| 5 | comment-analyzer-1 | accepted | Correct the doc comment and the ADR-0103 Decision sentence: attributes must still be present and numeric; only a present numeric value is metadata. |
| 6 | comment-analyzer-2 | accepted | One-word correction in docs/verification.md: Surefire counts containers **and test methods**. |
| 7 | code-simplifier-1 | accepted | Restore the declarative fold over `sumJunitCounts` in `parseTraditionalJunit`'s child aggregation; behavior identical, tests are the oracle. |

## Accepted advisory fixes (to implement in Phase 3)

- `engine/src/core/structured-test-report.ts`: doc comment names the attribute contract (presence and
  numeric-parseability stay mandatory; values of `tests`/`skipped`/`disabled` discarded in the
  testcase-counted branch; `failures + errors` still enforced); child aggregation folds over
  `sumJunitCounts` instead of hand-rolling the accumulation.
- `engine/tests/core/structured-test-report-files.test.ts`: two new tests — skipped/disabled metadata
  status (numeric-but-disagreeing accepted as metadata, non-numeric refused) and the nested-suite
  overclaim refusal under a green root.
- `docs/adr/ADR-0103-a-junit-suite-is-counted-from-its-testcases.md`: Decision detail gains the
  presence-and-parseability qualification.
- `docs/verification.md`: "containers and test methods".

## Validation commands (Phase 3 — mine, not remediation evidence)

- `cd engine && bun scripts/typecheck.ts`
- `cd engine && env -u PI_CODING_AGENT ./node_modules/.bin/vitest run tests/core/structured-test-report-files.test.ts tests/core/junit-testcases.test.ts tests/machine/structured-test-report-security.test.ts tests/core/report-summary-reconcile.matrix.test.ts tests/machine/test-report.test.ts`
- `cd engine && env -u PI_CODING_AGENT bun ../scripts/lint-project.ts`

## Phase 4 registration (declared now; the engine observes the rest)

Remediation start input: `sourceRunsRoot` = `.claude/reviews/review-and-fix-runs`, `sourceRun` =
`run.1HqKiKZayc`, `supportPaths` = `[".claude/plans/2026-11-26-pr-remediation.md"]` (this plan file —
the only path remediation touches outside the frozen review scope),
`defectFamily` = `{"kind":"not-required"}`. After `done` with `remediation-installed`, commit the
installed index and push the branch.
