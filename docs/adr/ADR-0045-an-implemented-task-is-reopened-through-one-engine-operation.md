# ADR-0045: An implemented Task is reopened through one engine operation that reuses the Contract Revision transition

## Status
Accepted (2026-10-25). Fixes a defect between the engine and its docs; branch
`fix/wave-advisory-remediation`. Lands with ADR-0044.

## Context
A Wave Gate records exactly one decision: `{"kind":"approve"}`. To act on an advisory, or on a surviving
critical, the docs (`commands/wave-gate.md`, `commands/loom.md`, `docs/operations.md`) told the operator
to abandon the run, re-dispatch the affected Task, and start a fresh Wave Gate.

No engine operation made that possible. An `implemented` Task in the active Wave could not become
dispatchable again:

- `classifyImplementationWindow` (`engine/src/core/implementation-window.ts`) never counts an implemented
  Task as outstanding, so canonical status owed it no dispatch.
- `helper orchestration brief` serves only the dispatches status owes.
- The brief renderer (`engine/src/orchestration/implementation-brief.ts`) refuses an implemented Task
  outright, and the spawn gate expands only rendered briefs.

The one workaround was `populate-task-graph --force`, which resets every Task in the graph and throws away
all settled evidence: proofs, test evidence, Review Generations and Findings.

Pieces of the right transition already existed. A **Contract Revision** (`engine/src/core/contract-revision.ts`)
is the one path that reopens implemented Tasks in the active Wave. It checks its preconditions (execute
Phase, no executing Task, no live gate), then calls `returnToRevalidation` for each Task, calls
`retireWaveReviewAuthority`, resets the gate bits and re-derives the Wave block. `reopen-completed-wave`
shows the audit-and-idempotent-replay pattern.

## Options Considered

1. **Let `brief` render an implemented Task on request**
   - Pros: No new State File field.
   - Cons: Status would still owe nothing, so `brief` and status would disagree. The spawn gate
     authorizes only what status owes. Nothing would retire the abandoned run's review epoch, spec-check or
     suite receipt, and the next gate would still start with the old implementation proof standing.

2. **A parallel "re-dispatch" transition beside Contract Revision**
   - Pros: Independent of Contract Revision's code.
   - Cons: Two copies of "return these Tasks to revalidation and retire the Wave's authority". When the two
     disagree, one of the reopen paths leaves stale authority behind. This is the second-copy problem the
     deepen rules warn against.

3. **One engine operation over a shared pure precondition and transition (chosen)**
   - Pros: `reopenableWave(graph)` and `returnWaveTasksToRevalidation(reopenable, taskIds)` are extracted
     from Contract Revision, so both reopen paths check the same Wave precondition and make the same move. The existing pipeline then does the rest: a reopened Task is `pending`
     with `revalidation_required`, so `deriveTaskImplementationDispatch` yields `initial-implementation`,
     status owes the dispatch, `brief` renders it, and `checkImplementationProof` blocks the next gate start
     until the Task settles afresh.
   - Cons: A new audit field in the State File, with its parser and population drop.

## Decision
**`helper orchestration reopen-task --wave <N> --task <id> [--task <id>]... --reason "<text>"` is the one
operation that reopens implemented active-Wave Tasks. Its pure core is
`engine/src/core/task-reopening.ts` (`parseTaskReopeningArgs`, `reopenImplementedTasks`) and its thin shell
is `engine/src/handlers/helpers/reopen-task.ts`.**

**The Wave precondition is one pure function shared with Contract Revision.**
`reopenableWave(graph)` (`engine/src/core/task-revalidation.ts`) returns either a typed
`WaveReopeningRefusal` or a `ReopenableWave` proof, checking in this order:

- `not-executing`: the graph is not in the execute Phase, or has no current Wave.
- `live-wave-gate`: `active_wave_gate` is present and is not a `terminal-abandoned` tombstone of the current
  Wave.
- `implementation-active`: a Task is executing, or a current-Wave Task holds an active implementation
  attempt. A parsed graph names every attempting Task in `executing_tasks` too, so the attempt clause is
  defense in depth.

The proof carries the graph, the current Wave and the tombstone's run id (or null). It is the only way into
`returnWaveTasksToRevalidation`, which retires authority through the non-throwing
`retireUnownedWaveReviewAuthority`. The transition therefore cannot be reached over a live gate and throws
nothing in the core. `retireWaveReviewAuthority`, which keeps its throw for the Requirement-trace callers
that do not hold the proof, now delegates to the same non-throwing function. Each operation renders the
refusal facts in its own words, so every existing refusal message is unchanged.

