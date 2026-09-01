# PR #40 remediation — round 9

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Reviewed head: `1b55d43a6b1b995bc69e4e9647b9db8949a05497`
Review Run Directory: `review-20260901T192425Z-3179524`
Result digest: `a6ca8eebcffabd7158f5056ce89f3d8600ba167edc164cf8e301a10cc2bce25a`

## Mandatory fixes

- Replace cutover replay of legacy attempt-1 infrastructure with an explicit predecessor seed plus strict suffix after all immutable legacy receipts.
- Bind protocol-2 cutover start to the compatibility projection so it cannot skip retry or terminal authority.
- Reject unversioned receipts after terminal escalation.
- Require Attempt Context for every protocol-2 active authority.
- Parse primitive Pi details before property access.
- Clear legacy marker/timestamp with execution membership during legacy infrastructure cleanup.
- Document unversioned compatibility projection, timestamp-less immediate legacy exception, and strict protocol-2 reduction accurately.

## Advisory dispositions

Accepted: registration/reload migration properties, strict initial-context requirement, legacy cleanup regression, direct `findLast`, and exact protocol field typing.

Deferred: active-attempt/history/Attempt Context/transition ADTs, Pi spawn transaction, implementation-window extraction, and broad reducer consolidation remain dedicated deepen/distill work.

## Refutation audit

No critical Finding was refuted; all survived every lens.

## Support path

- `.claude/plans/2026-09-01-pr40-remediation-round9.md`

## Validation

Focused migration/cutover/cleanup/Pi shape suites; typecheck/unused; full-tier lint; authoritative unit/smoke; diff check; registered remediation; verified index; normal push.

## Validation receipt

- Legacy cutover seed, skipped-terminal refusal, strict context, primitive Pi details, and legacy cleanup regressions: passed.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 6 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,054 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
