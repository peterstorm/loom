# Slice 3 Completion Oracle — PR Remediation Round 2

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `d76c7854f13b64acf184e23244eb39183f84e6b4`
- Review run: `review-20260825T020234Z-deterministic-task-completion-oracle-rereview`
- Result digest: `89678d4e5ded1fb5970fa1605cb36421d89200cecf0fc21939237c82173c1540`
- Frozen scope: exact 77 paths in authoritative result
- Refutation panel: reproduction, intent, security; threshold 2
- Surviving criticals: 5
- Refuted criticals: 0

This plan is the only anticipated support path outside the frozen scope.

## Mandatory critical remediation

1. `code-reviewer-1`: `parseCompleteClaudeJsonl` must parse every syntactically valid record through a bounded Claude transcript-record schema before minting `CompleteClaudeJsonl`. Reject non-object, array, missing/non-string `type`, malformed `message`, non-string role, unsupported content, and malformed content blocks. Preserve forward-compatible surplus fields. `{}`, `null`, scalar, array, and invalid-tail fixtures settle exact authority as infrastructure unavailable and never implement.
2. `code-reviewer-2`: Task-local observation must bind current Git HEAD to `ImplementationAttemptAuthority.headSha`. Observe HEAD before and after all path/baseline/dirty-set reads using fixed argv; both must equal attempt HEAD. Missing, changed, or unreadable HEAD is infrastructure unavailable. Add a real Git regression where a foreign path is modified and committed during the attempt; it cannot disappear from authority.
3. `comment-analyzer-1`: rename/reword `exactTaskBytesChanged` as a conservative changed-or-unobservable fact, or split exact observation from invalidation. Comments and types must match unavailable behavior.
4. `comment-analyzer-2`: correct Pi binding comment: unbound results preserve authority; exact and proven legacy settlement paths release bound reservations, including ordinary terminal transitions and completed/missing cleanup.
5. `comment-analyzer-3`: correct reopening comment. Reopening invalidates accepted completion/review authority and requires fresh Proof, but retained prior Findings/test evidence remain active remediation/audit inputs where gate/status intentionally reads them.

## Advisory dispositions

### Accepted

1. `silent-failure-hunter-1` and `silent-failure-hunter-2`: stale-session stat/remove failures retain path, operation, errno/cause in returned diagnostics; no count-only collapse.
2. `pr-test-analyzer-1`: add fault coverage proving sidecar primary publication and temporary-cleanup failures are both retained. Introduce only the narrow filesystem operation seam needed for a plain fake; no mocking framework.
3. `type-design-analyzer-1`: internally model new-test evidence as `not-written | written(non-empty evidence)` and project to legacy Task boolean/string wire fields only at the boundary. Invalid written+empty is unrepresentable in Oracle normalization.
4. `comment-analyzer-4`: correct historical review-output test rationale.
5. `architecture-tech-lead-1`: consolidate duplicate Claude/Pi exact settlement orchestration into one neutral shared shell function accepting normalized transport facts and explicit repository/new-test ports. Transport adapters retain identity/transcript parsing and rendering only. Preserve distinct proof policies.
6. `code-simplifier-1`: sort failure kinds once.
7. `code-simplifier-2`: sort accepted review scope once.
8. `code-simplifier-3`: replace boolean-mode canonical-path parsing with typed empty-allowed and non-empty parsers so the tuple invariant is returned directly.

### Deferred

None.

### Dismissed

None.

## Constraints

- No Task/project subprocess checks; fixed-argv Git HEAD observation is an authority read, not a completion command.
- Strict transcript record parsing must remain forward-compatible with real Claude top-level surplus fields.
- HEAD drift is infrastructure uncertainty and consumes no semantic attempt.
- Pi structured provenance and Claude ledger provenance remain distinct.
- Exact settlement receipts, sidecar no-replace, StateManager lockstep, and legacy cleanup-only rules remain unchanged.
- Slice 4 alone dispatches attempt 2/escalation.
- Apply distill after green baseline, one move at a time.

## Remediation outcome

Implemented all 5 surviving criticals and all 8 accepted advisory groups. No Slice 4 dispatch or arbitrary Task subprocess was introduced. The remediation changes 23 artifacts: 13 production TypeScript files, 8 test files, 1 JSONL fixture, and this plan. The working tree was not staged or committed.

## Final validation — 2026-08-25

1. Focused Oracle/application/registration/sidecar/Claude/Pi/StateManager/reopening/stale-cleanup set: **14 files passed, 313 tests passed**.
2. Bounded full unit suite (`env -u PI_CODING_AGENT npm run test:unit`): **223 files passed; 5,482 tests passed; 1 skipped; 0 failed**.
3. Smoke suite (`env -u PI_CODING_AGENT npm run test:smoke`): **all gates passed** — panel mode 22/22, review panel 19/19, standalone review PASS, orchestration façades PASS, Pi resources PASS, validate-task-graph 23/23.
4. TypeScript (`npm run typecheck`): **PASS**, including the unused-local/parameter check. Standalone `npm run typecheck:unused`: **PASS**.
5. Full-tier lint over every changed production TypeScript file: **13 passed, 0 failed**.
6. Transcript coverage: modern real-record fixture plus `{}`, `null`, scalar, array, malformed blocks, and invalid-tail exact-settlement cases: **PASS**.
7. Real temporary-Git committed-foreign-path, before/after HEAD drift, and unreadable-HEAD cases: **PASS**; all remain non-positive infrastructure outcomes.
8. Shared exact-settlement parity for accepted, semantic, infrastructure, stale, duplicate, new-test unavailable, and Pi provenance retention: **13/13 passed**.
9. Sidecar dual publication/cleanup failure and stale-cleanup operation/path/cause diagnostics: **PASS**.
10. `git diff --check`: **PASS**.
