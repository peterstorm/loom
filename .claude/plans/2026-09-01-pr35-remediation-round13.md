# PR #35 remediation — round 13

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Base: `main` at `3de455c2f1580c2429d52ae6e286650ec5727392`
- Reviewed head: `61e9de16974c4b1b5054ea8a08b1ca781d37bd4e`
- Review Run Directory: `review-20260901T104816Z-10698`
- Result digest: `ec35173a2837fc8b0b6dcaa5bf08efa059032713c09fc22ff34a87a4b108eff3`
- Exact frozen scope: the 140-path `scope` array in `.claude/reviews/review-and-fix-runs/review-20260901T104816Z-10698/result.json`
- Outcome: 0 critical Findings, 10 advisories, 0 refuted critical Findings

## Critical Findings

None.

## Advisory dispositions

### Accepted

1. `code-simplifier-2` — `describePortError` nests cause classification inside an optional-cause ternary.
   - Fix: return immediately for an absent cause, then format the present cause with one flat conditional.
   - Reason: this is a complete, behavior-preserving, interface-preserving local simplification with an existing focused test oracle.

### Deferred

1. `pr-test-analyzer-1` — RunDirHandle anchor-wrapper close-failure coverage.
   - Reason: deterministic close-fault injection requires a narrow close capability seam; global filesystem mocking would weaken the security-boundary test.
2. `pr-test-analyzer-2` — `withShadowGit` cleanup-failure coverage.
   - Reason: deterministic cleanup-fault injection requires a narrow cleanup capability seam; it is not justified solely for advisory coverage in this pass.
3. `type-design-analyzer-1` — `ExactImplementationSettlement` discriminated union.
   - Reason: changes settlement interfaces and dependent rendering; requires a coordinated ADT migration.
4. `type-design-analyzer-2` — `PiReviewAttemptAuthority` legacy/slot-bound union.
   - Reason: changes persisted and runtime authority construction/consumption across Pi result handling; requires a dedicated migration.
5. `type-design-analyzer-3` — `ReviewRun` legacy/engine-owned Wave union.
   - Reason: changes a persisted TaskGraph schema and all review-run consumers; requires compatibility planning and migration.
6. `architecture-tech-lead-1` — pure Wave Gate aggregate commands outside `StateManager`.
   - Reason: this is an interface and persistence-boundary redesign, not a local remediation.
7. `architecture-tech-lead-2` — consumer-owned Run Directory capability projections.
   - Reason: this is a broad interface-segregation migration affecting many callers and tests.
8. `architecture-tech-lead-3` — pure Pi session lifecycle reducer.
   - Reason: this is a multi-callback lifecycle and effect-interpreter redesign requiring dedicated property and integration tests.
9. `code-simplifier-1` — split the 622-line `resumeWaveGateFacade` into phase helpers.
   - Reason: the function’s effect order and recursive resume policy are authority-sensitive; a dedicated behavior-pinned refactor is safer than incidental churn in this pass.

### Dismissed

None.

## Refuted-finding audit

No critical Findings were emitted, so no Refutation Panel ran and no Findings were refuted.

## Implementation

1. Establish the focused `effect-runner` baseline.
2. Flatten `describePortError` without changing output, error classification, timing, or interfaces.
3. Re-run the focused oracle, TypeScript gates, full unit suite, and smoke suites.
4. Run `distill` in apply mode and record the applied move plus skipped deeper opportunities.
5. Use registered remediation with this plan as an explicit support path, install the verified index, commit, and push normally.

## Validation commands

- `env -u PI_CODING_AGENT bunx vitest run tests/orchestration/publication-faults.test.ts --testTimeout=120000 --maxWorkers=1`
- `bun run --cwd engine typecheck`
- `bun run --cwd engine test:unit`
- `bash scripts/smoke-panel-mode.sh`
- `bash scripts/smoke-review-panel.sh`
- `bash scripts/smoke-standalone-review.sh`
- `bash scripts/smoke-orchestration-facades.sh`
- `bash scripts/smoke-pi-resources.sh`
- `bash scripts/smoke-task-graph.sh`
- `git diff --check`

## Validation receipt

- Focused `publication-faults` baseline: 83 passed.
- Focused `publication-faults` after the move: 83 passed.
- TypeScript typecheck and unused-code gates: passed.
- Authoritative unit suite: 231 files, 6022 passed, 1 platform skip, 0 failures.
- Smoke suites: panel mode 22/22, review panel 19/19, Standalone Review, six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.

## Distill apply-mode receipt

Applied one move: flattened `describePortError` with an absent-cause guard and one present-cause formatter. The public interface, diagnostic bytes, throw classification, and effect ordering are unchanged; the focused 83-test oracle stayed green.

Skipped every deeper opportunity listed above: cleanup fault seams, authority ADTs, capability projections, aggregate extraction, the Pi lifecycle reducer, and the Wave façade split all change interfaces, persistence, effect sequencing, or architectural seams and therefore belong to dedicated `deepen` work. No new wrongness was discovered.
