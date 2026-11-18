# PR #221 remediation (loom#199 Cause 5: acceptance tests run through declared runtime seams)

- Branch: `feat/runtime-seams` (worktree `loom-runtime-seams`)
- Review run: `.claude/reviews/review-and-fix-runs/pr221-review-1`. Result digest `93a17998…cccbc`.
- Policy publication: `pr221-policy-1`

## Engine-observed counts
18 findings: 0 critical, 18 advisory. Defect family: `not-required`.

## Advisory dispositions (DECLARED)
13 accepted, 3 deferred, 1 dismissed.
- **Deferred:**
  - carrying file text only for acceptance paths, twice: the frozen set is small;
  - binding seams into the freeze record: the acceptance files are already digest-frozen.
- **Dismissed:** making the field always present. Omitting it keeps earlier contracts byte-identical, and a comment now says so.

The fixes:
- **Only code counts.** The seam check ignores comments and one-line string literals, so a comment naming the seam no longer satisfies the freeze.
- **One symbol grammar.** `RUNTIME_SEAM_SYMBOL` is shared by the plan parser and the State File parser.
- **Problem ordering.** `contractProblems` gives the runtime-seam refusal its own reachable arm.
- **Docs.** Reworded the source doc and ADR-0088.
- **Tests:**
  - a real `observeFrozenDigests` text test;
  - unreadable and multi-file gaps, with the rendered sentence;
  - State File rows for `null`, a string and a non-object seam;
  - pins for the prompt rules;
  - the shared test alias.

## Support paths (outside the reviewed scope)
- `.claude/plans/2026-11-18-pr221-remediation.md`
- `engine/tests/spec-check-command-contract.test.ts`

## Validation (mine, not remediation evidence)
- `tsc` reports no errors in `engine/src`.
- `bun run lint` is clean.
- 19 targeted files pass, 619 tests, plus the parser and seam suites after the split.
