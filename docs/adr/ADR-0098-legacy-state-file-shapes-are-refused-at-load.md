# ADR-0098: Legacy State File shapes are refused at load

## Status
Accepted (2026-11-20). Amends ADR-0004, ADR-0052 and ADR-0096. Retires the read-time migrations for State Files written before attempt authority, frozen Proof, the Verification Manifest and the Wave completion suite.

## Context
The State File parser still migrated shapes no current writer produces:

- A Task in `executing_tasks` with no `active_implementation_attempt`. The only writer that grows `executing_tasks` (`applyTaskExecutionAuthorityBatch`) installs an attempt in the same write, so this shape exists only in files written before attempt authority. The parser minted `legacy_execution_reservation` for it, and both harnesses kept an authority-free Stop path around it: a Task guessed from the sole executing entry (inferSoleExecutingTask) or, on Pi, from the parent's spawn prompt, an untrusted resolution (applyUntrustedStopResolution) that could only quarantine, and a capability-free infrastructure cleanup.
- An implemented or completed Task with no frozen Proof. Population and every settlement write a Proof, so the parser's `legacy_missing_proof` marker existed only for older files, with a positive-migration arm in `reconcile-implementation-proof`.
- An executing TaskGraph with no `verification_manifest`. Population freezes one in the same write that enters `execute`, and the Wave completion suite arrived in the same change. Readers fell back to legacyDefaultVerificationManifest(), the Wave completion suite returned a `legacy` not-required disposition, completion archived a schema-1 terminal entry with no suite, and the direct `complete-wave-gate` helper existed only for such graphs (it refused every graph with a manifest).
- Task fields replaced long ago: `new_tests_written` / `new_test_evidence` (now `new_test_observation`) and the `unresolved_repository_paths` carry (no writer since every settlement retires the attempt boundary).

Each migration kept a type arm, a branch in every consumer, and tests that pinned behavior no current run can reach. A survey of the State Files on the maintainer's machines found none carrying these shapes.

## Options Considered

1. **Refuse the shapes at the load boundary (chosen).**
   - Pros: the states become unrepresentable in `Task` and `TaskGraph`, so every guarding branch, both harnesses' authority-free Stop path and the legacy helper are deleted. One operator message names the shape and the way forward.
   - Cons: an old in-flight run can no longer be resumed on this engine.
2. **Keep migrating at load.**
   - Cons: the cost above stays, for files nobody has.
3. **A one-shot upgrade command that rewrites old files.**
   - Cons: the rewrite would have to invent attempt authority and Proof the old engine never recorded; it would be the same migration code moved, not deleted.

## Decision
**`parseTaskGraph` refuses a legacy State File shape with one message naming the shape and ADR-0098, before any Task is migrated. Re-populate instead: finish the run on the engine release that wrote it, or move the State File aside and run `/loom` again from its spec and plan.**

Refused:
- a Task in `executing_tasks` without `active_implementation_attempt`, and a persisted `legacy_execution_reservation` marker;
- an `implemented` or `completed` Task without a frozen `proof`, and a persisted `legacy_missing_proof` marker;
- `current_phase: "execute"` without `verification_manifest` (earlier phases legitimately carry none);
- a Task carrying `new_tests_written`, `new_test_evidence` or `unresolved_repository_paths`;
- a `wave_gate_history` entry of schema 1 (a completion archived without a Wave completion suite).

