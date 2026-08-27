# PR Remediation Round 4 — Cleanup Outcome Integrity

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `3f3a764d0362da62f0df62084b39e4cd5bed82d9`
- Source review: `review-20260827T145202Z-deterministic-task-completion-oracle-post-remediation-3`
- Source digest: `95e141f2e008d732eec5ace4c08953d78e94f69b3c0f53c21817a565b4043a92`

## Mandatory critical remediation

1. Preserve successful live implementation-sidecar publication when only staged-temp cleanup fails. Return publication disposition plus a cleanup diagnostic; do not roll back live attempt authority. Add fault-injection coverage.
2. Make machine-binding cleanup throw on every non-ENOENT failure so SubagentStop can aggregate and surface failed release.
3. Make active-roster cleanup strict for the same reason; no stderr-only success path remains.
4. Update deterministic implementation status documentation to mark Slice 3 Task-local attempt authority shipped while keeping Slice 4 retry dispatch proposed.

## Advisory dispositions

- `UntrustedStopResolution` ADT migration: deferred to the bounded retry slice; transport normalization still parses before persistence.
- Pure/runtime config split, explicit Wave Gate proof values, Trusted Review Witness extraction, exact-HEAD helper, workspace-readiness helper, and Pi pointer cleanup helper: deferred as separately reviewable architecture/distill work.

## Refuted audit

- No source critical was refuted.

## Validation

Typecheck/unused, focused sidecar/ledger/cleanup tests, full bounded Vitest, smoke suite, changed-production lint, diff check, registered remediation, verified-index installation, commit/push, then a fresh canonical review.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-27-pr-remediation-round4.md`
