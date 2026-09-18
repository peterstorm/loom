# PR #55 Remediation — run.pr55-source-review-1 and run.pr55-source-review-2

**PR:** https://github.com/peterstorm/loom/pull/55 (`fix/spawn-cwd-orchestration-graph` → `main`)
**Install commits:** `d575846` (round 1) and `b7b4c83` (round 2), both pushed 2026-09-17; base fix commit `7b598fa`
**Review runs:** `run.pr55-source-review-1` (6 reviewer slots) and `run.pr55-source-review-2` (7 reviewer slots) — both standalone-review, both abandoned at the refutation panel (schemaVersion 2 verifiers are Read/Glob/Grep-only by agent definition, the refutation-authority payload is decimal-encoded inside the packet, and no Bash is available to decode it — verifiers emit `unavailable` with empty verdicts, both attempts consumed, no state-machine bypass); remediation applied directly in both rounds

## Round 2 (run.pr55-source-review-2)

### Criticals — repaired (1 of 28 findings; 27 advisories)

1. **`standalone-review:pr-test-analyzer-1` (pi/spawn-graph.ts:78)** — `observeSpawnBatchGraph` crashed with a TypeError on a well-formed batch whose harness context omits cwd: `extractSpawnBatchCwds` crashed on `resolve(undefined, ...)` instead of answering. **Verified by direct reproduction** (the probe crashes; the test harness doubles build contexts without a cwd field, so `ctx.cwd` is undefined) **and by the pre-PR comparison**: the pi-extension integration suite passed 146/146 at 8357cda and failed 29/146 in the delivered tree — the 29-failure pool was introduced by 7b598fa, this PR's own feature work, not pre-existing debt. **Repaired** (commit `b7b4c83`): the malformed call is representable in the signature (`defaultCwd?`), resolves to the documented unresolved → runtime polarity per the module contract, and a regression test pins the omitted-cwd polarity and the bare-entry batch. With the fix the engine suite is fully green (8893 passed | 1 skipped) and the integration suite is back to 146/146.

### Round-2 advisories (27, nonblocking per the reviewers' own reasons)

Deferred — the shipped code is correct and the gaps are expressiveness improvements: the spawn-graph fold's two-local state encoding (test-pinned), the DiffDeps port's dual-regime signature (documented focused-test shell, no frozen-scope caller omits deps), TaskExecutionRegistrationOutcome's registered/empty branch (downstream gates fail closed).

### Round-2 disposition notes

- The refutation panel (3 verifier slots issued for the one critical) was NOT run: schemaVersion 2 verifiers cannot decode their refutation-authority payload (no Bash in the agent definition; the payload is a decimal-encoded byte array), so both attempts would be consumed and the run terminal-blocked — the same stuck mechanism round 1 verified at source level. The critical was adjudicated by direct reproduction instead, which the verifiers' lens ('reproduction') could not perform.
- The critical's remediation stands on its own verification: probe crash before → runtime polarity after; 146/146 at 8357cda; 146/146 after the fix; full suite green.

## Round 1 dispositions

### Criticals — repaired (4 distinct from 5 findings)

1. **Alignment gate armed on the wrong flag** — `pi/extension.ts:1724` gated alignment on `graphIsActive` instead of `orchestrationGraphActive`. Repaired; the rollback path passes the same spawn cwd.
2. **Spawn-graph aggregation collapses "unseen" with "absent"** — `pi/spawn-graph.ts:123` used `null` as both the probe sentinel and a legitimate no-graph answer. Repaired: the branch now carries a `seen` flag separating "probed" from the value.
3. **File presence resolved against `process.cwd()`** — `task-local-completion.ts` classified a worktree-only file as absent when the settlement ran from a runtime rooted elsewhere. Repaired: `inspectFilePresenceAt(root, path)` added and `realDiffDepsAt` roots the presence check; vocabulary (`canonicalRepositoryPaths`) preserved.
4. **Zero tests for the new spawn-graph module** — new `engine/tests/core/spawn-graph-observation.test.ts`: 10 tests covering observeSpawnBatchGraph polarities (incl. the fixed absence-first branch), findTaskGraphPathFrom cross-cwd resolution, and root-explicit settlement diff-deps.

### Advisories — accepted and applied

- After-HEAD authority failure chains the inner observation failure as `cause` (task-local-completion.ts, silent-failure-hunter-2).
- `analyzeNewTests` names the absent-evidence reason for no-declaration diffs: `"no test declarations found in modified files"` (silent-failure-hunter-3); three pinned `evidence === ""` assertions updated to the named reason.
- `assertReviewPanelDisjoint` ternary collapsed — `reviewPanelOverlap`'s `reserved` parameter carries the same default the one-argument call triggers (pure pass-through, config.ts).

### Advisories — removed as dead code

- `utils/git.ts`: `exec`, `execArgs`, `headSha`, `defaultBranch`, `mergeBase`, `filterTestFiles` — zero src callers (callers went direct to the hardened boundary), plus their callerless tests (13 removed from `git.test.ts`) and stale doc references. `repositoryRoot` restored after an accidental deletion during the same pass (live export, used by `pi/extension.ts`).

### Advisories — deferred / skipped

- `defaultTaskGraphExists` kept: documented contract + per-call git-spawn cost.
- Deepen candidates (god-module splits, taskGraphRelatives per-call detectHarness): deferred — interface changes, not behavior-preserving cleanup.

## Validation

