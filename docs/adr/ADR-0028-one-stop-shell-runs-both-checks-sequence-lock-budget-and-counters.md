# ADR-0028: One stop shell runs both checks: sequence, lock, budget and counters

## Status
Accepted (2026-10-17). Records AD-10 of the G4 slice 2 plan
(`.claude/plans/2026-10-16-g4-slice-2-oracle.md`). Builds on AD-1 (one planner, two pure judges) and AD-9
(`planStopChecks` with changed files as an explicit input).

## Context
G4 slice 1 gave the SubagentStop hook one check: the acceptance stop check. It runs the claimant's owed
acceptance testcases under a per-repository runner lock and blocks the stop at most
`ACCEPTANCE_STOP_CHECK_MAX_BLOCKS = 3` times per agent. Slice 2 adds a second check, I7. The affected-test
stop check runs the tests that the attempt's changed files affect, through the operator's
`affectedRunner` in the verification manifest. Both checks now run at the same stop, in the same hook
process, and against the same repository. Both runners write report files that are then read back.

That raises four requirements a shell has to meet together:

- **No interleaving (FR-024, AS-031).** Two runners writing reports into one repository must not
  interleave with each other, or with a third stop that starts at the same time. Each report must be read
  back digest-checked while it is still guarded.
- **Budget (FR-025, SC-003).** The harness kills the hook at 300 s. Each runner keeps its own 120 s limit,
  and settlement still has to run after both checks. The spec forbids shortening a runner's timeout to fit
  the time left: the affected run happens in full or fails open (FR-022).
- **Bounded blocking (FR-023, SC-005).** The affected check needs its own cap of 3, independent of the
  acceptance cap. A flaky affected suite must not use up the acceptance check's blocks, or the reverse.
- **Isolation (INV-3, FR-026).** Nothing either check observes may reach proof, receipts or Wave Gate
  evidence. Every infrastructure fault must fail open with a note naming its cause (FR-022).

FR-027 (one pure decision point for both checks, INV-1) already rules out letting dispatch combine two
independent shells. The remaining question is how one shell sequences, locks, times and counts.

## Options Considered

1. **One shell, one lock acquisition, a shared deadline, and a counter per check (chosen)**
   - Pros: the lock covers both runs and both report reads, so no other stop can get in between them.
     There is one deadline, computed once from `hookStartedAtMs`, so the budget arithmetic lives in one
     place. Each check's counter is a separate file, so the caps are independent by construction. Counter
     transitions are one pure total function that can be tested exhaustively. Dispatch keeps mapping a
     four-case outcome, as it already does.
   - Cons: the lock is held for up to two full runner timeouts (about 240 s), so a concurrent stop in the
     same repository waits longer or fails open. When the acceptance run is slow, the affected check fails
     open with `budget exhausted` more often.

2. **Each check acquires the lock separately**
   - Pros: the lock is held for shorter stretches, and each check's shell stays self-contained, close to
     slice 1's `runAcceptanceStopCheck`.
   - Cons: a third stop can acquire the lock between the two acquisitions and interleave its report writes
     with this stop's runs, which breaks AS-031. It also puts lock handling in two code paths. Rejected.

3. **Clip the affected runner's timeout to the remaining budget**
   - Pros: the affected check runs, at least partly, more often when the acceptance run is slow.
   - Cons: a clipped run that times out cannot be told apart from a slow suite, and a partial report is not
     a verdict. The spec requires a full run or fail-open (FR-022, FR-025). Rejected.

4. **One shared block counter for both checks**
   - Pros: one file and one cap to reason about.
   - Cons: violates FR-023. One check's failures would use up the other's blocks, so a flaky affected suite
     could silence the acceptance check. Rejected.

5. **Model the block counter as a lifecycle (statechart)**
   - Pros: it would follow the executable-models form used for real domain lifecycles.
   - Cons: the counter has no domain states. It is a bounded integer from 0 to 3, per agent and per check,
     and slice 1 already runs this mechanic without a machine. A statechart would add ceremony with nothing
     to model. Rejected under the executable-models policy, in favour of one pure function.

## Decision
**`runStopChecks(input, ports)` in `engine/src/handlers/subagent-stop/stop-checks.ts` is the one stop shell.
It holds the per-repository runner lock once, runs acceptance and then affected under one hook deadline, and
keeps an independent block counter per check. Every decision it acts on is a pure function.**

- **Entry point.** `runStopChecks` replaces `runAcceptanceStopCheck` as the dispatch entry on both
  harnesses: `engine/src/handlers/subagent-stop/dispatch.ts` (Claude Code) and `pi/subagent-stop.ts` (Pi).
  `StopChecksInput` carries `loadGraph`, `stateFilePath`, `taskId`, `agentKey`, `changedFiles` and
  `hookStartedAtMs`. The ports are `StopCheckShellPorts` from
  `engine/src/handlers/subagent-stop/acceptance-stop-check.ts`, which still owns the lock, the counter files
  and the runner adapters.
- **Order of operations at one stop:**
  1. Load the TaskGraph and resolve the canonical repository root.
  2. Derive the changed files through `changedFilesAtStop` (INV-7).
  3. Plan with `planStopChecks` (INV-1).
  4. Read each runnable check's counter.
  5. Acquire the runner lock once.
  6. Run acceptance, then affected, and read each report back digest-checked under the held lock (AS-031).
  7. Release the lock. A throw never skips the release.
  8. Decide.
