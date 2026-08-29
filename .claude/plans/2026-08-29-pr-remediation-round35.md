# PR Remediation Round 35

Independent post-remediation pass (multi-reviewer panel + first-hand reproductions) run against
`fix/deterministic-task-completion-post-merge` at `67857d2`, then fixed test-gated, one move at a
time. Verdict at review time was **do not open the PR yet**: two findings were reproducible as code
execution and fabricated evidence, and both lived on the completion-evidence path.

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Review baseline: HEAD `67857d2` (newer than `review-20260829T010347Z-…-post-remediation-39`, so the
  final merge commit had never been reviewed).
- Reproduced first-hand in a scratch repo before any edit: `.gitattributes` textconv execution inside
  the hook process, and `+++ b/fake.test.ts` header spoofing producing `new_tests_written: true` for
  a non-test file.

## Mandatory fixes (done this round)

### 1. Diff helpers executed workspace-controlled git drivers — `engine/src/utils/git.ts`
`diffFiles`/`diffFilesSince`/`diffUntracked` ran `git diff` with the workspace's own config and
attributes, so a planted `.gitattributes` + `diff.<name>.textconv` ran an arbitrary program inside the
SubagentStop hook, and a `+++ b/…` hunk line could impersonate a file header.
- One central `DIFF_DRIVER_SUPPRESSION = ["--no-textconv", "--no-ext-diff"]` injected in `diffArgs`,
  so no entry point can forget it.
- `diffEnvironment()` sets `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM`, `GIT_TERMINAL_PROMPT=0`.
- `--end-of-options` on committed revisions; the missing `--` path separator added to `diffUntracked`.
- `DIFF_EVIDENCE_BUDGET_BYTES` (16 MiB) with `isEvidenceBudgetFailure` renaming `ENOBUFS` into a
  diagnostic the completion path can attribute; shared `diffExecOptions(root)`.
- Dead exported `diff()` deleted (no caller; it was the un-hardened twin).

### 2. New-test evidence forgery — `engine/src/utils/git.ts`
Header parsing now accepts at most one `+++ b/<path>` per `diff --git` entry (`headerClaimed`), and the
test/assertion counters skip lines that are not attributed to a proven test-source path
(`isAttributedPath`). Every `language === null ||` fail-open disjunct in `countNewTests` /
`countAssertions` is gone: unknown language no longer counts as evidence.

### 3. Runner tally of zero was a pass — `engine/src/core/test-evidence.ts`
Numeric capture for maven and vitest plus `tallyCount`, so "0 tests executed" can no longer satisfy a
regression obligation. Aligns the transcript path with `judgeTestRun`.

### 4. Manual spec-check writes needed no authority — `engine/src/core/spec-check.ts`
`specCheckAuthorityProblem` + `SpecCheckRequestAuthority` moved into the core so the Wave Gate façade,
the Claude SubagentStop hook, the Pi shell, and the `store-spec-check` helper answer from ONE
predicate. Added `SPEC_CHECK_OVERRIDE:` parsing and `decideSpecCheckManualOverride`
(`allowed | refused-active | requires-reason`): the helper now refuses while a registered Wave Gate
owns the Wave, and on a modern graph demands an attributable reason that is echoed to the operator.

### 5. One dead recovery guard poisoned the State File forever — `engine/src/orchestration/no-follow-fs.ts`
The guard is mutual exclusion with no lease, and nothing ever reclaimed it. Now
`reclaimAbandonedRecoveryGuard` decides abandonment from the guard itself: a pid the kernel reports
gone is reclaimed immediately; a guard whose token never landed is reclaimed only after
`RECOVERY_GUARD_ABANDONED_MS`; a live claimant is obeyed exactly as before, and the reclaim is logged.
An exclusively-created lock observed before its owner token lands is a claim in flight, so recovery
stands down instead of throwing "malformed owner token".
The owner-token grammar was duplicated between `parseLockOwner` and the new reclaim — the duplicate
silently matched nothing (no capture group) and made the first attempt a no-op. Unified as
`OWNER_TOKEN` + `ownerPid()`; the new test is what caught it.

### 6. Silent success on evidence that was never captured — `pi/subagent-result.ts`
- A malformed legacy transcript recorded `evidence was not accepted` on the log only and returned an
  empty `processingErrors`, so the parent read the step as clean. Failure diagnostics are now returned
  as processing errors. Two existing tests pinned the old polarity; they are updated with the reversed
  reasoning rather than weakened.
