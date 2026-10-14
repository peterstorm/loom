# Pre-freeze advisories (G1 pilot finding 7)

**Date:** 2026-10-14
**Branch:** `feat/pre-freeze-advisories`

## Problem

In the G1 live pilot, the Wave 1 reviewers raised advisories on the contract's own files: missing negative assertions, and a duplicated revisions count. The operator approved them, and the gate's completion stamped the Acceptance Freeze over those bytes. Fixing them afterwards needs a Contract Revision. Nothing at the pause said that approval would freeze them.

## Decision

No new review stage. The contract Wave's gate already reviews the contract files, and the freeze lands at completion, after the advisory decision. So the pause is the moment to fix them, by abandoning the run, re-dispatching the contract Task and restarting. The engine now says so at that moment.

- **`core/acceptance-contract/freeze-notice.ts`** (pure, enrolled in `DEFAULT_PURE_MODULES`):
  - `pendingFreezeAdvisories(contracts, tasks, wave)` lists every advisory Finding of a current-Wave Task whose file is a frozen path of a contract that is still `awaiting-red` and whose contract Task runs in this Wave.
  - `renderPendingFreezeAdvisories` gives the operator text: what approval does, and how to fix first.
- **`core/loom-status.ts`**: at the advisory pause, `deriveNextAction` appends a typed `acceptance-freeze-pending` StatusReason when the set is non-empty.
- **Request identity is untouched.** The `await-user` action, its advisory artifacts and its context bytes stay byte-identical, so no in-flight run's request ID or recorded approval changes. The notice is a status projection only.

## Docs

- `commands/wave-gate.md`: at a contract Wave's pause, read status before deciding.
- `commands/loom.md`: the advisory triage step.
- `docs/operations.md`: the advisory-disposition section.
- `CONTEXT.md`: the Acceptance Freeze entry.
- `references/executable-models.md`: lifecycle step 2.

## Tests

`tests/core/acceptance-freeze-notice.test.ts`:

- the ordering of the listed advisories;
- the exclusions: a contract that has already frozen, a Task outside the contract Wave, a Finding with no file, and critical Findings;
- a property: every and only advisory whose file is frozen is named;
- the rendered text;
- the real `deriveLoomStatusFromParsedGraph` entry point at the advisory pause, with and without the notice.

## Verification

`npm run verify`, run from the repository root.
