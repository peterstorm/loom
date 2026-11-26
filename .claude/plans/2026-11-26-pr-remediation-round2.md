# #242 review-and-fix — remediation plan, round 2 (DECLARED)

Second review-and-fix pass over branch `fix/242-jvm-report-counts` in worktree
`/home/peterstorm/dev/claude-plugins/loom-242-jvm-counts` (commits `3b9282ac` + `0646dbd9`).

## Exact scope (engine-frozen)

The 12 changed files of the branch vs main `25219d45` (review kind `all`, files derived by the engine):
the 11 files of round 1 plus `.claude/plans/2026-11-26-pr-remediation.md`.

## Run Directories

- Review: `.claude/reviews/review-and-fix-runs/run.uqs5UBqKH6` (result digest
  `bb81f0674c1bf2ff979d6e84b3f1a851a96f17ce481752657eb73c2aaffda758`)
- Policy publication: `.claude/reviews/review-and-fix-runs/run.fOYgzaSoYP` —
  `standalone-disposition-published`, `artifacts/disposition.json` digest
  `1bd9ddbd6d824d6130a6a0e5cd8a6f0e5a1c547c23c0f240c06fe7567aac2440`
- Remediation: `.claude/reviews/review-and-fix-runs/run.<fresh>` (started in Phase 4)

## Review verdict (observed, from `inspect`)

7 reviewer slots issued, 7 captured attempt 1, 0 rejected. **0 critical, 8 advisory; after refutation:
0 surviving critical, 0 refuted critical, 8 advisory.**

## Surviving-critical dispositions

None — zero surviving criticals. No Declared Repair Groups, no selected checks, no Historical RED
declaration; remediation carries `defectFamily: {"kind":"not-required"}`.

## Refuted-finding audit

None — no critical reached the refutation panel.

## Advisory dispositions (published in run.fOYgzaSoYP, in issued order)

| # | Finding | Decision | Reason (declared) |
|---|---------|----------|-------------------|
| 1 | silent-failure-hunter-1 | accepted | The null pre-check duplicates `sumJunitCounts`'s own refusal; removed by the accepted code-simplifier-1 distillation. |
| 2 | pr-test-analyzer-1 | accepted | Parametrized refusals pin the attribute-parse guard arms (missing/non-numeric `tests`, non-numeric `failures`/`errors`/`disabled` beside testcases). |
| 3 | pr-test-analyzer-2 | accepted | Sum-boundary overclaim pinned (`failures="1" errors="1"` beside one failing testcase → refused). |
| 4 | pr-test-analyzer-3 | accepted | Matrix fixture pins the root `tests` attribute as metadata (root `tests="99"` over testcase-bearing suites → accepted as the testcase total). |
| 5 | type-design-analyzer-1 | dismissed | The accepted code-simplifier-1 distillation deletes the `JunitObservation` wrapper outright; a provenance union would re-introduce the threading the distillation removes. |
| 6 | type-design-analyzer-2 | accepted | Resolved by the same distillation: `sumJunitCounts`'s null propagation is the single enforcement point. |
| 7 | architecture-tech-lead-1 | deferred | The fix moves `tests/machine/report-summary.ts` (outside the frozen scope) and updates its five importers across core and handlers trees — its own reviewed change. |
| 8 | code-simplifier-1 | accepted | Restore the bare `JunitCounts`-or-null return; aggregate via `sumJunitCounts` over `children.map`; derive `hasTestcases` at its single use; delete `JunitObservation` and the nullable-access sites. Behavior identical. |

## Accepted advisory fixes (Phase 3)

- `engine/src/core/structured-test-report.ts`: `parseTraditionalJunit` returns `JunitCounts | null` bare
  again; child aggregation = `sumJunitCounts(children.map(parseTraditionalJunit))`; `hasTestcases`
  derived at the single use site as a child whose subtree lists testcase elements; `JunitObservation`
  and the null pre-check deleted; call site drops `?.counts ?? null`.
- `engine/tests/core/structured-test-report-files.test.ts`: parametrized attribute-parse refusals +
  the sum-boundary overclaim test.
- `engine/tests/core/report-summary-reconcile.matrix.test.ts`: fixture with root `tests="99"` over
  testcase-bearing suites, accepted as the testcase total through the matrix entry points.

## Validation commands (Phase 3 — mine, not remediation evidence)

- `cd engine && bun scripts/typecheck.ts`
- `cd engine && env -u PI_CODING_AGENT ./node_modules/.bin/vitest run tests/core/structured-test-report-files.test.ts tests/core/junit-testcases.test.ts tests/machine/structured-test-report-security.test.ts tests/core/report-summary-reconcile.matrix.test.ts tests/machine/test-report.test.ts`
- `cd engine && env -u PI_CODING_AGENT bun ../scripts/lint-project.ts`

## Phase 4 registration (declared now; the engine observes the rest)

Remediation start input: `sourceRunsRoot` = `.claude/reviews/review-and-fix-runs`, `sourceRun` =
`run.uqs5UBqKH6`, `supportPaths` = `[".claude/plans/2026-11-26-pr-remediation-round2.md"]`,
`defectFamily` = `{"kind":"not-required"}`. After `done` with `remediation-installed`, commit the
installed index and push the branch.
