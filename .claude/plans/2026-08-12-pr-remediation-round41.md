# PR Remediation — Round 41 (2026-08-12)

## Adjudicated authority

- **Branch:** `feat/architecture-panel-mode-plan` (no push until verified)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.lsnjSarQIp`
- **Result:** `result.json` — 0 surviving criticals, 0 refuted, 31 advisories (17 unique claims + marker echoes), no panel (zero criticals)
- **Dispatch:** user authorized "fix what you deem worthy" → accepted advisories below; unaccepted advisories are recorded and deferred.

## Accepted advisories (13)

1. **SFH-1** `run-directory-handle.ts:225` — `parseRunDirectoryIdentity` bare `statSync` catch maps EACCES/ELOOP/ENOTDIR to "run directory does not exist". Fix: narrow to ENOENT, rethrow otherwise (mirror `readCheckpoint`). Add test.
2. **SFH-2** `orchestration-programs.ts` `handleWaveReviewContext` — absent vs corrupt conflated; corrupt `wave-review-authority` sections silently skip evidence reconciliation. Fix: tri-state result; corruption blocks the run loudly (`waveBlocked`) at every reconciliation site.
3. **SFH-3** `reconcile-implementation-proof.ts:291` — `cat-file`/`merge-base` catch discards the cause. Fix: include the underlying error.
4. **PTA-1** `wave-gate-machine.ts:742` — pin `proveWaveGateNextAction` pre-proof foreign-runId rejection with a direct unit test.
5. **PTA-2** `wave-gate-machine.ts:1100` — pin `commitWaveGateCompletion` authority-drift and already-terminal-in-history reject branches with direct tests.
6. **PTA-3** `run-directory-handle.ts:815` — pin `readCaptureRejection` malformed/foreign-marker refusal with a direct test.
7. **PTA-4** `git-remediation.ts:132` — pin `runGit` process-level failure arms ("git could not be run", signal) via an injectable spawn seam (exported for tests).
8. **PTA-5** `run-directory-handle.ts:975` — delete dead `captureIntoSlot` (defined, never called, never exported).
9. **TDA-4** `state-manager.ts:584` (finding `types.ts:116`) — load boundary accepts empty `untrusted` label. Fix: require non-empty trimmed label.
10. **TDA-2** `types.ts:696` — `phase_artifacts`/`skipped_phases` mutable beside the readonly rationale; `parseTaskGraph` passes disk references through unfrozen. Fix: `readonly` types + freeze at load boundaries (`state-manager.ts`, `validate-task-graph.ts`).
11. **CA-1** `run-directory-handle.ts:246` — `isPristine` JSDoc: name the permissible empty `requests/correlators/` child.
12. **CA-2** `orchestration-programs.ts:193` — `unstaged` JSDoc: "untracked non-ignored files" (match `standalone-review.ts:77` wording).
13. **Engine retry defect (tool bug, reported out-of-band, included here)** — standalone reviewer semantic rejection → attempt-2 retry (already implemented + tests; recorded in the plan as part of this remediation's scope).

## Unaccepted advisories (deferred with reasons)

- **TDA-1** `WaveGate.blocked` quartet semantics — requires deciding the intended derivation; `reviews_complete && blocked` is a legitimate mid-adjudication state; speculative semantic change risks breaking existing wave states.
- **TDA-3** `PolicyResult` vs `DomainResult` — canonicalRecord reuse would create an import cycle (`orchestration-contract` imports `model-profiles`); correct fix belongs to the structure-module extraction (architectural).
- **Arch-1** Fugue DAG layer production-dead — wire-or-delete is an architectural decision (1,264 lines + dependency); not a point fix.
- **Arch-2** `orchestration-contract.ts` god module — module split is a large refactor; deferred.
- **Arch-3** `config.ts`/`git.ts` import-time I/O — frozen-vs-lazy contract is deliberate; unifying is architectural.

## Validation

- `cd engine && env -u PI_CODING_AGENT bunx tsc --noEmit`
- `cd engine && env -u PI_CODING_AGENT bunx vitest run --testTimeout=15000`
- `bun scripts/smoke-orchestration-facades.ts` + `bash scripts/smoke-panel-mode.sh && bash scripts/smoke-review-panel.sh && bash scripts/smoke-standalone-review.sh && bash scripts/smoke-pi-resources.sh`

## Remediation run

- Fresh Run Directory under `.claude/reviews/review-and-fix-runs`, `start remediation` with `sourceRun = run.lsnjSarQIp`, `supportPaths = [this plan]`; resume to `done`; engine installs the verified index; then commit + push.
