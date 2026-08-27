# PR Remediation — Fail-Closed Filesystem and Completion Authority

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `729f94b586d9a996b46eb61eb730404e506290d2`
- Source review: `review-20260827T151640Z-deterministic-task-completion-oracle-post-remediation-4`
- Source digest: `0ab816cff3bd944ba343f31ad59b6e67492b2b81d8866d99264b10f92d3a6ff6`
- Frozen scope: the exact 117 paths in the source review's `result.json`

## Mandatory critical remediation

1. **Darwin directory-creation race** — make every pathname mutation that requires descriptor-relative authority reject a real-path anchor before side effects. Open-based Darwin operations retain `O_NOFOLLOW_ANY`; unsupported `mkdir`, `rename`, and `unlink` operations fail closed. Add a platform-shape regression proving directory creation does not begin without descriptor mutation authority.
2. **Lost pointer cleanup authority** — retain the persisted binding sidecar and throw an explicit cleanup failure when its exact lease registry/lease is absent (`not-owned`). Add crash-state coverage for a missing registry.
3. **Malformed active TaskGraph pointer** — parse readable pointer bytes as one non-empty canonical absolute path before comparison. Empty, relative, whitespace-padded, or non-normalized content emits a diagnostic and returns active fail-closed. Add focused regressions.
4. **Malformed lock owner** — parse the lock owner token before liveness checks; stale recovery proceeds only for a valid positive safe PID proven dead. Malformed/partial owner bytes throw and preserve the lock. Add fault-injection coverage.
5. **Clarify artifact comment mismatch** — correct the shared resolver comment to state the invariant actually enforced: both phases require an existing spec; architecture additionally reads it for clarification markers.

## Advisory dispositions

- Duplicate non-implementation SubagentStart rollback ownership: **deferred**. It changes acquisition-order/ownership interfaces and warrants a separate exact-capability change rather than being mixed into these source criticals.
- Missing `store-test-evidence` markers: **deferred**. The claim is sound but changes a legacy helper wire contract outside this remediation's authority concerns.
- Pure Wave Gate StateManager commands: **deferred**. Architectural deepening, independently reviewable.
- Split Wave Gate module surface: **deferred**. Architectural deepening, independently reviewable.
- Simplify `parseTaskRoster` count map: **deferred**. Behavior-preserving cleanup unrelated to the mandatory authority fixes.

## Refuted audit

No source critical was refuted. The pointer-sidecar finding was refuted by the intent lens but upheld by reproduction and security, so it remains mandatory.

## Validation

1. Typecheck and unused checks.
2. Focused no-follow filesystem, pointer lease, stale reservation, phase-order, and cleanup tests.
3. Full bounded Vitest suite.
4. Full smoke suite.
5. Changed-production programmatic lint and `git diff --check`.
6. Distill apply-mode pass with focused tests kept green.
7. Registered remediation and exact verified-index installation.
8. Commit and push without force.
9. Fresh canonical standalone review and refutation.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-28-pr-remediation.md`
