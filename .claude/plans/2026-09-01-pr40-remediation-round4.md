# PR #40 remediation — round 4

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Reviewed head: `836afeaaa6d8a6f4ef64d31c9cea8b70cb65bdd4`
Review Run Directory: `review-20260901T164634Z-2814970`
Result digest: `ba84f3edb109c1bb3497cf4859e54872609018b4f8b70f54b23a87b7d170946f`

## Mandatory critical fixes

1. Canonical status includes Tasks with `executing_tasks` membership or active attempt authority even when Task status is already `implemented`; live authority waits and policy-reclaimable authority dispatches before Wave Gate start.
2. Replace remaining shell/receipt “proved abandoned” language with bounded policy eligibility.

## Advisory dispositions

Accepted:

- Add mixed initial + attempt-2 registration integration coverage.
- Existing roster failure tests plus typed malformed-pointer shell coverage exercise the new unavailable observation; retain additional failure-shape tests in the focused suite.
- Remove redundant Retry Context from status dispatch; exact prompt appendix is the sole dispatch authority.
- Clarify delayed registration reclamation wording and status projection ownership in the Slice 4 plan.
- Apply local distill moves: trust legacy discriminant narrowing, carry registration loop index, share status workspace observation, return legacy cleanup decisions through `updateAndReturn`.

Deferred:

- Persisted Attempt Context union, active-attempt aggregate, per-Task authority-batch input, Pi spawn transaction, implementation-window extraction, versioned receipt context identity: dedicated deepen/schema migrations.
- Remaining Pi quarantine/review reducer consolidation and broad historical Task-comment cleanup: separate behavior-preserving cleanup after this correctness PR.

## Refutation audit

Both critical Findings survived all three refutation lenses.

## Support path

- `.claude/plans/2026-09-01-pr40-remediation-round4.md`

## Validation

Focused status/registration/Pi tests; typecheck and unused-code gates; full-tier lint; authoritative unit and smoke suites; diff check; registered remediation; verified index; normal push.

## Validation receipt

- Focused active implemented-reservation, mixed-attempt registration, and Pi settlement suites: passed.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 7 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,047 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
