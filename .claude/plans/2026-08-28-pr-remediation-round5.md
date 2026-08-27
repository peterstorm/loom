# PR Remediation Round 5 — Fail-Closed Cleanup Identity

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `7e174eb75736115dbfd8b8133fbcfe428a02109b`
- Source review: `review-20260827T192344Z-deterministic-task-completion-oracle-post-remediation-8`
- Source digest: `ce6920f5f04b6ff3334db186c7d9ff88d9c8ec506520d6e8bae7badef608e72d`
- Exact frozen scope: the 126 paths in the source review's immutable `result.json.scope`.

## Mandatory critical remediation

1. Return a structured cleanup error for absent or invalid `session_id`; name that roster, pointer, sidecar, and machine-binding cleanup could not be addressed and remains pending TTL recovery.
2. Return a structured cleanup error for missing `agent_id`; do not report passthrough when no exact cleanup identity exists.
3. Add focused direct-handler and dispatch regressions proving both identity failures propagate as errors rather than successful cleanup.

## Advisory dispositions

- `silent-failure-hunter-3` and `silent-failure-hunter-4` — accepted: preserve primary read/write failures when descriptor close also fails, and wrap loom-status StateManager construction in its actionable UI error boundary. Both are adjacent shell error-boundary fixes.
- `pr-test-analyzer-1` — accepted: tighten helper marker parsing so prefix-positive values such as `trueish` are not accepted as `true`, with a regression.
- `pr-test-analyzer-2` — accepted: add malformed/coexisting persisted new-test observation regressions at the TaskGraph parser boundary.
- `comment-analyzer-1`, `comment-analyzer-2`, and `comment-analyzer-3` — accepted: correct the three stale symbol/line references.
- `code-reviewer-1`, `code-reviewer-2`, `type-design-analyzer-1`, `architecture-tech-lead-1`, `architecture-tech-lead-2`, `code-simplifier-1`, `code-simplifier-2`, and `code-simplifier-3` — deferred: they require independent transaction/type/module refactors or unrelated cleanup beyond this narrow cleanup-identity remediation. Each remains recorded in the source review.

## Refuted audit

No critical was refuted. Reproduction, intent, and security lenses unanimously upheld both criticals.

## Validation

Typecheck/unused; focused cleanup/dispatch/no-follow/Pi/helper/StateManager tests; full bounded Vitest; smoke suite; changed-production lint; `git diff --check`; distill apply-mode pass; registered remediation; verified-index installation; commit/push; fresh canonical review/refutation.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-28-pr-remediation-round5.md`
- `scripts/smoke-review-panel.sh` — updates an out-of-scope smoke fixture to carry the now-required Agent cleanup identity.
