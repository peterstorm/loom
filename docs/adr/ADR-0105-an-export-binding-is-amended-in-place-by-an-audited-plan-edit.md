# ADR-0105: An Export Binding is amended in place by an audited plan edit

## Status
Accepted (2026-11-28). Amends ADR-0051: a binding change no longer always requires re-population.

## Context
Population stamps the plan's `**Export bindings:**` into the TaskGraph (`export_bindings`, ADR-0051).
Completion then refuses a Task whose bound export is deleted, renamed, retyped or still holds the
skeleton's `unimplemented: <name>` marker (`declared-artifact-contract-violated`).

A live run bound StatusComposer.java to CT-6 as `status: LoopStatusQuery`, a `static final` constant. The
design makes status per-replica: each Spring context builds its own LoopStatusQuery. No constant can
implement it, so the Task's completion failed on `{"subject":"status","reason":"still-unimplemented"}`
every time. The binding, not the code, was wrong. The only remedy was to fix the plan and run
`populate-task-graph --force`, which resets every Task of the run. Mid-run, that discards the evidence of
every settled Task to correct one line.

ADR-0081 and ADR-0086 already repair a live plan through audited edits in `wave_plan_edits`: re-scope a
Task, add a dependency, add or withdraw a Task. A binding had no such edit.

## Options Considered

1. **An audited `export-binding-amended` plan edit (chosen).**
   - Pros: one Task is repaired, nothing else is reset. The edit shares the plan edits' precondition, lock,
     audit history and re-population rule.
   - Cons: the stamp can now differ from the plan text. Every reader that compares the two must replay the
     edits.
2. **Edit the plan, then re-stamp only the bindings from it.**
   - Pros: the plan stays the only source.
   - Cons: the plan is digest-bound elsewhere (owner obligations re-read it). A partial re-population
     duplicates population's validation and still needs an audit of what changed and why.
3. **Waive the violation for one Task.**
   - Cons: a new waiver, which FR-020 rules out. The wrong binding would stay in the stamp, so status, the
     brief and a later Contract Revision would keep acting on it.

## Decision
**`helper orchestration amend-export-binding --task <id> --file <path> --export <name> (--drop | --rebind
<newName>) --reason <text>` changes one export of one stamped binding, audited as a `WavePlanEdit`.**

- **Pure decision.** The decision is `amendExportBinding` in `engine/src/core/export-binding-amendment.ts`.
  The audit is built by `exportBindingAmendedEdit` in `engine/src/core/wave-plan-edit.ts`, the one
  constructor the State File parser also uses. The change is an ADT: `dropped` or `rebound`. A rebound
  export keeps its frozen alias, so the types-file surface it resolves against is unchanged. The new name is
  minted by `parseIdentifier` and must pass the binding grammar's collision rules.
- **Refusals.** It shares the other plan edits' precondition (`reopenableWave`): the execute Phase, no live
  Wave Gate, no implementation reservation in the active Wave. It also refuses:
  - an unknown Task;
  - a path the Task does not list, a path the stamp does not bind, or an export the binding does not hold;
  - a Task that is not `pending`, or that sits in a completed Wave;
  - a Task with its own reservation or attempt;
  - a Distill Task;
  - a binding whose path another settled (`implemented` or `completed`) Task that holds skeletons also lists.
    A settled Distill Task listing the path does not block: it holds no skeletons and implemented nothing
    against the binding;
  - a contract still `awaiting-red`, whose contract Task's stop still writes stubs from the stamp.

  A refusal writes nothing.
- **What changes.** One locked update does three things:
  1. It replaces the binding's exports. A drop of the last export removes the binding.
  2. When the binding is removed, it also removes the binding's skeleton record and every Task's recorded
     skeleton outcome at that path, so the wire's stamp/record invariants hold. The file the engine wrote
     stays on disk and is the Task's own code to replace. Status then reports it as
     `exists, not skeletonized (projected)` until the next registration records it.
  3. It appends the audit: Task, Wave, path, contract, change, the exports before and after, and the reason.
  The operation is parent-only (ADR-0067 D6), so the operator is its actor by construction.
- **Idempotent.** A repeat of a change an earlier audit of the same Task already made returns `unchanged`
  and writes nothing.
- **Readers follow the stamp.**
  - Conformance (`conformanceScope`) and the skeleton report read the stamp, so a dropped export owes no
    conformance.
  - The brief's plan agreement check replays the audited amendments onto the plan's bindings
    (`replayExportBindingAmendments`) before it compares them with the stamp. A plan the operator also
    corrected agrees too.
  - The attempt-2 retry appendix withdraws a predecessor's violation of a bound export that the stamp no
    longer binds. It lists that violation as withdrawn, not as a duty. The brief, status and the spawn gate
    render it from the same stamp, so the bytes they compare stay equal.
- **Re-population** drops the audit with the other plan edits and re-stamps from the plan.

## Consequences

**Positive:**
- A wrong binding is corrected for one pending Task without resetting the run.
- Every amendment is auditable in `wave_plan_edits`, beside the other live plan edits.

**Negative:**
- The stamp may now differ from the plan text by audited amendments. A later re-population restores the
  plan's binding unless the operator also corrects the plan.
- Acceptance tests that import a dropped export still need it. The amendment changes what the conformance
  check judges, not what the tests compile against.