Deleted with them: Task.legacy_execution_reservation, the legacy_missing_proof lifecycle arm, the authority-free Stop path on Claude Code (`update-task-status`) and on Pi (`subagent-result`, `subagent-settlement`, and the Pi Task guess from a parent's spawn prompt), UntrustedStopResolution, applyUntrustedStopResolution, applyCompletionInfrastructureFailure, core/task-attribution.ts, the legacy positive migration in `reconcile-implementation-proof` (a recovered Task is now pending with a satisfied Proof and `revalidation_required`), the legacyDefaultVerificationManifest read-time fallbacks, the Wave completion suite's legacy not-required disposition, the schema-1 completed Wave Gate arm, the complete-wave-gate helper (its gate observers remain in `wave-gate-observers.ts`) and the legacy Wave Gate compatibility migration (legacy archive Section C).

The helper's GitHub Issue notifications went with it: marking the Wave's Task checkboxes in the Issue body, posting the Wave summary comment, and writing that summary to `.claude/reviews/wave-N-review.md` when the comment failed. They ran only for a graph with no manifest, because the helper refused every other graph. The registered `/wave-gate` never had them, so no run a current engine loads loses them. `github_issue` stays on the TaskGraph: `populate-task-graph --issue` records it, the session-start resume context shows it as the run's Issue link, and the archived completed graph names it in its file name (`completed_task_graph-issue-N-…`). The engine writes nothing to the Issue after it is created.

An implementation Agent that stops with no sidecar and nothing executing now settles nothing: nothing can be executing without an attempt, so there is nothing to release or quarantine. A sidecar that exists but cannot be read stays an error even then, because the attempt it named may already have been released.

Kept, because a graph a current engine loads still reaches them: the pre-I6 era (a frozen manifest without `testFiles`, ADR-0025 / FR-005); Forward Fix history (ADR-0086); `new_tests_required`, its waiver and the `newTestsRequired` Proof Obligation input (population still writes the flag); the spec-check's manual route for a graph that is not yet executing; a graph with no manifest (every phase before `execute`), whose completion suite readiness status reports `unavailable` (the Wave Gate seams parse a `ManifestedTaskGraph`, `core/manifested-task-graph.ts`, so no readiness value represents a missing manifest); and the historical attempt records that predate versioned attempts.

## Consequences

**Positive:**
- `Task` and `TaskGraph` hold only states a current writer produces; the attempt-authority invariant (executing iff an attempt is registered) is enforced at load, so Stop handling has one path per harness.
- The migration code and the tests that pinned it are gone.

**Negative:**
- A State File from an older engine cannot be resumed; its run is finished on that engine or started again.

## Addendum: the loaded graph is built from parsed fields only

The PR #252 review found that `parseTaskGraph` still spread the raw document under its parsed sections, and the stored-Task parser spread the raw Task under its parsed fields (behind a `Partial<TaskCommonMetadata>` cast). A field no parser covered therefore loaded as raw JSON with only the type the cast gave it: `test_evidence`, `start_sha`, `failure_reason`, `retry_count`, `reserved_at` and the Requirement trace arrays on a Task, and any stray key at either level.

Both are now assembled from parsed values only. Every Task and TaskGraph field has a parser, and two compile-time checks hold it: a table keyed by every field of `Task` (and of `TaskGraph`) lists the keys a State File may carry, and the assembler demands, as `never`, any field no parser installs. A stored key outside the table is refused at load with one message naming it (`unknown Task field "…"`, `unknown TaskGraph field "…"`), judged after every other rule so a field's own refusal still wins. Dropping the key instead would lose it silently on the next write. The pre-refactor `tests_passed` Task field is one such key: legacyTestsPassedNote, which explained it on a loaded Task, could no longer fire and is deleted.

Assembly also fixes key order. A loaded TaskGraph and its Tasks carry their keys in the parser's order, not the file's, so a digest over the loaded graph (`waveGateAuthorityDigest`) does not depend on how the file was written, and the first engine write of a hand-ordered file may reorder its keys. A refusal that must leave the file's bytes untouched hands the loaded graph back to `updateAndReturn` unchanged rather than a fresh copy of it, which is what `store-test-evidence` now does.

The one value installed by assertion is `review_run`: `reviewRunError` and `slotAuthorityError` judge every field of both Review Run arms, and the State File boundary installs the record they proved rather than rebuilding its nested evidence records field by field.
