# ADR-0092: Owner Verification runs at the stop of a Task that writes the family

## Status
Accepted (2026-11-18). Issue #213, Cause 2.

## Context
Owner Verification (ADR-0032, ADR-0035, ADR-0036) ran only in the Wave Gate's completion suite. In the
Wave behind #213 it found, one gate run at a time, a matrix test that did not import the real clients, a
surviving mutant, then another survivor after the fix moved code. Each finding cost an abandon, a reopen,
a dispatch, a distill re-run and a new gate. The Task mutation check (ADR-0071) passed every time: it
samples 8 mutants of the Task's own files against the Task's own tests, not the owner against the matrix
test. The implementer that could have answered each finding had already stopped.

## Options Considered

1. **Fold the owner into `helper mutation-check`.**
   - Cons: an owner's plan holds up to 24 mutants plus a baseline per Invariant, at up to 60 s a run. It
     does not fit the Task check's 480 s deadline beside the Task's own 8 mutants, and a shared deadline
     would starve one check to run the other.
2. **Run Owner Verification in the SubagentStop hook.**
   - Cons: the hook has 300 s shared with the runner checks and settlement (ADR-0071 option 1).
3. **A second helper the implementer runs, and a fourth stop arm that reads what it left (chosen).**
   - Pros: ADR-0071's shape, already proven: the long work runs in the implementer's own tool call, and
     the stop reads one small file. The gate's per-obligation run is shared, not copied.
   - Cons: advisory, like ADR-0071: the record is a runtime file and the arm fails open.

## Decision

### 1. The helper
`helper owner-check --task <id>` (600000 ms tool-call timeout) is a shell around a pure core
(`core/task-owner-check.ts`).

- **Duty.** `taskOwnerCheckDuty` decides whether the Task owes the check and over which obligations. The
  helper, the stop arm and the implementation brief all ask it. A Task owes nothing on a graph with no
  owner stamp, when it is a Distill, ADR or Contract Task, or when no obligation is owed at its stop. An
  obligation is owed at the stop when the Task touches its family (`taskOwnerDuty`: owner, sibling or
  matrix test), the Task's Wave owes it at the gate (`owesInWave`), and both the owner and the matrix test
  are settled at the stop. A duty that owes mutation carries the frozen runner; one whose every obligation is
  mutation-exempt carries none; an obligation owing mutation with no runner frozen leaves the Task owing nothing
  (`no-affected-runner`), so a runner-less mutating duty cannot be built.
- **Settled at the stop** (`isSettledAtStop`, beside `duePaths` in `core/owner-verification/obligations.ts`,
  one listing rule for both): no Task lists the path, a Task of an earlier Wave does, or the stopping Task
  does. A path only another Task of the same Wave lists is that Task's work in flight.
- **Coverage** reaches the owner and each sibling settled at the stop (`duePathsAtStop`), a subset of what
  the gate asks (`duePaths`). The duty computes these paths once, and the run reads them from the duty.
- **Mutation** is the gate's own plan: `waveBaseOf`, `mutationPlan` under `MUTANT_CAP_PER_INVARIANT`, one
  isolated worktree per obligation, the frozen `affectedRunner` over the matrix test.
- **One run, shared.** `verifyObligations` in `orchestration/owner-verification-runner.ts` is the
  per-obligation run both callers use, over a non-empty list of runs each carrying its due paths, returning a
  non-empty list of verdicts. The gate pairs its runs with `duePaths`; the Task check pairs each owed
  obligation's run (`obligationRunOf`) with the duty's own paths, and launches each matrix-test run through a
  runner that refuses one its deadline cannot hold. The gate's verdicts are unchanged.
- **Deadline 480 s.** A run launches only while the time left holds its whole limit. A refused run is the
  gate's own `spawn-failed` outcome naming the deadline, so its obligation's mutation half is an
  infrastructure verdict and coverage is still judged.
- **Result.** The gate's `InvariantVerdict` per owed obligation, or `unavailable` when the check could not
  run at all (no repository root, files that changed while it ran, a throw). A result is read against the duty
  (`judgeTaskOwnerCheck`), each verdict paired with the obligation it judged; one that judged an Invariant the
  duty does not owe reads as `unavailable`. Survivors and missing paths print in the gate's words
  (`renderOwnerVerificationFailure`).

### 2. The record
One runtime file per repository and Task beside the Task mutation record, written atomically and read
under the one absence rule, with the Task id encoded injectively (ADR-0071 §3). It holds the result and a
digest of the Task's `start_sha`, the owed obligations, and the bytes or absence of the owner, the settled
siblings, the matrix test and every file the Task declares. The helper digests before and after its run; a
difference records `unavailable`. `recordedTaskOwnerCheck` takes the duty and refuses a result for an
Invariant the duty does not owe.

Both Task records share one pure core, `core/task-record.ts`, generic over the result: the digest rule and
its brand, the wire envelope and its parser, the standing (not run, stale, current), the stop observation
and the stop verdict. The file I/O is shared too (`orchestration/task-record-file.ts`). The Task mutation
check's record, digest and outputs are unchanged.

### 3. The stop arm
A fourth name in `STOP_CHECK_NAMES`, `owner`, with its own counter capped at 2, no runner and no lock,
joined into the one combined block message. The block decision's slots are a record keyed by
`STOP_CHECK_NAMES`, with a payload type per name and one constructor (`someChecks`) that refuses a record
naming no check, so a further check adds a name, not a type variant.

- **Blocks** on a missing or stale record, and on missing paths or survivors of an obligation whose matrix
  test the Task lists.
- **Notes and proceeds** on a record of another duty, on the same findings of an obligation whose matrix test the Task does not list
  (only the matrix test answers either: the gate's remedy is to strengthen it, and a Task cannot write a
  file it does not declare), on a red baseline (usually a sibling's unfinished work, as ADR-0071 rules),
  on an infrastructure verdict, on an `unavailable` result, at the cap and on every fault. The note
  reaches the orchestrating model like every stop note (#121).
- **Passes** on a current record with no finding.
- On Pi the same decision is one report-only operator line.

### 4. The brief
An owing Task's brief carries the command, the timeout, each Invariant and matrix test it checks, and how
to answer a survivor or a missing sibling.

### 5. Rulings
- **No manifest switch.** Owner Verification is not optional at the gate, so its early run is not either.
- **A Task whose owner and matrix test are written by two concurrent Tasks** owes nothing at either stop;
  neither can be judged before both land, and the gate remains the backstop.
- **The Wave Gate is unchanged** and stays the control.

## Consequences
- **Enforced within bounds on Claude Code, advisory on Pi**, as ADR-0071.
- **The record can be forged**, as ADR-0071's: it reaches no Proof, receipt or gate evidence.
- **Undigested inputs.** A barrel or tsconfig the coverage walk reads, and another Task's `start_sha` the
  Wave base reads, are not in the digest; a change to them alone leaves the record current.
- **Cost.** Up to 25 runs per obligation inside the implementer's own tool call, once per run of the check.
- **The gate still runs every owed obligation**, including the ones no stop could judge.
