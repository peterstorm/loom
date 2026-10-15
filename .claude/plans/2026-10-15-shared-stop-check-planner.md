# Shared stop-check planner (G4 slice 2, first item)

- **Branch:** `refactor/shared-stop-check-planner`
- **Source:** PR #94 advisory architecture-tech-lead-1, raised in both review rounds and deferred to G4 slice 2 so the piloted hook stayed untouched during the pilot.

## Problem

`stopCheckPlanView` hand-copied the prefix of the live hook's `decideStop`: find the runner, call `stopCheckExpectation`, call `acceptanceRunnerCheck`. The off-reason precedence was kept in sync by convention only. The property test's `liveCheckRuns` oracle re-implemented the same three calls, so it could not catch drift.

## Change

- `planStopCheck(graph, taskId)` in its own module `core/acceptance-contract/stop-check-planner.ts` is the one pure decision of everything the TaskGraph alone decides about a stop: `unknown-task | off(reason) | on(check, command, reportPath)`.
- `stopCheckPlanView` is now a pure projection of the plan into the frozen CT-1 view. The view types and line grammar are unchanged.
- The hook's `decideStop` consumes the plan and adds only per-stop state, in this order: block counter and cap, repository root, runner lock.

## Behavior change (hook)

A refused runner command is now noted before the block counter is read or the root resolved; it used to be noted after both. Only the note text differs, and only when a refused command coincides with an unreadable counter, the cap or an unresolved root. Every such stop already proceeded. This order makes the plan's `command-refused` agree with the check unconditionally.

## Tests

- Replaced the `liveCheckRuns` oracle with an agreement property that runs `runAcceptanceStopCheck` over every generated graph with permissive fake ports:
  - `on` exactly when the check launches the planned argv and cwd;
  - `command-refused` exactly when it notes the refusal;
  - otherwise it skips.
- Mutation check: making the hook skip a refused command fails the property.
- New hook test: the refused command is noted ahead of an unreadable counter and an unresolved root.

## Docs

`docs/operations.md` (Stop-Check Plan section) and `CONTEXT.md` (Stop-Check Plan entry).

## Not in scope

The plan still does not read per-stop state: the counter is per Agent and the lock is momentary, so a read-only helper cannot know them. They stay listed in the docs.