- Typecheck: `bun engine/scripts/typecheck.ts` — exit 0, no src/test errors (remaining errors are pre-existing `@fuguejs` node_modules raw-.ts noise outside the script's `^(src|tests)/` scope).
- **Full suite: 8893 passed | 1 skipped (8894) — fully green** after the round-2 fix (the 29-failure pool from round 1 was this PR's own regression, now repaired).
- Affected suites green: `pi-extension-review-events.test.ts` (146 — the round-2 regression suite), `update-task-status.test.ts` (80), `task-local-completion.integration.test.ts`, `implementation-completion.property.test.ts`, `git.test.ts` (61), `update-task-status-machine.test.ts` (16), `review-panel-config.test.ts` (13), `spawn-graph-observation.test.ts` (11, incl. the round-2 regression test).

## Support paths

- `engine/src/utils/git.ts`, `engine/src/handlers/helpers/task-local-completion.ts`, `engine/src/config.ts`, `pi/extension.ts`, `pi/spawn-graph.ts`, `engine/tests/core/spawn-graph-observation.test.ts`

## Round 3 (run.pr55-source-review-3) — COMPLETED

**First completed standalone-review run through the engine's full state machine.** 7 reviewer slots, all 7 accepted (2 after attempt-2 retries for "payload must be exactly one strict JSON object" — the operator's transcription garble, repaired by clean re-dispatch), aggregate: **29 advisories, ZERO criticals** → no refutation panel → done, `result.json` published (73,092 bytes, digest `eb88e543c2d498dd0af555aae6ba35b3550d1556881ccb1cb81871d3306e01b9`).

Zero criticals validates the round-2 repair (`b7b4c83`): the reviewers ran against the repaired tree and found only advisories.

### Round-3 advisories (29) — deferred, nonblocking per the reviewers' own rationales

- silent-failure-hunter: withShadowGit finally-block converts a cleanup failure into a false failure for collected evidence (fail-closed, named, retryable); exact-settlement misidentified 'Task absent' as 'late delivery'.
- pr-test-analyzer: no test pins the batch-level `cwd` arm or the `chain` shape of spawnBatchEntries; pathExistsFailClosed's fail-closed polarity unpinned; spawnCwd registration/rollback test gap.
- type-design-analyzer: ExactImplementationSettlement.infrastructureReason dual-regime polarity; PiSpawnReservation.items[].kind silent parallel-array fallback.
- comment-analyzer: stale `safeRun` symbol reference (dispatch.ts names `runChild`); ambiguous post-validation comment; `manager.update` misnamed method reference (the guarded code calls `updateAndReturn`).
- architecture-tech-lead: config.ts god-module coupling (import-time I/O + load-time assertion drag — the round-1 deferred deepening pass); DiffDeps dual-regime with live production callers omitting deps outside the frozen scope; Trusted Review Witness Aggregate file-private in the extension shell.
- code-simplifier: assertPanelExecuteDisjoint restated default (the round-1 sibling collapse), stale EXECUTE_AGENTS comment, spawn-graph inline comment duplication, after-HEAD double throw, diffUntracked restating its At twin, duplicated `patch` fixture, .tmp-pi debris (removed).

Disposition: all deferred — interface changes (deepen) or nonblocking expressiveness/tidiness; zero criticals in all three rounds.

## Round 4 (run.pr55-source-review-4) — COMPLETED

Second completed standalone-review run through the engine's full state machine. 7 reviewer slots, all 7 accepted (slot 7 after an attempt-2 retry — the reviewer's own emitted payload was structurally invalid JSON, repaired by re-dispatch with the facade-issued retry request), aggregate: **18 advisories, ZERO criticals** → no refutation panel → done, `result.json` published.

Zero criticals across all four rounds. Two operator-facing findings from this run's driving:
- The engine captures the **reviewer's own emitted output** via the spawn correlator, not the operator's stdin bytes — a structurally invalid reviewer emission is what gets admitted/rejected, and fixing the operator's transcript copy does not change the verdict.
- Facade resume mechanics: `resume` is a dedicated CLI operation (distinct from submit short-circuit); it issues the retry batch only after a slot is tombstoned.

### Round-4 advisories (18) — deferred, nonblocking per the reviewers' own rationales

- code-reviewer: RepositoryProbe's isRepo answers for the cached runtime cwd rather than the spawn's pointer-derived root (narrow precondition: runtime outside any git repo); spawn-graph all-or-refuse compares raw resolve() strings without symlink canonicalization; hasTypeScriptTestCall misses the only/skip/todo/fixme modifier family; countAssertions' Java arm misses JUnit's assertTrue/assertFalse family.
- silent-failure-hunter: tool_call guard crash catch writes only error.message, omits err.stack (diagnostic depth, not silence).
- pr-test-analyzer: per-entry malformed arm of extractSpawnBatchCwds unpinned (current polarity correct and reproduced).
- type-design-analyzer: recoverPiSpawnReservation overloads 'standalone' kind on recovered implementation items (prose-only); REAL_DIFF_DEPS mutable vs frozen twin REAL_TASK_LOCAL_PORTS.
- comment-analyzer: `manager.update` misnamed (×2 sites across rounds); stale `safeRun`→`runChild` reference.
- architecture-tech-lead: analyzeNewTests runs the lexical projector twice (countNewTests + countAssertions each rescan); spawnBatchEntries returns unvalidated entries (parse-then-validate).
- code-simplifier (retry): spawn-graph fold two-local encoding (test-pinned, behavior-preserving distill); duplicated malformed-CALL constraint prose; inspectFilePresenceAt one-caller pass-through; dispatcher's repeated push-then-stderr route (~14 sites); the two stale symbol references above.

Disposition: all deferred — interface changes (deepen/distill) or nonblocking expressiveness/tidiness; zero criticals in all four rounds.
