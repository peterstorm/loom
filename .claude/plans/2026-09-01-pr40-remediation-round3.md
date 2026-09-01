# PR #40 remediation — round 3

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Reviewed head: `891002ae2f7259b16310172f167507d4e42cd742`
Review Run Directory: `review-20260901T160622Z-2737783`
Result digest: `1b8b5fd42638db98d55d4b00aa15ca170f670c67a356c644fc9cd7faf0fc9625`

## Mandatory critical fixes

1. Preserve roster observation failures as typed unavailable status instead of observed liveness; keep registration’s fail-closed boolean adapter.
2. Bound settlement receipt failure kinds to the same maximum as Retry Context so every valid retry receipt can render/parse/admit.
3. Validate nested retry admission Task/predecessor relations before constructing Attempt Context.
4. Correct the `/loom` status transition table: escalation leaves Task status pending and is published by canonical status.
5. Qualify active-Task exclusion as applying only to non-reclaimable reservations.

## Advisory dispositions

Accepted:

- Add real shell-level stale/unavailable roster status coverage.
- Add attempt-2 infrastructure settlement → fresh attempt-2 registration integration coverage.
- Add failed spec-check document-observation and corrupt resume JSON regressions.
- Replace legacy-reclamation “fail-closed” wording with availability-biased compatibility wording.
- Replace temporary Slice-4 field terminology with current-protocol terminology.
- Correct the prompt-digest plan statement.
- Replace mutable settlement result holders with `updateAndReturn`.
- Hash Attempt Context prompt once and reuse it.
- Correct `clearAttempt` return type to match runtime behavior.

Deferred:

- Attempt Context persisted union, per-Task authority batch binding, active-attempt aggregate, Pi spawn saga, implementation-window module extraction, versioned receipt context identity: dedicated interface/schema deepenings already recorded in prior rounds.
- Historical Task metadata narrative cleanup: broad documentation cleanup unrelated to retry correctness.

## Refutation audit

No critical Finding was refuted by the required majority. Two received one dissenting lens but survived the 2-of-3 threshold.

## Support paths

- `.claude/plans/2026-09-01-pr40-remediation-round3.md`
- `engine/src/machine/ledger.ts`
- `engine/src/machine/index.ts`

## Validation

Focused retry/completion/status/registration/Pi/resume suites; typecheck + unused; full-tier lint; authoritative unit and smoke suites; diff check; registered remediation; verified index; normal push.

## Validation receipt

- Focused retry, registration, roster, Pi fault-settlement, spec observation, resume, and status regressions: passed.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 10 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,047 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
