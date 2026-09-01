# PR #40 remediation — round 8

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Reviewed head: `9aba6857edcc9c24b81ecd1ad984888e757edd0b`
Review Run Directory: `review-20260901T184809Z-3051578`
Result digest: `0d859b1b743222cf4992283c9a529ebf0958b62a6aab4b380ccc9815b046bc8e`

## Mandatory fixes

- Add an explicit unversioned Slice-3 history projection and persist protocol version 2 plus strict history-start authority on the next engine registration; never rewrite historical receipt bytes.
- Parse Pi `event.details` as unknown before inspecting `results`, preserving finalization and cleanup for primitive shape drift.
- Replace unconditional Common Issues re-spawn guidance with canonical status-only recovery.

## Advisory dispositions

Accepted:

- Add StateManager/core migration regressions for retry→attempt-1 success, infrastructure, and repeated semantic failures.
- Persist/recheck strict lineage start in Task execution authority plans.
- Clarify Retry Context as admission evidence, Pi post-registration rollback commentary, harness write authority, unresolved path provenance, and modern/legacy invalidation ownership.

Deferred:

- Opaque/ADT histories, Attempt Context, active execution state, Task-local observations, transition facts, and authority plans; Pi spawn transaction; implementation-window extraction; receipt v2 identity: dedicated deepen/schema work.
- Broad reducer consolidation and duplicated historical comment cleanup: separate distill pass.

## Refutation audit

No critical Finding was refuted; all three survived every lens.

## Support path

- `.claude/plans/2026-09-01-pr40-remediation-round8.md`

## Validation

Focused migration, registration, primitive-details, and status tests; typecheck/unused; full-tier lint; authoritative unit/smoke; diff check; registered remediation; verified index; normal push.

## Validation receipt

- Slice-3 history projection, strict cutover registration, primitive Pi details, and StateManager migration suites: passed.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 5 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,053 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
