# PR #154 remediation — review-and-fix

- **Branch:** `fix/claude-harness-transcript-records` (PR peterstorm/loom#154)
- **Scope:** `origin/main...HEAD` plus the working tree (39 files, frozen by the review run)
- **Review Run:** `.claude/reviews/review-and-fix-runs/run.pr154-review-1`
  (result digest `8662c53221600dd2d25567d2b72d4e38b1ae273645efec5ba409055e5c3be385`)
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/run.pr154-policy-1`
  (revision `initial`, disposition digest `2c5a7d1fc3b3c08575a266b6ac3407e87f43e017a6e823863d2821593b78a04a`)

## Critical findings

Emitted/admitted: 0 critical; 18 advisory. After refutation: 0 surviving critical, 0 refuted critical.
No Declared Repair Group, sibling accounting, selected check or Historical RED applies:
remediation runs with `defectFamily: {"kind": "not-required"}`.

## Refuted findings

None.

## Advisory dispositions (DECLARED)

| Finding | Decision | Reason |
|---|---|---|
| code-reviewer-1, type-design-analyzer-1, architecture-tech-lead-5, code-simplifier-4 | accepted | `.claude/settings.local.json` is not committed: it is untracked and matched only by the author's global gitignore, which the review engine does not read. Fix: add it to the repository `.gitignore`. |
| silent-failure-hunter-1 | accepted | Log one stderr line when Bun console collection errors cannot join a JUnit summary whose per-file results are unrecorded. |
| pr-test-analyzer-1 | accepted | Test the uninspectable (ENOTDIR) Bun outfile arm: no console-only summary may vouch. |
| type-design-analyzer-2 | accepted | Regression tests with Bun-shaped testcases (`file` ≠ `classname`, empty classname) for Wave Gate and owner-verification attribution. |
| type-design-analyzer-3 | deferred | Pre-existing tolerant-reader behavior; the strict boundary already refuses untyped records. A third arm changes every tolerant reader and belongs in its own change. |
| comment-analyzer-1 | accepted | Reword the `bun-console` source doc. |
| comment-analyzer-2 | accepted | Reword the 1,000-character note in `docs/operations.md`. |
| architecture-tech-lead-1 | accepted | A reported file that also errored between tests gains a failing testcase but keeps `collectionError: false`; only an omitted file is a collection error. ADR-0064 updated. |
| architecture-tech-lead-2 | accepted | One exported `REPORT_SOURCES` vocabulary and `parseReportSource`, used by the ledger read-back. The completion-check reader in `defect-family-accounting.ts` stays deliberately narrower (only formats the strict byte parser yields); that is documented beside `REPORT_SOURCES`. |
| architecture-tech-lead-3 | deferred | A behavior-neutral relocation of the Bun logic into its own module, chosen by ADR-0064; do it with the next Bun format change. |
| architecture-tech-lead-4 | dismissed | The readers have different error semantics; the single classification already fixes the rule, and code-simplifier-5 aligns the ordering. |
| code-simplifier-1 | accepted | `NO_RUN` constant per test file. |
| code-simplifier-2 | accepted | Read Bun console errors only where a report can vouch. |
| code-simplifier-3 | accepted | Classify each record once in the integrity parser. |
| code-simplifier-5 | accepted | Skip harness records before reading the message in `conversationLineOf`. |

## Paths outside the frozen review scope (support paths)

- `.gitignore`
- `.claude/plans/2026-11-09-pr-remediation.md`
- `engine/tests/core/owner-verification-outcome.test.ts`

## Validation

- `bun engine/scripts/typecheck.ts`
- Targeted: `npx vitest run` over the structured-report, report-discovery, bun-console-capture, acceptance-contract, owner-verification, ledger, transcript and parser suites
- Full: `npm run test` in `engine/` (the 16 `verification-command` / `surface-stop-check-notes` failures are environmental on this machine and fail identically on `main`; CI runs them green)
