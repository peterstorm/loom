# ADR-0086: A Task joins the active Wave through a plan edit

## Status
Accepted (2026-11-18). Implements loom#199, Cause 2 (second part). Supersedes the Forward Fix fallback of
[ADR-0077](ADR-0077-a-judgement-lands-while-its-subject-is-open-and-is-fixed-forward-otherwise.md).

## Context
[ADR-0081](ADR-0081-the-active-wave-plan-is-edited-by-audited-operations.md) made the active Wave's plan editable:
`add-dependency` orders its Tasks, and `rescope-task --add-sealed-file` lets a pending Task take sealed code. One
gap was left. The only way to add a Task was still the Forward Fix, which kept three rules of its own:

- **A failed attempt first.** A Forward Fix needed a held Task whose last attempt had already failed. In the
  fugue-dags run, T25 was reopened knowing its first attempt would fail on sealed files, only to make it eligible.
- **At least one sealed path.** A Task the plan simply missed, with only open paths, could not be added at all.
- **A hold kind of its own.** Status, registration and the brief asked a forward-fix hold beside the
  `dependency` hold. A fix Task could not itself be held (#197), and a held Task waited with no escalation
  wording if its fix escalated.

## Options Considered

1. **Add a Task as a plan edit, ordered by dependencies (chosen).** `add-task` appends a pending Task to the
   active Wave. `--depends-on` gives it edges; `--before` gives pending Tasks of the Wave an edge to it. Sealed
   paths are named with `--sealed-file`, as `rescope-task` names them. The edit is a `task-added` `WavePlanEdit`;
   `withdraw-task` removes a never-dispatched one as a `task-withdrawn` edit.
   - Pros: one ordering mechanism, which already escalates correctly and refuses cycles. No attempt is spent to
     unlock a tool. A Task the plan missed is added the same way as a fix for sealed code.
   - Cons: the failed judgement no longer gates the operation; the explicit sealed flag, the reason and the
     active Wave's gate review stand in for it, as they do for `rescope-task` (ADR-0081).
2. **Keep Forward Fix and merge #197.** Let a fix Task be held, keep the precondition.
   - Cons: keeps two ordering mechanisms and the deliberately failed attempt the run exposed.

## Decision
- `helper orchestration add-task` (`core/task-addition.ts`) appends one Task to the active Wave. It shares the
  Wave-reopening precondition with Task Reopening and refuses a completed Wave and an abandoned run that names a
  successor. Every path follows `rescope-task`'s admission rule (`pathAdmissionRefusal`): one owner per path
  within the Wave, no protected verification path, no Acceptance Contract path frozen for another Task, and a
  sealed path only when named with `--sealed-file`. The Task must list a test file when its policy owes one, and
  every member of a coupled file set it touches (ADR-0082). Each `--before` Task must be pending, authored and
  unattested; an edge that would close a cycle is refused, naming the cycle.
- The Task is written by population's own builder (`pendingAuthoredTask`), with regression always required. The
  edit records its files, sealed files, dependencies, dependents, reason and the abandoned run whose review
  authority it retired. The State File admits a same-Wave edge only when an edit records it, so both of the
  Task's edge kinds are audited. A replay of an identical request whose Task is untouched changes nothing.
- `helper orchestration withdraw-task` removes a Task an earlier `task-added` edit appended, while it is still
  untouched, and drops every edge to it. The parser accepts earlier edits that name the withdrawn Task, refuses
  a withdrawal of a Task never added or still on the roster, and a Task added or withdrawn twice. A withdrawn id,
  like a withdrawn Forward Fix id, is never minted again.
- add-forward-fix and withdraw-forward-fix are removed, and so is the forward-fix Dispatch Hold. A State
  File written before this change still loads, its `forward_fix_history` and `forward_fix_withdrawals` proven as
  before. The dependency hold reads each live audit as its held Tasks depending on its fix Task, so a paused run
  resumes on the new engine without a migration.

## Consequences
- An operator adds a Task by naming what it changes and what it orders, not by failing a Task first.
- The Dispatch Hold has two kinds: the distill pass and dependencies. A Task waiting on an escalated Task is
  reported as blocked by it, whether the edge came from decompose, `add-dependency`, `add-task` or a legacy
  Forward Fix.
- Retro facts count added and withdrawn Tasks as plan edits, mark an added Task as `addedMidRun`, and still
  report legacy Forward Fixes.
- Draft #197 (holding a fix Task) is obsolete.
