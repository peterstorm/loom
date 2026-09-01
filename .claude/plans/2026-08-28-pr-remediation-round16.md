# PR Remediation — Deterministic Task Completion Oracle Round 16

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source: `review-20260828T150807Z-deterministic-task-completion-oracle-post-remediation-20`
- Digest: `a67dd19d5fbe1cea978fcc7e1bec9b7ab8f4a1205685ea8ecaa28b4e9ec043a1`

## Mandatory fixes
1. Restrict new-test/assertion evidence to supported test-source paths carried by each Git patch; strip TSX/JSX text while retaining brace expressions. Add Markdown and JSX laundering regressions.
2. Revoke `wave_review_epoch.specCheckSlotAuthority` whenever changed-byte reclamation invalidates evidence for that Wave. Add late-result authority regression.
3. Make missing reserved-review settlement return exact applied indexes from the locked update; emit success only for durable changes and processing errors for no-ops.
4. Make failed reviewer-process settlement decide task presence and actual mutation inside `updateAndReturn`; report disappeared/no-op settlement as an error.

## Advisories
- Accept the capture-payload and Git-test comment corrections.
- Defer the WaveGate parser wording correction with non-empty Wave readiness tuples, Phase/config/ReviewRun deepenings, state-manager deduplication, baseline type aliasing, and missing-spec-check extraction: each remaining item is outside the critical authority paths or changes shared interfaces.

## Validation
Focused parser/reclamation/Pi tests; typecheck and unused checks; full bounded Vitest; smoke 23/23; changed-production lint; diff check; exact remediation index installation; commit/push; fresh canonical review with refutation.
