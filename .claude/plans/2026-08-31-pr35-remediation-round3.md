# PR #35 remediation — fresh review round 3

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- PR: [#35](https://github.com/peterstorm/loom/pull/35)
- Reviewed head: `7bfaf22f3cb5fdde029394061b405788b9c65b2f`
- Base: `origin/main` at `3de455c2f1580c2429d52ae6e286650ec5727392`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260831T145536Z-17336`
- Frozen exact scope: the 123 paths recorded in the authoritative `result.json` `scope` array.
- Review totals: 7 reviewers emitted 5 critical and 19 advisory Findings. The three-lens Refutation Panel upheld all 5 criticals; none were refuted.

## Mandatory surviving criticals

1. `code-reviewer-1` — Git diffs still execute repository-configured clean/process filters.
   - Execute all diff and index probes through a fresh minimal shadow Git administration directory exposing only the real worktree, index, object directory, exact HEAD, and object format.
   - Do not expose repository config, hooks, info attributes, fsmonitor, or ambient Git authority. Preserve fixed driver suppression, binary patches, complete postimage context, budgets, and patch-only status-1 handling.
   - Add real clean-filter regressions for tracked utility and tracked/untracked Review Packet paths.
2. `silent-failure-hunter-1` — malformed or duplicate call-start entries can reveal an older duplicate stamp.
   - Parse the call-start file atomically: any malformed member or duplicate id makes the complete file corrupt (`null`). Make direct duplicate lookup fail closed too.
   - Update pure and filesystem-adapter regressions to prove malformed/duplicate files cannot vouch for freshness and are replaced only by a new PreToolUse stamp.
3. `comment-analyzer-1` — the RunDirHandle header overstates that callers cannot select an artifact path.
   - State the exact API: no arbitrary filesystem path, but callers may submit parser-proven relative destinations within the fixed `artifacts/` namespace.
4. `comment-analyzer-2` — run identity docs claim post-check swaps cannot redirect later Darwin pathname operations.
   - Split the guarantee by platform and retain the documented Darwin post-acquisition parent-swap risk.
5. `comment-analyzer-3` — `StateManager.update` promises a pure callback although authority-sensitive callers deliberately re-observe external evidence under the lock.
   - Document the actual atomic callback contract and its lock-time observation semantics; do not claim purity the type cannot enforce.

## Advisory dispositions

### Accepted

1. `silent-failure-hunter-2` — replace catch-all artifact-directory absence with an ENOENT-only typed inspection; retain the original cause for every other stat failure.
2. `pr-test-analyzer-1` — add ambient `GIT_DIR`/`GIT_INDEX_FILE` isolation coverage at the shared Git boundary.
3. `pr-test-analyzer-2` — add a captured non-Wave request regression with omitted agent type and faulting metadata to prove routing is bypassed and cleanup still runs.
4. `pr-test-analyzer-3` — pin both successful multi-megabyte diff evidence and explicit over-budget failure.
5. `comment-analyzer-4` — qualify stale-lock recovery as descriptor-relative on Linux and proven-path-relative on Darwin.
6. `comment-analyzer-5` — distinguish immutable spec authority from the documented architecture-plan fallback/recovery behavior.
7. `comment-analyzer-6` — replace the undefined historical deprecation label with durable deletion criteria.
8. `code-simplifier-2` — replace Maven's nested verdict ternary with one small pure classification function.
9. `code-simplifier-3` — give exact Wave capture-rejection identity matching one private predicate.

### Deferred

1. `type-design-analyzer-1` — `ReviewRun` legacy/exact ADT requires persisted migration of all reducers.
2. `type-design-analyzer-2` — `PiReviewAttemptAuthority` legacy/exact ADT changes the Pi adapter contract.
3. `type-design-analyzer-3` — category-discriminated `ReservedSlot` changes all reservation constructors and appliers.
4. `type-design-analyzer-4` — lifecycle-evidence ADT requires event/recovery migration across the Wave Gate machine.
5. `type-design-analyzer-5` — a branded `TestEvidence` verdict union changes all consumers and persistence shapes.
6. `architecture-tech-lead-1` — extracting all Wave transition policy from the facade is a dedicated lifecycle refactor.
7. `architecture-tech-lead-2` — moving Wave aggregate transitions out of StateManager requires a domain repository/transaction redesign.
8. `architecture-tech-lead-3` — removing import-time config discovery changes process-wide configuration wiring.

### Dismissed

1. `code-simplifier-1` — Start/Stop parsers share mechanics but intentionally carry different exact field contracts and diagnostics; parameterizing hook names and projections adds a shallow abstraction without reducing invalid states.
2. `code-simplifier-4` — a broad review-ready graph fixture would hide scenario authority in overrides and couple otherwise explicit orchestration tests.

## Refuted-finding audit

No critical Finding was refuted. `comment-analyzer-1` was refuted by intent but upheld by reproduction and blast-radius, meeting the two-lens threshold; the other four were unanimously upheld.

## Support paths outside frozen review scope

The registered remediation must authorize:

- `.claude/plans/2026-08-31-pr35-remediation-round3.md`

All production and regression-test paths selected above are already inside the frozen 123-path scope.

## Validation

```bash
bun run --cwd engine typecheck
(cd engine && env -u PI_CODING_AGENT bunx vitest run \
  tests/utils/git.test.ts \
  tests/handlers/helpers/quality-programs.test.ts \
  tests/machine/call-start.test.ts \
  tests/orchestration/publication-faults.test.ts \
  tests/handlers/subagent-stop/dispatch-resilience.test.ts \
  tests/pi-test-evidence.test.ts \
  tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts \
  --testTimeout=120000 --maxWorkers=4)
bun run --cwd engine test:unit
env -u PI_CODING_AGENT bun run --cwd engine test:smoke
git diff --check
```

## Validation receipt

Validated against the remediated working tree:

- `bun run --cwd engine typecheck` — clean, including unused locals and parameters.
- Focused Git, Review Packet, call-start, artifact publication, dispatch, test-evidence, and Wave authority suites — **297 passed, 0 failures**.
- `bun run --cwd engine test:unit` — **230 files, 5961 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke` — panel mode 22/22, review panel 19/19, standalone review, all six façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check` — clean.

`PI_CODING_AGENT` was unset only for validation subprocesses so fixtures did not inherit this live Pi session's runtime handshake.

## Distill apply-mode receipt

Green baseline: the focused 297-test suite above.

Moves applied:

1. Extracted pure Maven verdict classification and removed its nested ternary; the existing test-evidence suite stayed green.
2. Consolidated exact Wave capture-rejection matching into one private predicate shared by retry and exhaustion paths.
3. Replaced duplicate call-start filtering/allocation with one fail-closed scan; 26 call-start tests stayed green.
4. Removed a newly redundant direct ELOOP promotion test and strengthened the pre-existing end-to-end ELOOP assertion instead.

Skipped opportunities:

- The five type-state migrations and three architectural seam migrations remain dedicated `deepen` work as dispositioned above.
- Start/Stop parser parameterization and a broad orchestration fixture were dismissed because they hide distinct contracts behind shallow indirection.
- The shadow Git adapter retains explicit authority discovery, setup, execution, and cleanup steps: each hides a distinct security invariant and passes the deletion test.