- Attribution by inference (task id unextractable, `executing_tasks` holds exactly one Task) is no
  longer a stderr warning. `resolveImplementationBindingForResult` carries the inference and
  `applyImplementationPiResult` reports it as a processing error for both the verdict and the
  cleanup-only legacy release path.

### 7. Dead-code gate blind to the Pi adapter — `engine/package.json`
`typecheck:unused` grepped only `^(src|tests)/`, so every `../pi/*.ts` unused import/locals violation
was discarded — including a live one in `pi/subagent-result.ts` (removed). Pattern now
`^(\.\./pi/|(src|tests)/)`.

## Tests added
- `engine/tests/core/spec-check-manual-override.test.ts` (10) — one predicate per authority shape,
  including "the exact captured authority does not make the manual route legal".
- `engine/tests/orchestration/anchored-lock-liveness.test.ts` (3) — dead guard reclaimed, live guard
  obeyed, empty in-flight lock never stale.
- `engine/tests/utils/git.test.ts` / `git.property.test.ts` — real-patch fixtures (`patch()` helper),
  textconv driver never executes, `--output=` baseline refused, option-shaped untracked path treated
  as a path, forged header refused, unattributed additions refused, complete-postimage pinned on all
  four diff entry points; property generators rewritten so both arms are reachable.
- `engine/tests/handlers/helpers/store-spec-check.test.ts` (+2), `tests/handlers/update-task-status.test.ts`,
  `tests/handlers/subagent-stop/update-task-status.property.test.ts` — realistic patches instead of
  bare `+` lines.
- `engine/tests/pi/subagent-result.test.ts` — inferred attribution reported as a processing error.

## Mandatory remaining (next round, before the PR)
1. **`pi/extension.ts` graphless missing-result reporting.** The block at the
   `if (!spawnedWithoutTaskGraph(reservation) && (missingReviews.length > 0 || missingSpecChecks.length > 0))`
   guard skips the whole reporting arm when no TaskGraph was active at spawn: reserved reviewer and
   spec-check slots that never arrive produce no diagnostic and no processing error. Nothing can be
   persisted in that case, so the fix is to report the counted miss (diagnostic + processing error)
   instead of dropping it. Needs Pi parity coverage with the Claude side.
2. **`engine/src/handlers/subagent-stop/advance-phase.ts` artifact-update guard** (~line 251) has no
   test; it can overwrite authoritative artifact paths from a transcript-supplied path.
3. **`wave-gate.ts installWaveReviewRuns`** must re-prove its registration inside the state lock;
   `core/wave-review-authority.ts` slot/request identity hashes the whole `registration` object rather
   than an explicit projection.
4. **`store-reviewer-findings.ts` (~150)**: a transcript read failure consumes the only semantic
   reviewer retry.
5. **Root-only tests** use `if (runningAsRoot) return;` and silently pass; replace with
   `it.skipIf(root)` so the skip is visible.

## Deferred by decision (documented, not forgotten)
- Runner-report **orthogonal facts** redesign (roadmap item 18): retire `analyzeNewTests`,
  `countNewTests`, `countAssertions`, `FULL_POSTIMAGE_CONTEXT` as evidence authority and gate
  `new_tests_written` on path-scoped facts (proven test-source change + runner report). This round
  closed the forgery; the redesign removes the surface.
- Consolidating the spec-check capability predicate across all six call sites (two of six done), and
  the conjunct differences between the Wave Gate and hook variants.
- CONTEXT.md entries for Wave Review Authority, Wave Review Registration, Spec-Check Slot Authority,
  Capability Acquisition, Machine Binding Release; `docs/README.md` still indexes ADR-0001..0004 while
  `docs/adr/` holds 0005..0007.

## Validation
`npm run typecheck` (incl. the widened unused check) clean. Full bounded Vitest: **226 files, 5815
tests passed** (baseline 5780; +35 this round). Focused re-run of the Pi, spec-check, lock-liveness and
git suites: 522 passed. `git diff --check` clean. Smoke scripts not re-run this round (no harness-facing
CLI surface changed); the commit is local — push and the fresh canonical review panel are pending the
operator's go.
