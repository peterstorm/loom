# PR Remediation Round 3 — Restored Authority and Dual-Failure Diagnostics

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `71faa5200f81532d9a4c04c7a5b0650c9fd4e480`
- Source review: `review-20260827T171440Z-deterministic-task-completion-oracle-post-remediation-6`
- Source digest: `e2f5b26485deffae683f4308a05764e4dd1c6c3d93eb749b14371dc227b7f7a4`

## Mandatory critical remediation

1. Parse non-null lease-registry `previous` through the canonical TaskGraph pointer parser before minting registry authority; add final-release regression proving a relative predecessor cannot be restored.
2. Preserve both the primary “SubagentStop recorded NOTHING” TaskGraph-resolution diagnostic and an independent cleanup failure; add dual-failure dispatch coverage.
3. Correct the Implementation Observation comment to include unavailable exact byte observation as a fail-closed invalidation cause.

## Advisory dispositions

All nine advisories are deferred as independent cleanup/test/type-design work. The exact lock-token comparison advisory is sound and accepted in this round because it is a one-line authority-hardening change in the same no-follow module; add a focused regression. The remaining Pi test gaps, call-start diagnostic ADT, Task type deepenings, and simplifications remain deferred.

## Refuted audit

No critical was refuted; all three were unanimously upheld.

## Validation

Typecheck/unused; focused pointer, dispatch-resilience, implementation-application, and no-follow tests; full bounded Vitest; smoke suite; changed-production lint; diff check; distill apply-mode pass; registered remediation; verified-index installation; commit/push; fresh canonical review/refutation.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-28-pr-remediation-round3.md`