- **Lock.** The lock file name is unchanged from slice 1, so an old hook and a new hook contend for the same
  lock and never hold two different ones. A lock older than `RUNNER_LOCK_STALE_MS = STOP_HOOK_BUDGET_MS +
  60_000` belongs to a dead hook. No live stop holds it longer, because the harness kills the hook at its
  budget.
- **Budget.** `deadline = hookStartedAtMs + STOP_HOOK_BUDGET_MS (300_000) - SETTLEMENT_RESERVE_MS (30_000)`.
  The affected runner launches only if `deadline - now >= affectedRunner.timeoutMs`. Otherwise the check
  becomes a `budget-exhausted` note that gives the time left and the time the runner needs (AS-030). The
  timeout is never clipped. The acceptance runner always gets its full limit, because it runs first.
- **Counters.** There is one file per agent per check, beside the other per-agent runtime files and never
  in the TaskGraph:
  - `*.acceptance-stop-check.json`, capped by `ACCEPTANCE_STOP_CHECK_MAX_BLOCKS = 3`;
  - `*.affected-stop-check.json`, capped by `AFFECTED_STOP_CHECK_MAX_BLOCKS = 3`.

  The transition rule is one pure total function, `stopCheckBlockDecision(issued, verdicts, cap)`, in
  `engine/src/core/affected-stop-check.ts`:
  - an unreadable count fails open with a note;
  - a count at the cap fails open with a cap note;
  - a failing verdict under the cap blocks and records `count + 1` for that check only;
  - `proceed` clears both counters.

  The shell reads and writes only the files that this function names. When the stop proceeds,
  `runStopChecks` clears both counters, and if a clear fails, that failure becomes a note rather than a
  throw.
- **Verdicts and messages.** The verdicts come from the pure judges `judgeStopCheck` (acceptance) and
  `judgeAffectedRun` (affected, CT-2 types):
  - failing testcases are named with their file, collection errors included;
  - zero testcases is `passed` with a note (AS-023).

  `renderStopChecksBlock` renders one combined block message with a heading per check (AS-028).
- **Outcome and isolation.** `StopChecksOutcome` is `skip | passed | block | note` and carries text only,
  with no completion data. Dispatch maps it to a block decision or a system message, as it mapped slice 1's
  outcome, so nothing reaches settlement, proof, receipts or gate evidence (INV-3, FR-026). Pi runs the
  same shell with `REPORT_ONLY_STOP_CHECK_PORTS`, so both checks are report-only there. The shell prints its
  result through `stopChecksReportLine`.
- **Fail-open totality.** Every fault fails open with a note naming its cause, and the stop proceeds for the
  Wave Gate to judge. A crash before or during the runs becomes a `crashed and did not decide` note that
  includes any lock notes. The faults covered are lock contention, runner start failure, timeout, an
  unreadable report, an exhausted budget, a reached cap, an unreadable counter and a failed clear.
- **Tests.** `engine/tests/core/affected-stop-check.test.ts` covers every counter transition:
  - counts 0 to 1 to 2 to 3, then fail-open at the cap;
  - fail-open on an unreadable count;
  - independent caps per check (AS-029);
  - clear on proceed;
  - a property test that no agent is blocked more than 3 times by either check (SC-005).

  `engine/tests/handlers/stop-checks.test.ts` covers the shell's sequencing, lock and budget.
  `engine/tests/handlers/stop-checks-isolation.test.ts` checks INV-3. CT-2's
  `engine/tests/acceptance/affected-stop-check.acceptance.test.ts` covers AS-020 to AS-031.

## Consequences

**Positive:**
- No other stop can interleave report writes between the two runs, or between a run and its digest-checked
  read-back.
- The 300 s hook budget holds even with both runners at their 120 s timeouts, with 30 s kept for settlement
  (SC-003).
- The caps are independent by file layout, and the counter rule is one exhaustively tested pure function. A
  noisy check cannot silence the other one (SC-005).
- Old and new hooks share one lock file name, so a mixed-version upgrade cannot run two runners
  concurrently in one repository.
- Dispatch on both harnesses stays as thin as it was for slice 1: one call and a four-case match. I7 data
  cannot reach proof by construction of the outcome type.

**Negative:**
- The lock can be held for about 240 s per stop. Parallel sibling agents stopping in the same repository
  wait or fail open, so the affected check gives a weaker signal under heavy parallelism.
- Acceptance runs first and takes its full limit, so a slow acceptance suite starves the affected check,
  which then fails open as `budget exhausted`. We accept this. Acceptance carries completion weight;
  affected is advisory.
- Fail-open everywhere means an infrastructure fault silently lowers I7 to a note. The Wave Gate, not the
  stop check, remains the binding verdict.
- Counters are read before the lock is acquired. Two stops by the same agent cannot run at once, so this
  is safe today, but it rests on that harness property rather than on the lock.
- `acceptance-stop-check.ts` now serves as the ports-and-adapters module for both checks while keeping its
  slice 1 name. The name no longer describes its whole scope.
