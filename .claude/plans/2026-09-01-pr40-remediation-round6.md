# PR #40 remediation — round 6

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Reviewed head: `f0d61b60fd5a25cb396def9043f728e8e2a43d97`
Review Run Directory: `review-20260901T175316Z-2950569`
Result digest: `2eb4dda551486ef6b9384839eae69d9888cb6a7966a8c439c2881ee5b9eec4aa`

## Mandatory critical fix

Run exact-authority-aware completed/missing cleanup before the modern/legacy Pi result split. A matching modern completed reservation retires execution membership, authority, Attempt Context, baselines, and reservation time without reopening or altering completed Task evidence.

## Advisory dispositions

Accepted:

- Add modern completed-reservation cleanup regression.
- Add escalation precedence over concurrently dispatchable Tasks.
- Return completed cleanup decisions through `updateAndReturn` and reuse the common settlement state selector.

Deferred:

- Digest-valid parser combination cases are covered by constructor/StateManager tests; further examples are low-risk test expansion.
- Active-attempt, Attempt Context, Task-local observation, transition-facts, and authority-batch ADTs; Pi spawn transaction; implementation-window extraction: dedicated schema/interface deepenings.
- Remaining review/quarantine reducer consolidation and broad comment cleanup: separate distill work.

## Refutation audit

The reclamation-age comment Finding was refuted by intent and blast-radius because the adjacent documentation explicitly states timestamp-less/malformed timestamps are an immediate availability-biased compatibility exception. The modern completed-cleanup Finding survived unanimously.

## Support path

- `.claude/plans/2026-09-01-pr40-remediation-round6.md`

## Validation

Focused modern cleanup/status tests; typecheck and unused-code; full-tier lint; authoritative unit and smoke suites; diff check; registered remediation; verified index; normal push.

## Validation receipt

- Exact modern completed-reservation cleanup and escalation-precedence regressions: passed.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 1 changed production TypeScript file, 0 violations.
- Authoritative unit suite: 232 files, 6,050 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
