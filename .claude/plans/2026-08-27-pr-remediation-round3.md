# PR Remediation Round 3 — Duplicate Start Atomicity

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `307bab81901e0de255cf5667ceb9e51a9077fb04`
- Source review: `review-20260827T142457Z-deterministic-task-completion-oracle-post-remediation-2`
- Source digest: `ab9f4ba4f7cec4cd66f9d5b435a5f47472adb710b729908ba185a2cc76e2f94d`

## Mandatory critical remediation

1. Distinguish implementation-sidecar publication as `published` versus `already-owned`. Duplicate SubagentStart delivery never marks the shared sidecar as newly created and every later failure path preserves the original sidecar, roster, machine binding, and exact registration.
2. Move persisted pointer-sidecar inspection, lease acquisition/release, duplicate resolution, and sidecar publication/removal into the same session pointer lock. Duplicate claim performs no registry mutation; release cannot interleave inside claim validation.
3. Correct the identity comment to document the intentional split between machine-capable parsed identity and non-authorizing roster placeholder identity.

## Advisory dispositions

### Accepted

- Update the ledger overview to document optional `callId`.
- Correct the base-directory comment to state that all platforms realpath-canonicalize the trusted base.

### Deferred

- Failed persisted-claim fault injection requires an injectable pointer persistence adapter; existing malformed-sidecar and duplicate lifecycle tests cover fail-closed behavior without adding a test-only production seam.
- Pure/runtime config split, explicit Wave Gate proof values, Trusted Review Witness extraction, and the two newly suggested simplifications are separate architecture/distill slices.

### Dismissed

- Advisory projection fallback remains the explicit ADR-0006 decision: projection failure degrades to the prior usable status path.

## Refuted audit

- No source critical was refuted by the panel threshold.

## Validation

- Typecheck and unused checks.
- Duplicate SubagentStart, implementation sidecar, pointer lease, no-follow, and ledger focused tests.
- Full bounded Vitest (`--testTimeout=15000 --maxWorkers=4 --minWorkers=1`).
- Full smoke suite.
- Changed-production full-tier lint and `git diff --check`.
- Registered remediation, exact verified-index installation, commit, push, and fresh canonical review.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-27-pr-remediation-round3.md`
- `engine/src/implementation-attempt-sidecar.ts`
- `engine/tests/handlers/implementation-attempt-sidecar.test.ts`
