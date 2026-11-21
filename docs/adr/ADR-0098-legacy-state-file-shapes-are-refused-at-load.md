# ADR-0098: Legacy State File shapes are refused at load

## Status
Accepted (2026-11-20). Retires the read-time migrations for State Files written before attempt authority, frozen Proof, the Verification Manifest and the Wave completion suite.

## Context
The State File parser still migrated shapes no current writer produces:

- A Task in `executing_tasks` with no `active_implementation_attempt`. The only writer that grows `executing_tasks` (`applyTaskExecutionAuthorityBatch`) installs an attempt in the same write, so this shape exists only in files written before attempt authority. The parser minted `legacy_execution_reservation` for it, and both harnesses kept an authority-free Stop path around it: a Task guessed from the sole executing entry (inferSoleExecutingTask) or, on Pi, from the parent's spawn prompt, an untrusted resolution (applyUntrustedStopResolution) that could only quarantine, and a capability-free infrastructure cleanup.
- An implemented or completed Task with no frozen Proof. Population and every settlement write a Proof, so the parser's `legacy_missing_proof` marker existed only for older files, with a positive-migration arm in `reconcile-implementation-proof`.
- An executing TaskGraph with no `verification_manifest`. Population freezes one in the same write that enters `execute`, and the Wave completion suite arrived in the same change. Readers fell back to `legacyDefaultVerificationManifest()`, the Wave completion suite returned a `legacy` not-required disposition, completion archived a schema-1 terminal entry with no suite, and the direct `complete-wave-gate` helper existed only for such graphs (it refused every graph with a manifest).
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

Deleted with them: Task.legacy_execution_reservation, the legacy_missing_proof lifecycle arm, the authority-free Stop path on Claude Code (`update-task-status`) and on Pi (`subagent-result`, `subagent-settlement`, and the Pi Task guess from a parent's spawn prompt), UntrustedStopResolution, applyUntrustedStopResolution, applyCompletionInfrastructureFailure, core/task-attribution.ts, the legacy positive migration in `reconcile-implementation-proof` (a recovered Task is now pending with a satisfied Proof and `revalidation_required`), the `legacyDefaultVerificationManifest` read-time fallbacks, the Wave completion suite's legacy not-required disposition, the schema-1 completed Wave Gate arm, the complete-wave-gate helper (its gate observers remain in `wave-gate-observers.ts`) and the legacy Wave Gate compatibility migration (legacy archive Section C).

An implementation Agent that stops with no attempt authority now settles nothing: nothing can be executing without an attempt, so there is nothing to release or quarantine.

Kept, because a graph a current engine loads still reaches them: the pre-I6 era (a frozen manifest without `testFiles`, ADR-0025 / FR-005); Forward Fix history (ADR-0086); `new_tests_required`, its waiver and the `newTestsRequired` Proof Obligation input (population still writes the flag); the spec-check's manual route for a graph that is not yet executing; the `legacy-unavailable` completion suite readiness of a graph with no manifest (every phase before `execute`); and the historical attempt records that predate versioned attempts.

## Consequences

**Positive:**
- `Task` and `TaskGraph` hold only states a current writer produces; the attempt-authority invariant (executing iff an attempt is registered) is enforced at load, so Stop handling has one path per harness.
- The migration code and the tests that pinned it are gone.

**Negative:**
- A State File from an older engine cannot be resumed; its run is finished on that engine or started again.
