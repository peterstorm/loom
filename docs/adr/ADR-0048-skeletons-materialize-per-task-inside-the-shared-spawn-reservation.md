# ADR-0048: Skeletons materialize per Task inside the shared spawn reservation

## Status
Accepted (2026-11-07). Records AD-1 of the G2 skeletons plan
(`.claude/plans/2026-11-02-g2-skeletons.md`; spec `.claude/specs/2026-11-02-g2-skeletons/spec.md`). It was
chosen as approach B at the approach gate, and its tie-breaker was the user's primary axis, simplicity
(interview Q3a).

## Context
G2 has the engine write a skeleton for each new file_list path that has at least one export binding and a
supported language (TypeScript or Java). A skeleton is the frozen signatures with unimplemented bodies. The
writing must finish before the implementer is spawned (FR-005). It must never modify a file that already
exists (FR-011). It must regenerate a skeleton that a retry finds missing (FR-032). It must record exactly one
outcome per path (FR-030). The spec does not say where in the engine's lifecycle that write happens. The
placement matters because of what sits around it:

- **Attempt-scope attribution (FR-012).** Every implementation attempt starts from baselines: the repository
  change baseline (`captureRepositoryChangeBaseline`) and the declared-artifact proof and attempt baselines
  (`captureDeclaredArtifactBaseline`). If engine bytes land after those baselines are taken, the proof channel
  counts them as implementer writes, and something has to subtract them later.
- **Two harnesses, many entry paths.** Claude Code registers a spawn in the `validate-task-execution` PreToolUse
  hook, after brief-marker expansion. Pi registers it in `pi/spawn-lifecycle.ts`. A first attempt, a retry and
  an infrastructure respawn all have to see the same skeleton guarantee. Every extra entry point is another
  place where the writer's safety rule (AD-12, INV-3) has to be called correctly.
- **The completion commit is delicate.** The Wave Gate completion commit stamps the Acceptance Freeze under the
  State File lock (ADR-0044). Putting repository writes next to it creates crash windows between a committed
  state and a file that is not yet written.
- **Status is the most-read surface.** Every new top-level status, and every new step in the orchestrator
  runbook, costs every reader something. OOS-009 also rules out a separate command just to generate skeletons.

## Options Considered

1. **B: materialize per Task inside the shared spawn reservation (chosen)**
   - Pros: `registerTaskExecutionBatch` is already the one registration shell that both harnesses call, so one
     call site covers Claude Code, Pi, first attempts, retries and respawns. Skeletons are written before any
     baseline is captured, so FR-012's attempt-scope half holds by construction and needs no subtraction there.
     The completion commit (ADR-0044) is never touched. No new recovery variant and no new runbook step are
     needed (status gains only two reasons and a report field; see Consequences). It is the simplest of the
     three.
   - Cons: registration, which used to make no repository writes, now does I/O and can be refused for
     skeleton reasons. The bytes are written before the locked State File update, so a refused registration can
     leave canonical skeleton files on disk with no record. Only implementation Tasks registered through this
     shell get skeletons, so contract stubs (FR-023) and revision refresh (FR-033) still need their own entry
     points.

2. **A: a shell effect after the previous Wave Gate's completion commit and population**
   - Pros: all of a Wave's skeletons exist as soon as the Wave opens, before any spawn is attempted.
   - Cons: the writes sit beside the most delicate locked commit. A crash between the commit and the effect
     needs a recovery path, and that recovery path is B anyway. Retries and respawns still need their own write
     path (FR-032). That makes three writer entry points and more coordination with contract revision. Roughly
     30% more effort.

3. **C: a status-gated `materialize-wave-skeletons` recovery step before `spawn-wave-implementation`**
   - Pros: the materialization step is explicit and visible to the orchestrator.
   - Cons: it widens the most-read status union and the orchestrator runbooks. A retry path in the spawn is
     still needed for deleted skeletons. It leans toward the dedicated generation command that OOS-009 rules
     out. Roughly 20% more effort.

## Decision
**`registerTaskExecutionBatch` (`engine/src/handlers/task-execution.ts`) runs one step, `materializeTaskSkeletons`
(`engine/src/orchestration/skeleton-materialization.ts`). The step comes after the ownership and eligibility
checks and before `captureRepositoryChangeBaseline` and the declared-artifact baseline captures. Its records and
outcomes are committed in the same locked update as the reservation.**

The order inside registration:

1. Ownership (`taskExecutionOwnershipError`) and per-Task eligibility (`taskExecutionDecision`), then resolving
   the repository context.
