# PR #253 remediation plan — 2026-11-22

- **Branch:** `fix/sweep-protects-open-runs` (worktree `loom-sweep-runs`), head `42ed12f3` at review.
- **Scope:** `all`, the 17 files of the PR diff against `origin/main` (frozen by the review run).
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr253-review`, result digest
  `74f7a88f6fbf1e6331629b83f51ce66f19cf19ea5aefebb7f90c576cacf02ad3`. Seven reviewers. Four were refused once for
  incomplete read coverage and admitted on their second attempt.
- **Policy publication:** `.claude/reviews/review-and-fix-runs/run.pr253-policy`, disposition digest
  `3882eb35b594c0c6c0bb766634a98bef400311977acbb004eed98b9a5c20fc60`.

## Surviving critical findings

None (engine count: 0). No Declared Repair Groups; the remediation runs with `defectFamily: not-required`.

## Refuted critical findings

None.

## Advisory dispositions (DECLARED): all 11 accepted

| Finding | Decision | Fix |
|---|---|---|
| pr-test-analyzer-1 | accepted | `bound-run-liveness.test.ts`: a corrupt `abandoned.json`, a corrupt `program.json` and a `checkpoint.json` that is a directory each answer `unreadable`, never absent or open. |
| pr-test-analyzer-2 | accepted | `cleanup-stale-subagents.test.ts`: an open run still keeps its session idle exactly at the grace cutoff. Registries of a session at the idle cutoff and of the starting session are never read or observed. |
| type-design-analyzer-1 | accepted | `TERMINAL_CHECKPOINT_STATES` holds frozen readonly arrays tested with `includes`. A test proves no caller can push a state. |
| type-design-analyzer-2 | accepted | `SweepCutoffs`, a branded value only `sweepCutoffs(idle, grace = OPEN_RUN_GRACE_MS)` mints. It refuses a negative, NaN or infinite grace, so `openRunMs <= idleMs` holds. `sweepStaleSessions(dir, cutoffs, …)` replaces the two bare numbers. |
| type-design-analyzer-3 | accepted | `RunLivenessObservation` is a discriminated union (`result-published` \| `abandoned` \| `run-files`), matched exhaustively. The shell's null placeholders are gone. |
| comment-analyzer-1 | accepted | The `observeBoundRun` port comment names absent, observed and unreadable. |
| comment-analyzer-2 | accepted | The `bound-run-liveness.ts` header is reworded, the `RUN_FILE_READ_LIMIT` comment names who uses the 16 MiB cap, and `observeBoundRun` has a doc comment giving its check order. |
| architecture-tech-lead-1 | accepted | The pure `entriesWithinOpenRunGrace(mtimes, cutoffs, protected)` sits beside `staleEntries`, with property tests: it partitions the idle-stale entries with the past-grace ones, never offers a protected session, is empty with zero grace, and handles both exact edges. |
| architecture-tech-lead-2 | accepted | Same fix as type-design-analyzer-2: one `SweepCutoffs` argument. |
| code-simplifier-1 | accepted | The private `readTrackingEntry` returns text, absent or unreadable (reported). `graphBoundSessions` and `sessionsWithOpenRuns` share it. |
| code-simplifier-2 | accepted | `parsePublishedSessionRunBindingRegistry` reuses `isRecord` from `core/plain-record`. |

## Paths touched

- In the frozen scope: `engine/src/core/run-liveness.ts`, `engine/src/orchestration/bound-run-liveness.ts`,
  `engine/src/orchestration/session-run-bindings.ts`,
  `engine/src/handlers/session-start/cleanup-stale-subagents.ts`, the three test files, and
  `docs/feature-guard-map.md` (derived counts restamped).
- Support paths outside the scope: `pi/extension.ts` (the Pi startup sweep builds `sweepCutoffs`), and this plan.

## Noted, not in the inventory

The comment-analyzer's refused first attempt said ADR-0101 line 57 calls `readCheckpointNow` something "the
handle gains", while it is a module function that takes the handle. That attempt was refused for read coverage,
so the finding is not in the published inventory and is not fixed here.

## Validation

- `bun run typecheck` (engine plus `../pi`)
- `bun run lint` (whole project)
- `bunx vitest run` (full engine suite) and `bunx vitest run tests/docs/`
- The registered remediation runs its own selected checks; none are required for `not-required`.
