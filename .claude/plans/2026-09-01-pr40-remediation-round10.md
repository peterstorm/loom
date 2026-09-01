# PR #40 remediation — round 10

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Reviewed head: `9ca21c27efc7b4d9d741f39cab2b81f759e3fa46`
Review Run Directory: `review-20260901T195907Z-3225084`
Result digest: `5d9416a0326b286e74f5658b3ba59bdc06f8b026a5967e152f6bf17b926d43cc`

## Mandatory fixes

- Describe Retry Context prompt bytes as exact admission evidence validated against protected settlement history before attempt authority is minted.
- Describe stale reclamation as bounded policy eligibility rather than proof of process death.

## Refutation audit

The engine-owned panel refuted both alleged legacy cleanup failures and the alleged missing registration/reload migration test. Those findings are not remediated. The two documentation findings survived the two-of-three threshold and are mandatory.

## Advisory dispositions

Accepted:

- distinguish Claude ledger evidence from Pi structured result evidence;
- describe terminal escalation as publication for operator handling;
- distinguish typed unavailable roster observation from the compatibility boolean adapter;
- attach registration-shell documentation to `registerTaskExecutionBatch`;
- attribute late-result safety to exact active authority/reservation matching;
- remove the unsupported single-`O_APPEND`-write claim;
- cover missing, wrong, and misplaced predecessor seeds;
- reuse the local attempt-release operation in the legacy infrastructure branch.

Deferred to dedicated deepen/distill work: attempt-context and transition ADTs, active execution aggregate, Pi spawn transaction, implementation-window extraction, baseline-capture extraction, `unstartedWaveStatus` decomposition, and broad test-fixture consolidation.

## Support path

- `.claude/plans/2026-09-01-pr40-remediation-round10.md`

## Validation

Focused retry, legacy application, ledger, task registration, template contract, and documentation checks; typecheck/unused; full-tier lint; authoritative unit/smoke; diff check; registered remediation; verified index; normal push.

## Validation receipt

- Focused retry/application/registration/ledger/template suites: 95 passed, 0 failures.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 3 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,054 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
