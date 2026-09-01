# PR Remediation Round 13

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T124247Z-deterministic-task-completion-oracle-post-remediation-17`
- Source result: `.claude/reviews/review-and-fix-runs/review-20260828T124247Z-deterministic-task-completion-oracle-post-remediation-17/result.json`
- Result digest: `189405ff8af300bc4c136896be3b2b79fb0d8d35555e116c48cf696a4d16c599`
- Frozen scope: the source review's exact 53-path scope; this plan and any necessary regression path omitted from that scope will be registered as remediation support paths.

## Mandatory critical remediation

1. **Exact Claude phase authority** — require `current_phase === completedPhase` before artifact handling, recheck the same invariant inside artifact persistence, and recheck it inside the final locked transition update. A completion for a future phase fails closed; an already-past duplicate remains a diagnosed no-op.
2. **Complete-postimage assertion evidence** — collect Git patches with full-file context, reset lexical state at each file boundary, model Python triple-quoted strings and Java text blocks across physical lines, and count only assertion syntax on added executable-code lines. Add example and property regressions.
3. **Exact Pi spec-check attempt authority** — carry a typed Wave spec-check authority in the Pi spawn reservation and require exact locked run/Wave/batch/slot/attempt agreement before `applySpecCheckPiResult` may mutate `spec_check` or a Wave Gate. Missing, stale, or contradictory authority returns a processing error with state unchanged.

## Advisory dispositions

### Accepted

- `code-reviewer-3`: allow exact epoch/slot/attempt authority, rather than non-empty reviewer-run state, to establish spec-check packet membership after reviewer runs close.
- `silent-failure-hunter-1` and `silent-failure-hunter-2`: preserve typed Oracle settlement error details in Pi diagnostics while distinguishing a missing transition from an explicit error.
- `pr-test-analyzer-2`: retain and re-run the existing direct CLI regression proving a stale Wave spec-check epoch slot/attempt is rejected before evidence storage; add further coverage only if the changed authority path is not exercised.
- `comment-analyzer-1`: correct the assertion scanner comment to describe compacted executable text.
- `comment-analyzer-2`: remove fixture comments that only restate helper names.
- `code-simplifier-1`: reuse the existing discarded-evidence helper for reviewer warn/error branches.
- `code-simplifier-2`: name and reuse declared-path overlap detection.
- `code-simplifier-3`: name and reuse Wave workspace HEAD lookup.

### Deferred

- `architecture-tech-lead-1`: extracting the complete TaskGraph codec is a broad module-boundary refactor unrelated to these authority defects and needs its own reviewed slice.
- `architecture-tech-lead-2`: deepening the Claude settlement port is a broad shell/core refactor; the current criticals do not require it.
- `architecture-tech-lead-3`: splitting the Wave Gate core is a broad public-surface/module-locality change and should not be mixed into an authority remediation.

### Dismissed

- None.

## Refuted-finding audit

The panel refuted `pr-test-analyzer-1`: `engine/tests/handlers/helpers/orchestration.test.ts` already drives durable attempt-2 issuance and cross-process submission, so deleting the attempt-2 persistence would fail existing coverage. Do not remediate this refuted Finding.

## Validation and release

1. Run focused phase, Git evidence, Pi result, Pi extension, Wave façade, and simplification regressions with bounded Vitest workers.
2. Run `npm run typecheck` including unused-symbol checks.
3. Run the full bounded Vitest suite and `npm run test:smoke` with inherited Pi runtime variables removed.
4. Run changed-production lint and `git diff --check`.
5. Register every dirty path outside the frozen scope as a support path, then install the exact verified remediation index.
6. Commit and push without force.
7. Start a fresh canonical standalone review, execute the exact reviewer batch, resume through the three-lens Refutation Panel, and publish the authoritative result.
8. Open no PR while any critical Finding survives.
