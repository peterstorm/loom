# PR Remediation — Wave Gate recovery authority

- Branch: `feat/architecture-panel-mode-plan`
- Authoritative review run: `.claude/reviews/review-and-fix-runs/run.ZcClUcPwkW`
- Result digest: `f8d68b1039c4616a2645005ab11fd5448be5926044f8f4731e169f1d20ba24d8`
- Scope: exact immutable `scope` in that run's `result.json`

## Surviving critical findings and fixes

1. `code-reviewer-1` — Bind Wave advisory approval to the exact current advisory-set request ID and accept only the exact `{ "kind": "approve" }` disposition. Reject arbitrary, stale, or malformed decision events.
2. `silent-failure-hunter-1` — Fail closed when any same-session Pi run binding is inaccessible during durable reservation recovery; do not accept a recovered reservation under unresolved cross-run ambiguity.
3. `silent-failure-hunter-2` — Retain Pi runtime/write-grant cleanup bookkeeping after shutdown cleanup failure so a later shutdown can retry revocation and housekeeping.
4. `pr-test-analyzer-1` — Add regression coverage proving an old Wave spec-check request is rejected after the review epoch changes and cannot update `spec_check`.
5. `type-design-analyzer-1` — Parse direct-child run basenames through `parseOrchestrationRunId` before constructing `RunDirectoryReference`.

## Advisory disposition

No advisories were explicitly accepted in this fresh review run. They are recorded in `result.json` and are not part of this remediation.

## Refuted critical audit

None. The panel upheld all five critical findings.

## Additional Wave recovery correction requested by the operator

- Complete exact current Review Packets before refutation.
- Recover missing/invalid current slots through durable attempt-2 publication.
- Replay captured attempt-2 transcripts after crash windows.
- Reject stale reviewer/spec-check authority.
- Bind Wave refutation identity to the exact readiness epoch.
- Issue a fresh packet after implementation invalidates a completed generation.

## Validation

```bash
cd engine && bunx tsc --noEmit
cd engine && npm run test:unit
cd engine && env -u PI_CODING_AGENT npm run test:smoke
git diff --check
```
