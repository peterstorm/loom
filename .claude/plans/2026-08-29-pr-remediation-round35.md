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
1. **`installWaveReviewRuns` in-lock re-proof** (`engine/src/handlers/helpers/programs/wave-gate.ts`):
   it installs a batch prepared *before* the state lock was taken. The existing
   `installs the exact pure preparation roster, contexts, epoch, and reviewer slots` test pins the
   happy path only — nothing proves the registration is still current at commit time.
2. **Adjudicate the reviewer-retry finding** (`engine/src/handlers/subagent-stop/store-reviewer-findings.ts:143`):
   an unreadable transcript resolves the slot as `evidence-failed` (`unavailableReviewerResolution`),
   which the Wave epoch already counts as `attempted: 1`, so a hook-side read failure spends a
   semantic attempt. Left unchanged deliberately: attempt 2 still exists, both harnesses agree, and
   "capture failure should not consume a semantic attempt" is a semantics change that needs evidence
   of a real stuck Wave before it is made — not a speculative authority edit.
3. **Root-only tests** use `if (runningAsRoot) return;` and silently pass; replace with
   `it.skipIf(root)` so the skip is visible (three sites:
   `engine/tests/pi-extension-review-events.test.ts:1714, 2436, 2492`).
4. **Pin the graphless miss in the real harness.** The arm added below is unit-tested at the pure
   decision; its wiring inside `extension.ts`'s `tool_result` handler should be pinned by extending
   the existing case `names a graphless spawn's missing review result without calling it an
   orchestration failure` with
   `expect(written).toContain("never arrived and cannot be recorded as evidence_capture_failed")`.
   That fixture file is 4,988 lines and its harness read cost was not justified in this increment;
   the file is also a candidate for splitting.

### 10. Wave slot identity hashed the whole registration — `engine/src/core/wave-review-authority.ts`
`prepareWaveReviewBatch` derived every slot/request id from
`JSON.stringify({ runId, registration, batchEpoch, subject, taskRun })`. Spreading the registration
object made slot identity depend on recovery bookkeeping (`restart`, `orphanRecovery`) and on a
caller's JSON key order — either of which re-derives every slot in the Wave and orphans the captures
already written against the previous ids. Identity is now an explicit projection of what the slot is
actually an authority over: run, Wave, roster, and the registration digest. Two tests added; the
invariance test was confirmed to fail against the previous derivation.

## Fixed after the first round-35 pass (same review authority)

### 8. Phase artifacts adopted a sibling run's spec — `engine/src/handlers/subagent-stop/advance-phase.ts`
The hook judged a transcript-supplied `spec_file` with `resolvesWithin(path, ".claude/specs")` while
the Pi shell judged the same field with `phaseArtifactUpdates(paths, state.spec_dir)`. The core
module's own doc states the rule: *a run scoped to `.claude/specs/2026-08-16-thing` must not adopt a
`spec.md` from a sibling run*. The hook's parser filtered by `filePath.includes(specDir)` — the
substring form this codebase already rejected, defeated by `..` segments that only `resolve` collapses.
The hook now crosses the same seam (`classifyPhaseArtifact(path, locked.spec_dir ?? SPEC_ARTIFACT_DIR)`)
and classifies **before** any filesystem probe, so an out-of-scope path is never even stat'd.

`engine/tests/handlers/subagent-stop/advance-phase-artifacts.test.ts` (4) enters the artifact-write
block for the first time — the pre-existing "locked Phase advances" case never supplied
`agent_transcript_path`, so the guarded branch it names was never executed. The traversal case was
verified to fail against the previous condition before the fix was restored.

### 9. A graphless batch reported nothing when reserved results never arrived — `pi/extension.ts`
The whole reporting block was gated on `!spawnedWithoutTaskGraph(reservation)`, so an ad-hoc batch
whose reserved reviewer never returned produced no diagnostic anywhere — while the integration case
named *"names a graphless spawn's missing review result"* asserted only the per-result agent-mismatch
line and never noticed the missing report. The decision is now a pure function
(`unrecordableMissingEvidenceDiagnostic` in `pi/reserved-results.ts`, 2 tests) and the handler emits
it on stderr. It deliberately stays out of `processingErrors`: the prior round recorded that there is
no protected state to file an evidence failure against, and that reasoning holds — what was wrong was
the silence, not the polarity.

## Mandatory remaining (first draft, superseded by the two above)

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
`npm run typecheck` (incl. the widened unused check) clean. Full bounded Vitest after the first pass:
**226 files, 5815 tests passed** (baseline 5780). After items 8–9: **227 files, 5821 tests passed**.
After item 10: **227 files, 5823 tests passed**, including the full Pi extension `tool_result`
integration suite and the 74 `pi-imports` resolution checks. `git diff --check` clean. Smoke scripts
not re-run (no harness-facing CLI surface changed).

One reproduction note worth keeping: the new artifact tests passed against the *unfixed* source until
the traversal path was built by hand — `path.join` collapses `..` lexically, which silently produced
the plain sibling path the parser already rejects. A regression test that passes both ways is worse
than no test; both directions were re-run before committing, for the artifact suite and for the Wave
slot identity test.

## Panel status
The independent panel could not be re-run after the reload: this Pi session's active Loom package is
`loom-benchmark-runtime-3815f65`, whose `scripts/sync-pi-agents.sh` would have to overwrite the
global `~/.pi/agent/agents` definitions before the review agents can spawn, and the CLI mutation
guard refuses every `helper`/`orchestration` command from this worktree for the same reason. Both are
one operator action away (sync agents + `/reload`, or restart Pi from this checkout); neither was
taken unilaterally because they change the operator's environment, not the branch.
