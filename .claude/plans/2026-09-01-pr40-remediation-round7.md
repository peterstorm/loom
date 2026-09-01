# PR #40 remediation — round 7

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Reviewed head: `37b3ddb3425f20a359aa031a506d10d1c297d660`
Review Run Directory: `review-20260901T181910Z-2990617`
Result digest: `bf83a3776b6f3f9db2cdc55382954bc80eaee70ae8f9221b8ae5d09422c98579`

## Mandatory fixes

- Route failed and missing exact Pi implementation results through the same pure authority-aware completed/missing cleanup used by successful results.
- Preserve completed proof/evidence while clearing execution membership, authority, Attempt Context, attempt baselines, reservation time, repository carry, and unresolved carry.
- Correct unresolved-path provenance and modern/legacy invalidation documentation.

## Advisory dispositions

Accepted:

- Strengthen completed cleanup fixture with Attempt Context, repository carry, failed-result, and missing-result coverage.
- Clarify harness-specific implementation write authority in the prompt template.
- Reuse `applicationState` and return completed cleanup through `updateAndReturn`.

Deferred:

- Persisted ADTs for Task active state, Attempt Context, Task-local observations, transition facts, and authority batches; Pi spawn transaction; implementation-window extraction; versioned receipt identity: dedicated deepen/schema work.
- Remaining broad reducer/comment consolidation: separate distill work.

## Refutation audit

No critical Finding was refuted. All survived at least intent and security; the provenance/documentation claims were independently confirmed against modern transition code.

## Support path

- `.claude/plans/2026-09-01-pr40-remediation-round7.md`

## Validation

Focused successful/failed/missing modern cleanup, status, type, and documentation contracts; full-tier lint; authoritative unit and smoke suites; diff check; registered remediation; verified index; normal push.

## Validation receipt

- Successful, failed, and missing modern completed-reservation cleanup regressions: passed.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 3 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,051 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
