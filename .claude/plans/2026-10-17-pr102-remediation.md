# PR #102 remediation — stop-check test fixtures review

- **Branch:** `refactor/stop-check-test-fixtures`
- **Scope:** the PR's 14 changed test files (frozen diff, `kind: all`)
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261017T132957Z-47fabba9`
- **Counts (inspection renderer):** emitted/admitted 0 critical, 4 advisory; after refutation 0 surviving
  critical, 0 refuted critical, 4 advisory.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261017-pr102`, revision
  `initial`, disposition digest `c64d5930a97075df427149f53dc57e3b908213eff99269aeb59a50c5c97e0868` (DECLARED).

## Surviving / refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| architecture-tech-lead-1 | accepted | Four fakes still spelled the observed-run shape inline; `observedRun` gains `stdoutTail` and `digestOf` options and they call it. |
| code-simplifier-1 | accepted | The header's parenthesised names are manifest keys; name the exports and the keys explicitly. |
| code-simplifier-2 | accepted | Use `argvOf` in the remaining launch recorders; add `checkNameOf(command)` for the repeated report-path-to-check mapping. |
| code-simplifier-3 | accepted | Same root as architecture-tech-lead-1. |

## Accepted fixes

- `tests/fixtures/stop-check-runners.ts`: `observedRun(command, bytes, { ending, stdoutTail, digestOf })`;
  `checkNameOf` (throws on an unknown report path); header names the exports and the manifest keys.
- `stop-checks.test.ts`, `stop-checks-isolation.test.ts`, `affected-stop-check.acceptance.test.ts`,
  `acceptance-stop-check.test.ts`: observed runs through `observedRun` (checkId now the command's own,
  not a fixed literal; no assertion reads it); `argvOf` / `checkNameOf` replace the inline spellings.
- `stop-check-plan-affected.acceptance.test.ts`, `stop-check-plan.test.ts`: `checkNameOf` / `argvOf`.
- `pi/acceptance-stop-check-report.test.ts`: the new `ending` option.

## Validation

- `npx tsc --noEmit -p engine`; no new unused imports
- the 13 touched suites
- `npm run verify` (root)