2. `materializeTaskSkeletons(root, graph, taskIds)`, which returns a `DomainResult<TaskSkeletonRegistration,
   Problems>`:
   - **Pre-G2 graphs.** A graph with no `export_bindings` stamp materializes and records nothing.
   - **Stage two.** Each binding held by a registering Task is resolved (`resolveBindings`) against its
     contract's types file, through `observeFrozenSurface`. The contract must be `frozen` or `revised`, and the
     file's bytes must equal the freeze stamp. A missing alias, a non-function or generic alias, digest drift,
     an unreadable types file, an unfrozen contract or a language mismatch blocks the whole batch. Every
     problem is named, and none of these checks writes a byte.
   - **Plan.** Each registering Task's production paths (`productionFiles`) are observed: absent, or present
     with their digest and the digest of the canonical skeleton. The pure `planTaskSkeletons` derives the outcomes
     through `skeletonOutcomesOf` (AD-13, INV-4) and a list of actions. **Create** writes a missing bound skeleton:
     a first attempt, a retry whose skeleton was deleted, or a respawn (FR-005, FR-032). **Adopt** records
     canonical bytes that are on disk with no record, for example after a refused registration. **Refresh**
     rewrites an untouched skeleton that was generated from an older surface.
   - **Write.** Every byte goes through the no-clobber writer (`engine/src/orchestration/skeleton-writer.ts`,
     AD-12, INV-3): `createSkeleton` publishes with `link` and turns `EEXIST` into `exists`. `refreshSkeleton`
     requires the expected digest. Both refuse frozen paths and paths with symlinked ancestors, and an existing
     file is never overwritten (FR-011).
   - **Return** the records that were written, adopted or refreshed, and each registering Task's outcomes.
3. Only then are the attempt baselines captured: the repository change baseline and the per-Task proof and
   attempt declared-artifact baselines. So the skeleton bytes are part of the state the attempt starts from.
4. `createTaskExecutionAuthorityBatch` carries each Task's `skeletonOutcomes` into its plan.
   `applyTaskExecutionAuthorityBatch` writes `skeleton_outcomes` on the Task and merges the `skeletons` records
   into the TaskGraph, inside the same `updateAndReturn` lock that commits the reservation
   (`engine/src/core/validate-task-execution.ts`).

Invariants:

- One call site. Claude Code (`validate-task-execution` PreToolUse) and Pi (`pi/spawn-lifecycle.ts`) both reach
  materialization only through `registerTaskExecutionBatch`. No harness writes skeletons on its own.
- Every expected failure is a value (FR-045). A stage-two problem or a writer refusal blocks the batch with
  `BLOCKED: Cannot materialize the skeletons of <tasks>: <problems>`. It never crashes.
- Before a spawn, status and the brief show outcomes that are not yet recorded. They compute them with the same
  pure derivation (`engine/src/core/skeleton/outcomes.ts` through `engine/src/core/skeleton/status.ts`), so
  every path has exactly one outcome both before and after its spawn (FR-030, FR-040). When stage-two problems
  exist, `implementation-window.ts` replaces `spawn-wave-implementation` with the
  `skeleton-bindings-unresolved` blocker, so the spawn-time refusal is visible before anyone tries to spawn.
- Contract stubs (contract Task stop, `contract-stub-materialization.ts`) and the Contract Revision refresh
  (`skeleton-revision.ts`, run by `revise-contract.ts`) are separate entry points by necessity. They share the
  same writer, the same refresh planner (`core/skeleton/refresh-plan.ts`) and the same outcome derivation.

## Consequences

**Positive:**
- One entry point covers both harnesses, first attempts, retries and infrastructure respawns. A deleted
  skeleton comes back on the next registration with no special retry path (FR-032).
- FR-012's attempt-scope half holds by construction: the baselines include the engine's bytes, so they are
  never attributed to the implementer.
- The Wave Gate completion commit (ADR-0044) stays unchanged. No crash window opens between it and a file
  write.
- No new recovery variant, orchestrator runbook step or skeleton command (OOS-009). Status gains exactly three
  things, all built from the same pure skeleton status report (`core/skeleton/status.ts` over the outcome
  derivation in `outcomes.ts`): one blocker reason, `skeleton-bindings-unresolved`, which replaces
  `spawn-wave-implementation`; one non-blocking reason, `skeletons-unobserved`, shown beside an owed
  `spawn-wave-implementation` when status could not read a skeleton path or types file (registration reads them
  again and refuses on anything it cannot read); and one never-absent report field, `skeletons`, on
  `LoomStatusDocument`. The execute loop in `commands/loom.md` names both reasons.
- Graphs populated before G2 behave exactly as they did before.

**Negative:**
- Spawn registration now does repository I/O, and it can be refused by contract-surface drift that appears
  after population. The Agent spawn is where that refusal is felt, although status flags it in advance.
- The writes happen before the locked State File update, so they are not atomic with the reservation. A
  registration refused after the writes (by a later baseline failure, or by the locked recheck) leaves
  canonical skeleton files with no record. Recovery depends on the next registration adopting them by content.
  An operator who abandons the Task instead is left with engine-written files that no record covers.
- A Wave's skeletons appear one Task at a time, as each Task spawns, not all at Wave start. A sibling Task's
  skeleton does not exist until that sibling is registered.
- Contract stubs and revision refresh still need their own write sites, so "one writer entry point" holds
  only for implementation Tasks. The no-clobber writer, not the call site, carries the safety rule.
