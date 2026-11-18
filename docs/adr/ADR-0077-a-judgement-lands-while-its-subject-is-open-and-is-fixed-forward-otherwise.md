# ADR-0077: A judgement lands while its subject is open, and is fixed forward otherwise

## Status
Accepted (2026-11-16). The Forward Fix fallback is superseded by
[ADR-0086](ADR-0086-a-task-joins-the-active-wave-through-a-plan-edit.md): `add-task` appends the fix with ordinary
dependencies. Judged Paths (prevention) stand.

## Context
A Task **judges** code when its tests decide whether code another Task writes is acceptable: a memory or
latency budget, a benchmark gate, an end-to-end acceptance run. A judgement can only be acted on while the
judged code's Wave is still open. `reopen-task` reaches the active Wave alone
([ADR-0045](ADR-0045-an-implemented-task-is-reopened-through-one-engine-operation.md)), and
`reopen-completed-wave` exists for one narrow case, drifted reviewed bytes, on the Wave just before the active
one and only before later-Wave progress.

A host-memory run met the gap. Its Wave 5 Task T12 built the memory harness and its CI budget test, and claimed
the per-request budget Requirement. The code the budget constrains was written by T10 (Wave 4) and T9 (Wave 3),
both completed. The test measured real breaches: 33.8 MB against 10 MB per request, 75.3 MB against 50 MB for
five concurrent requests, and 158.3 MB against 150 MB for the recompute. T12 could not change the code its test
judged, both completed Waves refused reopening, and the only engine moves left were to spend T12's final
attempt re-failing on the same breaches or to abandon the run.

Nothing in the decompose contract said T12 judged T9's and T10's files, so validation could not see the shape.
The Requirement that constrained the serving code was claimed by the Task that measured it, not by the Task that
wrote it.

## Options Considered

1. **Prevent at decompose and fix forward at execute (chosen).** Decompose declares each Task's `judged_paths`.
   Validation refuses a judge scheduled after the Wave of a Task that writes its subject. When a judgement that
   nobody declared still fails on sealed code, the operator appends a Forward Fix Task to the active Wave.
   - Pros: completed Waves stay immutable as verified history. The fix is reviewed by the active Wave's gate
     like any other Task. Prevention costs one field on the authored roster and one pure check. The fallback is
     narrow: it needs a failed judgement as evidence and at least one sealed path.
   - Cons: a Forward Fix changes code in a file a completed Task's review covered, so that review is no longer
     the last word on the file; the active Wave's review and its Wave Gate are.

2. **Generalize `reopen-completed-wave` to reopen any earlier Wave on a Finding.**
   - Pros: the fix lands on the Task that owns the code.
   - Cons: it rewinds `current_wave` and must retire every later Wave's progress, evidence and gates. A
     benchmark Task at the end of a long run would re-gate most of the run to fix two files. The proof mode
     that keeps that helper safe (exact drift against a frozen packet) has no analogue for "a later judgement
     failed".

3. **Prevention only.** Rely on the decompose rule.
   - Cons: the rule sees only what decompose declares. An undeclared judgement leaves the run exactly where the
     host-memory run was, with abandonment as the only exit.

4. **Widen the judging Task's file list at execute.**
   - Cons: the judge's attempt authority, artifact baselines and Proof Obligations are frozen at its
     registration. Moving its scope mid-lineage breaks the attempt proofs, and the judge's final attempt would
     still be spent on code it did not write.

## Decision

**Judged Paths (prevention).** Decompose emits `judged_paths` on every Task (rule 13 makes it required, `[]`
when the Task judges nothing): the paths its tests judge and another Task writes. Validation reads an absent
field as `[]`, so a payload authored before the field existed still validates. `validate-task-graph
--decompose-payload`, run again by `populate-task-graph`, refuses through `judgedPathProblems`
(`engine/src/core/judged-paths.ts`):

- `earlier-writer`: a Task in an earlier Wave than the judge writes a judged path;
- `unwritten`: no Task writes a judged path, so a failed judgement has no fixer;
- `self-written`: the judge writes the path itself, which is ownership, not a judgement.

The preferred shape is an Acceptance Contract: the budget tests are written first and the Task that writes the
judged code claims the Requirement and turns them green. A judge in its writer's own Wave is admitted. Wave
scheduling forbids a dependency between Tasks of one Wave, so the two run side by side, and the judge may meet
code that is still being written. Its failure is still repairable while that Wave is open: the writer's own
retry or `reopen-task` fixes the code, and the judge's retry judges it again. Plan alignment flags the same shape one phase earlier
as a `JUDGE-N` gap. The field is not persisted: it shapes the roster and nothing at execute reads it.

**Forward Fix (fallback).** helper orchestration add-forward-fix appends one Task to the active Wave
(addForwardFix, engine/src/core/forward-fix.ts). It shares the Wave-reopening precondition with Task
Reopening and Contract Revision, and adds its own refusals:

- every `--hold` Task is an authored Task of the active Wave whose last implementation attempt failed (owed the
  engine-authorized retry, or escalated): the failed judgement is the evidence;
- at least one `--file` path is written by a Task of a completed Wave (a sealed path); a path no completed Wave
  wrote is changed through the Task that owns it;
- no `--file` path is owned by another Task of the active Wave, is a frozen Acceptance Contract path, or is
  protected verification infrastructure.

The fix Task is written by population's own builder (`pendingAuthoredTask`), with no dependency and no
Requirement trace, and with regression always required. A `forward-fix-added` audit is appended to
`forward_fix_history`, and the State File parser proves it on every load. The audit is the authority of one
**Dispatch Hold** (`engine/src/core/dispatch-holds.ts`): each held Task is owed no dispatch until its fix Task is
implemented and unreserved. A held judge's escalation is deferred until then too, so status dispatches the fix
before it puts the escalation to the operator. Status, registration and the brief ask this one hold rule, which
also carries the Distill Task's existing hold (ADR-0068). Completed Waves and their Tasks are not touched. The
Wave's Distill Scope stays as population froze it: the fix's files are judged by the Wave Gate's review, not
distilled.

**Fix text the brief can carry, and withdrawal.** The fix Task's description and reason become its plan context,
which its brief renders and the spawn gate reads. add-forward-fix therefore refuses, before anything reaches
protected state, text that the gate would refuse: a `{template variable}`, a `LOOM_` token, a `Task ID:` binding
or a line break. These are the operator-note rules. A Forward Fix whose fix Task was never dispatched can be
withdrawn with helper orchestration withdraw-forward-fix. Under the same Wave-reopening precondition, it removes
the untouched fix Task, moves its audit whole into `forward_fix_withdrawals` with the operator's reason, and releases
the hold. A withdrawn fix Task's id is never minted again, and the State File refuses a withdrawn id that is still on
the roster or still in a live audit. A dispatched fix Task is not withdrawn: it settles, or it is reopened.

## Consequences
- A decompose payload can no longer schedule a declared judgement after the Wave it judges.
- The host-memory shape has a recovery that keeps every settled Wave: add a Forward Fix for the breaching files,
  let it settle, and the held judge's next attempt judges the fixed code.
- A completed Task's file can now change within the run. The State File records why (`forward_fix_history`), and
  the active Wave's review covers the change.
- Re-population drops `forward_fix_history` along with the roster it describes, as it does every other audit.
- An undeclared judgement still reaches execute. The Forward Fix fallback and the `JUDGE-N` plan-alignment check
  narrow that gap; neither closes it.
