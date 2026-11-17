# ADR-0081: The active Wave's plan is edited by audited operations

## Status
Accepted (2026-11-17). Implements loom#199, Cause 2 (first part).

## Context
Once a TaskGraph is populated, the operator could change the active Wave's plan in only two ways.
`rescope-task` edits a pending Task's file list, and refuses every path a completed Wave sealed. A Forward Fix
(ADR-0077) appends a Task that holds named judges. Both have gaps that a live run hit:

- **No ordering inside a Wave.** A `depends_on` edge is satisfied only when its Task is `completed`, which
  happens at the Wave Gate. An edge between two Tasks of one Wave could therefore never be satisfied. Ordering
  between T25, T28 and T29 lived in free-text operator notes, which drifted.
- **No sealed path except through a Forward Fix.** A Task that legitimately had to change a sealed file
  could only get it through a Forward Fix. A Forward Fix needs a held Task whose attempt already failed, so
  attempts were burned on purpose to create that evidence.
- **Holds have no escalation path.** When a fix Task escalated, the Tasks it held waited for it forever.

## Options Considered

1. **Audited plan edits with ordinary dependencies (chosen).** Same-Wave dependencies become satisfiable.
   `add-dependency` adds edges, refusing any that would close a cycle. `rescope-task` takes sealed paths when
   they are named explicitly. Every edit is a `WavePlanEdit` in `wave_plan_edits`.
   - Pros: ordering is data the engine enforces, not prose. No attempt is spent to unlock a tool. The operations
     share one precondition (`reopenableWave`) and one audit history.
   - Cons: a sealed path can now change without a failed judgement first. The explicit flag, the reason and
     the active Wave's gate review stand in for that evidence.
2. **Widen Forward Fix.** Let it hold any Task and drop the failed-judge precondition.
   - Cons: holds stay a special case beside dependencies, with their own rule in status, registration and the
     brief. Two ordering mechanisms with different escalation behaviour.

## Decision
- A `depends_on` entry naming a Task of the same Wave is satisfied when that Task has settled its
  implementation (`implemented` or `completed`, with no live reservation or attempt). An entry naming an
  earlier Wave still requires `completed`. The one rule is a `dependency` Dispatch Hold, which status,
  registration and the brief all consult (`dispatch-holds.ts`). A hold whose blocker escalated says the Task is
  blocked by an escalated dependency, rather than waiting.
- `helper orchestration add-dependency --task <id> --on <id>... --reason <text>` adds edges to a pending Task of
  the active Wave. An edge may only point at the active Wave or an earlier one, and an edge that would close a
  cycle is refused, naming the cycle. Graph validation applies the same rules to a populated graph: no cycle,
  no dependency on a later Wave, and no unknown dependency.
- `rescope-task --add-sealed-file <path>` admits a path a completed Wave's Task lists; plain `--add-file` still
  refuses one. The `task-rescoped` audit records the sealed additions.

Retiring Forward Fix holds in favour of these operations is a later change (loom#199, Cause 2, second part).

## Consequences
- An operator orders a Wave's Tasks with edges the engine enforces and audits.
- A Task can take the sealed file it must change without a deliberately failed attempt.
- An older State File without `sealed` on its re-scope audits loads unchanged.
