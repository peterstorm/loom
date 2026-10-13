# PR #81 remediation — fail-closed path probes and substitution-embedded test runs

- **Branch:** `fix/fail-closed-probe-defects`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr81-review-1` (standalone v2, 7 reviewers, all captured)
- **Result digest:** `4f663a548c768c96c958b02a85add67b572d6388b09b15010c8d1d3f7a6bbd89`
- **Counts:** emitted/admitted 0 critical, 7 advisory; after refutation 0 surviving critical, 0 refuted critical, 7 advisory
- **Advisory policy publication:** run `pr81-policy-1`, `standalone-disposition-published`, revision `initial`

## Critical findings

None. Defect-family accounting: `not-required`.

## Refuted findings

None.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
|---|---|---|
| pr-test-analyzer-1 | accepted | Pin `cd $(a; b) && npm test` as a deliberate fail-closed null |
| comment-analyzer-1 | accepted | Moved `findClosingParen` doc narrated twin-scanner history; restate the contract |
| architecture-tech-lead-1 | accepted | Route `agent-definition.ts` and `render-pi-agent.ts` ENOENT-only probes through `observePathPresence` |
| architecture-tech-lead-2 | accepted | Move `review-panel.ts`'s remaining `existsSync` guards onto the probe; repo-wide sweep and lint ban → G5a INV-1 |
| architecture-tech-lead-3 | deferred | Substitution-aware splitter also drives the state guard; it is G5a INV-4 work with its own matrix test |
| code-simplifier-1 | accepted | Same comment fix as comment-analyzer-1 |
| code-simplifier-2 | dismissed | Two inline readings; a helper adds a concept for two callers |

## Accepted fixes

- `engine/src/core/shell-substitution.ts`: `findClosingParen` doc states the contract.
- `engine/src/utils/agent-definition.ts`, `engine/src/utils/render-pi-agent.ts`: candidate probes use `observePathPresence` (unknown → the same throw as before).
- `engine/src/handlers/helpers/review-panel.ts`: closure check, both replay guards (shared `priorTallyRefusal`) and the pending-result cleanup use the probe; `existsSync` is gone from the file. An unreadable marker now refuses with "already tallied … cannot observe" instead of failing later at the run-boundary check with a misleading message (defense in depth, not a new defect).
- Tests: `review-panel.test.ts` unreadable-marker tally (fails on the prior code); `extract-evidence.test.ts` pins the trade-off.

## Support paths (outside the frozen review scope)

- `.claude/plans/2026-10-13-pr81-remediation.md`
- `engine/src/utils/agent-definition.ts`
- `engine/src/utils/render-pi-agent.ts`

## Validation

- `npm --prefix engine run verify` (typecheck, full Vitest suite, six smokes)

## Round 2

- **Review run:** `pr81-review-2` (result `baf401ffa67244a7a3fd930c4338e51f021cf1a7b28730c61780e6f0544464bf`): 0 critical, 5 advisory, nothing refuted
- **Policy publication:** `pr81-policy-2` (initial revision)

| ID | Decision | Reason |
|---|---|---|
| pr-test-analyzer-1 | accepted | Unreadable `tally-closure.json` test (fails against main's `existsSync` closure check) |
| comment-analyzer-1 | accepted | Scope the architecture.md bullet to `path-presence.ts` callers; name G5a INV-1 for the rest |
| architecture-tech-lead-1 | accepted | `pathMayExist` names the fail-closed reading once; rules-gate and both review-panel sites use it |
| architecture-tech-lead-2 | deferred | Substitution-aware splitter = G5a INV-4 (same as round 1) |
| code-simplifier-1 | accepted | Same as architecture-tech-lead-1; round 1 dismissed it at two callers |

**Validation:** `npm --prefix engine run verify` passes: 12,262 tests, 1 skipped, all smoke tests.
