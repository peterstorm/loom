# #213 Cause 2: Owner Verification runs at the stop of a Task that writes the family

Historical record of the plan behind the #213 Cause 2 change ([ADR-0092](../../docs/adr/ADR-0092-owner-verification-runs-at-the-stop-of-a-task-that-writes-the-family.md)). The implementation order below is done; the ADR and the code are the current description.

- Issue peterstorm/loom#213, Cause 2. Branch `fix/owner-verification-at-stop` from origin/main 85307b12.
- ADR-0090 is #213 Cause 4, and PR #225 takes the next number, so this change is ADR-0092.

## Problem

INV-4's owner verification (sibling import coverage and mutation of the owner) ran only in the Wave Gate's completion suite. One gate run at a time it found a matrix test that did not import the real clients, a surviving mutant, then another survivor after the fix moved code. Each finding cost an abandon, a reopen, a dispatch, a distill re-run and a new gate. The Task mutation check (ADR-0071) passed every time: it samples 8 mutants of the Task's own files against the Task's own tests, never the owner against the matrix test.

## Design

ADR-0071's shape: a helper the implementer runs, and a stop arm that reads the record it left.

**Duty** (`core/task-owner-check.ts`, `taskOwnerCheckDuty`), read by the helper, the stop arm and the brief:
- a stamped graph; an implementation Task (not Contract, ADR or Distill);
- per obligation `taskOwnerDuty(graph, file_list).touched` selects (owner, sibling or matrix test): owed when the Task's Wave owes it at the gate (`owesInWave`) and its owner and matrix test are both settled at the stop;
- each owed obligation carries what its matrix test must reach (`duePathsAtStop`) and whether the Task lists the matrix test (`answers`).

**Settled at the stop** (`isSettledAtStop`, next to `duePaths` in `core/owner-verification/obligations.ts`; both read one listing rule, `isDueWhen`): unlisted, listed by an earlier Wave, or listed by the stopping Task.

**Run** (`orchestration/task-owner-check-runner.ts`): `verifyObligations` in `orchestration/owner-verification-runner.ts` is now exported. It takes a non-empty list of `ScopedRun`s (each run with its due paths) and an `ObligationRunScope` (`execute`), and returns non-empty verdicts. The gate pairs its runs with `duePaths` and uses `runOnce`; the Task check pairs each owed obligation's run (`obligationRunOf`, now exported from `owed-verification.ts`) with the duty's own `due` and uses `runOnce` behind its 480 s deadline.

**Record** (`orchestration/task-owner-check-record.ts`, on the shared `orchestration/task-record-file.ts` that the Task mutation record now also uses): the gate's verdicts per obligation or `unavailable`, bound to a digest of `start_sha`, the owed obligations and the bytes of every family input and declared file. `recordedTaskOwnerCheck` takes the duty and refuses verdicts for Invariants it does not owe; the stop reads every record through `judgeTaskOwnerCheck`, the same pairing. Both Task records share the pure core `core/task-record.ts` (digest and brand, envelope, standing, observation, stop verdict).

**Stop arm**: `owner` in `STOP_CHECK_NAMES`, cap 2, heading `## Task owner check`; the block decision's slots in `core/affected-stop-check.ts` are a record keyed by `STOP_CHECK_NAMES` with one constructor. `sortTaskOwnerFindings` decides which findings block.

**Brief**: a `Task owner check` paragraph in the Verification Policy section.

## Refinements to the direction, with the evidence

1. **The owner and the matrix test must be settled, not only due.** At a stop, an owner or matrix test listed only by a concurrent Task of the same Wave may be absent or half-written; judging it would report the other Task's work. The gate stays the backstop for that case.
2. **Findings block only a Task that lists the matrix test.** The gate's remedy for a missing path and for a survivor is to strengthen the matrix test, and a Task cannot write a file it does not declare (settlement's byte scope). Other Tasks still owe the run (a missing or stale record blocks), and their findings are notes that reach the orchestrator.
3. **The deadline is the gate's own `spawn-failed` outcome**, not a new failure kind: a refused run is never launched, its obligation's mutation half is infrastructure, and coverage is still judged. The gate's types and verdicts are unchanged.

## Implementation order (done)

1. `isDueWhen`, `isSettledAtStop`, `duePathsAtStop` in `obligations.ts`.
2. `verificationRuns` over obligations; `invariantVerdictFailures` and `parseInvariantVerdicts` exported.
3. `verifyObligations` and `ObligationRunScope` in the gate runner; gate tests unchanged and green.
4. `core/task-owner-check.ts`; `task-record-file.ts`; the record, the runner, the helper and its route; `LoomCommands.ownerCheck`.
5. The fourth stop arm, wired in the Claude Code dispatcher and the Pi stop.
6. The brief paragraph.
7. Tests; docs (`verification.md`, `architecture.md`, `operations.md`, `reference/helpers.md`, `roadmap.md`, the implementation-proof context); ADR-0092.

## Review remediation (PR #229, `pr229-review-1`)

Eighteen accepted advisories, applied in the working tree:

1. Tests: a concurrent same-Wave sibling (covered at the stop, missing at the gate); the helper's fail-open arms (a family file rewritten during the run, an unwritable record directory, a failed pre-run digest, no repository root); a Task whose duty owes nothing at the stop arm.
2. `OwedTaskOwnerCheck` is a union: mutation owed with a required runner, or exempt-only with none; a duty owing mutation with no runner is off (`no-affected-runner`).
3. `recordedTaskOwnerCheck` takes the duty and refuses an empty Task id or a foreign verdict; `sortTaskOwnerFindings` takes judged obligations and no longer compensates at read time.
4. `SomeChecks` is a record keyed by `STOP_CHECK_NAMES` with per-name payloads and one constructor.
5. `core/task-record.ts` holds what both Task records share; the Task mutation check's outputs are unchanged.
6. The runner judges coverage over the duty's own due paths.
7. `digested` and the verdict list are non-empty by construction; the unreachable branches are gone.
8. Small cleanups; docs (`helpers.md`, `roadmap.md`, a test comment).

`verificationRuns` keeps the gate's `OwedVerification` parameter, as before this change: the Task check no longer calls it.
