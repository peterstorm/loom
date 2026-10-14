# PR #91 remediation: runner files relative to cwd

- **Branch:** `fix/acceptance-runner-cwd-files` (reviewed head: the first PR #91 commit)
- **Scope:** the frozen diff of PR #91, which covers 3 files (`kind: all`, `files: null`).
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261014T200603Z-pr91`
  - Reviewer Protocol v2, 7 reviewers.
  - Result digest `bb3e9e520f4d4a96ef8cfbbc773b1fb1d50627f65e1f15e2fb0837b452e8ce2f`.
- **Critical findings:** 0 surviving and 0 refuted, so no Refutation Panel ran. Defect family: `not-required`.
- **Advisory policy:**
  - Published by `.claude/reviews/review-and-fix-runs/policy-20261014-pr91`.
  - Revision `initial`, provenance DECLARED.
  - Disposition digest `0ea1ce95413d7e3783a5748a27ac8a34681eaba632f80e1ae03656eef250a167`.

## Advisory dispositions

| ID | Disposition | Fix |
|----|-------------|-----|
| pr-test-analyzer-1 | accepted | A handler test covers an owed file outside the runner's `cwd`. It checks for a did-not-decide note naming the file, that no runner launches, that no lock is taken, and that no block is counted. |

## Validation

`npm run verify` covers prerequisites, typecheck, the full Vitest suite and all six smokes.

## Remediation

Start a registered remediation run with `defectFamily: not-required`. Its `supportPaths` is this plan file.
