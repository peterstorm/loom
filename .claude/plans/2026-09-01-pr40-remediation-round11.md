# PR #40 remediation — round 11

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Reviewed head: `97d44858eb47fbf6569e66f380eabac57d3d61bc`
Review Run Directory: `review-20260901T203215Z-3267613`
Result digest: `06a4b5f1c33b950d980904b632fd2fdc281b3845b39b024c523088603fdda4a7`

## Mandatory fixes

- Catch TaskGraph path resolution, existence probing, StateManager authority capture, and load as one blocking registration boundary.
- Reject every active semantic attempt 2 unless protocol-2 retry lineage authorizes it.
- Correct the Best-of-N proposal so isolated Task worktrees, candidate integration, and mutation-on-diff scoring remain explicit prerequisites.

## Refutation audit

All three critical findings survived the two-of-three threshold. The registration finding was refuted only by the reproduction lens because the outer Claude CLI also exits fail-closed; intent and security still require the typed registration operation itself to return a blocking result.

## Advisory dispositions

Accepted: catch rollback authority capture; test protocol-2 reset after implementation; use `compareStrings` for retry failure kinds; collapse parsed history to its successful receipt array; replace the undefined Phase-1 suite label.

Deferred to dedicated deepen/distill work: attempt/context/execution/plan/Pi reservation ADTs, active execution aggregate, Pi spawn transaction, transition-input ADT, Wave Gate façade and reason projection, baseline-capture extraction, and test-fixture consolidation. The apparent escalation-discriminant recheck remains because TypeScript needs it to narrow failure kinds without an assertion or larger helper.

## Support path

- `.claude/plans/2026-09-01-pr40-remediation-round11.md`

## Validation

Focused registration/rollback, StateManager, retry-core, and completion tests; typecheck/unused; full-tier lint; authoritative unit/smoke; diff check; registered remediation; verified index; normal push.

## Validation receipt

- Focused registration/rollback, StateManager, and retry-core suites: 37 passed, 0 failures.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 4 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,055 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