Task Reopening refuses, under the TaskGraph lock, with a typed `TaskReopeningRefusal` in this order:

- An idempotent replay (below) is answered first, before any refusal. A reopened Task that has been
  re-dispatched holds a reservation the precondition would refuse.
- `not-executing`, `live-wave-gate`, `implementation-active`: the shared precondition.
- `wrong-wave`: `--wave` is not `current_wave`.
- `wave-completed`: completed history exists for the Wave (`reopen-completed-wave` is the path there).
- `successor-named`: the tombstone names a `supersededBy` successor. Reopening would retire the tombstone
  and orphan the successor's authority.
- `unknown-task` or `foreign-task`: a target is not in the graph, or not in the Wave.
- `not-implemented`: a target is not `implemented`.
- `lineage-not-dispatchable`: a target's implementation lineage cannot derive a dispatch. An escalated
  lineage is remediated first.

The argument grammar refuses a blank reason, or one longer than 512 characters. The shell refuses while a
subagent is active, both before the lock and again inside it (`subagent-quiescence.ts`, operation
`"task reopening"`).

On success the core applies `returnWaveTasksToRevalidation`. It retires the Wave's review authority first,
so review evidence the abandoned run accepted is kept as Findings. Each named Task then returns to
`pending` revalidation at a new Review Generation, keeping its Findings as prior Findings. The gate bits
reset and the block is re-derived. The Wave's other Tasks stay `implemented`. The core also appends one
`TaskReopeningAudit` to `task_reopening_history`: `{schemaVersion: 1, kind: "implemented-tasks-reopened",
wave, reopenedTaskIds (graph order), reason, abandonedRunId | null}`. `reopenedTaskIds` is a
`NonEmpty<TaskId>` in the type as well as at the parser. `abandonedRunId` is null when no abandoned run was
still on the graph: none had registered, or an earlier reopening already retired it.

The audit is a sibling field, not a new kind inside `wave_reopening_history`. Those audits describe
completed Waves and carry a completion receipt and authority digest, and an active-Wave reopening has
neither. The State File parser requires exact fields, distinct Task ids that all belong to the audited
Wave, a trimmed reason of at most 512 characters, and no abandoned run named by two audits. Re-population
drops the field like every other history.

Replay is idempotent. When the last audit has the request's Wave, Task set and reason, and every one of
those Tasks is still `pending` with `revalidation_required`, the operation returns `already-reopened` and
writes nothing. After the Tasks settle, the same command reopens them again under a fresh audit.

Contract Revision now calls the same precondition and transition, keeping only its contract checks
(unknown contract first, then the shared precondition, then not-frozen, contract Wave open, claimant in a
completed Wave, unreadable or stale observation, unchanged bytes). Behavior that moves with the extraction:

- The review authority is retired before the claimants reset, where it used to happen after. So review-run
  evidence the abandoned run had accepted for a revalidated claimant is now kept as Findings instead of
  being dropped.
- The shared precondition checks a live gate before reservations, where Contract Revision used to check
  reservations first; a graph with both now reports `live-wave-gate`.
- Contract Revision now also refuses an abandoned tombstone of a Wave other than the current one, as Task
  Reopening always did: retiring it as the current Wave's authority would supersede the wrong Wave's review
  state. The parser admits such a stale tombstone (only a nonterminal gate must match `current_wave`), so
  this is a real, deliberate tightening.
- Contract Revision now also refuses a current-Wave Task holding an active attempt. A parsed graph names
  that Task in `executing_tasks`, which was already refused, so no parsed graph changes outcome.

Every existing Contract Revision test passes unchanged.

## Consequences

**Positive:**
- The docs' advisory and critical remediation path is real. Abandon the run, reopen the Task, run `brief`,
  and start a fresh gate. No other Task's evidence is touched.
- One pure transition serves both operator reopenings, so they cannot drift apart.
- With ADR-0044, a contract Wave's contract Task can be reopened at the advisory pause and its files fixed,
  and the fresh gate sees no frozen-path drift.
- `populate-task-graph --force` is no longer the only way out.

**Negative:**
- One more protected history field (`task_reopening_history`) to parse, test and drop at population.
- An abandoned run that named a successor must have that successor started (or abandoned again, naming
  none) before its Tasks can be reopened. This is deliberate, but it is one more step.
- The brief renderer's refusal for an implemented Task now names the operation. Its pinned message changed
  in `engine/tests/pi-extension-review-events.test.ts`.
