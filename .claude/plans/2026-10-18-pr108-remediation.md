# PR #108 remediation: unrecorded fixtures get a name, saneCounts reuses CountFields

- **Branch:** `refactor/report-summary-kinds` (base `main`)
- **Scope:** the review's frozen diff was the PR's 18 files (`kind: all`). This remediation edits files inside that
  scope and adds the support paths listed below.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261018-pr108`
  (`result.json` digest `bd9b55a0802236da6ecf51eea01f365a6be3862b36ffd024cdd0e5b6fb35b731`)
- **Counts (inspection renderer):** 0 critical and 5 advisory emitted and admitted. After refutation:
  0 critical surviving, 0 refuted, 5 advisory. 8 slots issued, 8 captured: the silent-failure-hunter's attempt 1
  was refused for incomplete read coverage and its attempt 2 was captured.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261018-pr108`,
  revision `initial`, disposition digest `2cdb7eef57af04ba754e2c33dc2294b46d307e9246513d15ad8414e2a9bd0931`
  (DECLARED).

## Surviving / refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| comment-analyzer-1 | accepted | The fixture helper's comment called an unrecorded TestRun summary "counts-only", the term this PR retires for `ReportCounts`. Reworded, and the same stale wording in `ledger-per-file-results.acceptance.test.ts` is fixed. |
| architecture-tech-lead-1 | accepted | Production callers pass real values (the ledger field, a parser projection, a merge); the bare `undefined` sentinel appears only where tests mint an unrecorded fixture. Those sites move to the named `reportSummary()` helper (shared with code-simplifier-2); tests of the constructor's own behavior keep the direct call. |
| architecture-tech-lead-2 | deferred | The runtime collapse (an unrecorded `TestReportSummary` serializes like `ReportCounts`) is deliberate, to keep pre-feature ledger bytes, and is guarded by the sole-constructor module, the shape tests and the INV-8 rule; the reviewer requires no change. Lifting it means moving the legacy-bytes rule into the ledger codec, a behavior change scoped out of this type split. |
| code-simplifier-1 | accepted | `saneCounts` returns `CountFields \| null` instead of restating the three fields. Type-level only. |
| code-simplifier-2 | accepted | Fixture-minting sites use `tests/machine/report-summary.ts`'s `reportSummary()`. Direct calls stay where the test is about `parseReportSummary` itself: the unsafe-integer null case, the unrecorded wire-bytes test, and the property generator that must tolerate `null`. |

## Accepted fixes

- `engine/src/core/structured-test-report.ts`: `saneCounts(…): CountFields | null`.
- `engine/tests/machine/report-summary.ts`: comment reworded.
- `engine/tests/machine/test-report.test.ts`, `engine/tests/machine/structured-test-report-security.test.ts`,
  `engine/tests/core/structured-test-report-files.test.ts`: fixture-minting `parseReportSummary(…, undefined)!`
  calls become `reportSummary(…)`.
- `engine/tests/acceptance/ledger-per-file-results.acceptance.test.ts`: two comments no longer describe a summary
  without `files`.

## Support paths (outside the frozen scope)

- `engine/tests/acceptance/ledger-per-file-results.acceptance.test.ts`
- this plan

## Validation

- `tsc --noEmit --noUnusedLocals --noUnusedParameters`: nothing in `src/`, `tests/` or `pi/`
- the covering suites: `tests/machine`, `structured-test-report-files`, `ledger-per-file-results.acceptance`,
  `defect-family-accounting`
- `npm run verify` (root): 542 of 542 files, 23 of 23 smokes
