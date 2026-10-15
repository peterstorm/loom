# G4 live pilot: the Acceptance Stop Check

**Goal:** run one small, real feature through `/loom` with a frozen contract and the stop check switched on. The pilot watches four things:
- a claimant is blocked at its stop while an owed testcase fails;
- the same agent resumes and fixes the code;
- its next stop passes;
- the Wave Gate still judges on its own.

n = 1, so this is a **mechanics pilot**, like the G1 one. It can show the check works and where it is awkward. It cannot show that the check cuts defects (ADR-0021: no claim without its measurement).

**Timebox:** one sitting, about half a day. One setup step, two Waves, three Tasks, and one PR review round.

## Why a new feature, and which

The check needs a frozen contract and claimants in a later Wave, so it has to run inside a live `/loom` run.

The feature is `helper stop-check-plan`. It is small, pure core plus a thin shell, and it reads exactly the state the pilot creates. So it doubles as the pilot's inspection tool, as `contract-status` did for G1.

`helper stop-check-plan --task <id>` prints what the Acceptance Stop Check would do at that Task's stop, without running anything:
- whether the check is on, meaning a frozen runner exists;
- the owed testcases, grouped by contract;
- the acceptance files they live in;
- the exact runner argv after `{files}` expansion;
- the report path.

When the check is off or nothing is owed, it says which and why.

## Setup (before `/loom`; on the pilot branch)

The runner is frozen at population, so it must exist before the TaskGraph does.

1. **Runner script.** Add to `engine/package.json`:
   `"test:acceptance": "env -u PI_CODING_AGENT vitest run --reporter=junit --outputFile=../.loom/completion-reports/acceptance.junit.xml"`.
2. **Manifest.** Change `.loom/verification-manifest.json` to schema 2. Keep `project:verify` unchanged and add:

   ```json
   "acceptanceRunner": {
     "executable": "npm",
     "args": ["run", "test:acceptance", "--", "{files}"],
     "cwd": "engine",
     "timeoutMs": 120000,
     "report": { "kind": "required-file", "path": ".loom/completion-reports/acceptance.junit.xml" }
   }
   ```

   This edits the operator source file. Population freezes it into the TaskGraph, so the edit must land before `/loom` populates, and no active TaskGraph may exist (`helper write-verification-manifest` is create-only and refuses after population). Never hand-edit protected state.
3. **Probe P1 (no agents).** Run `npm --prefix engine run test:acceptance -- engine/tests/acceptance/contract-status.acceptance.test.ts`. Check four things:
   - only that file ran;
   - the report exists at the declared path;
   - its classnames are suffix-attributable to `engine/tests/acceptance/contract-status.acceptance.test.ts`, the gate's `testcaseAcceptanceFile` rule;
   - the wall-clock time.

   If any of these fails, fix the setup before going on. A runner that cannot be attributed would only ever fail open, and the pilot would observe nothing.

## Spec (written by hand; `/loom --skip-specify`)

`.claude/specs/2026-10-14-stop-check-plan/spec.md`. The outline below is the pre-pilot draft; the committed spec is the requirement authority, and its numbering differs (FR-002 forbids re-derivation, FR-003 is the off-reason, FR-005 the refusals, and AS-003 adds the command-refused cause for an owed file outside the runner cwd). Measurements trace to the committed ids.

Draft outline:

- **FR-001** Report the owed check for a claimant: each contract's owed testcases, the acceptance files, the expanded runner argv, and the report path.
  - **AS-001** A claimant of a frozen contract lists every owed testcase under its contract, and the argv holds each file as one argument in place of `{files}`.
  - **AS-002** A testcase whose anchors are not all due by the Task's Wave is not listed.
- **FR-002** Say why the check is off.
  - **AS-003** It names the reason: no runner frozen, the Task claims nothing, or the contract is not yet frozen.
- **FR-003** Refuse bad input.
  - **AS-004** An unknown Task id is refused, naming the id. A missing TaskGraph is refused.

## Contract (in the plan's `## Contracts`)

```
### CT-1: Stop-check plan rendering

**Types file:** `engine/src/core/stop-check-plan-types.ts`
**Acceptance tests:**
- `engine/tests/acceptance/stop-check-plan.acceptance.test.ts` — AS-001, AS-002, AS-003, AS-004
**Statement:** `renderStopCheckPlan(graph, taskId)` is total over every parsed TaskGraph and reuses `stopCheckExpectation` and `acceptanceRunnerCheck`. It never re-derives what is owed, and it never runs the runner.
```

## Expected decomposition

| Wave | Task | Role | Claims |
|---|---|---|---|
| 1 | T1 | Contract Task: the types file and the acceptance tests (`AS-00n: …` names) | — (contributes only) |
| 2 | T2 | Pure `core/acceptance-contract/stop-check-plan.ts` | AS-001, AS-002, AS-003 |
| 2 | T3 | The `helper stop-check-plan` handler and route | AS-004 |

T2 and T3 are both claimants in the same Wave. That gives the runner lock a real chance of contention.

## Run

1. Do the setup and P1, then write the spec. Run `/loom --skip-specify --skip-plan-alignment` and paste the `## Contracts` block into the architecture interview.
2. **After population:** M1.
3. **Wave 1** runs as in the G1 pilot. Its gate observes RED and freezes CT-1.
4. **Wave 2, induced stop for T2.** Spawn T2 with the engine brief plus one operator line:

   > Pilot instruction: end your first turn immediately, without edits; then follow the stop check's message.

   T3 gets the plain brief, so its stops are natural.
5. **Between and after stops**, inspect:
   - `ls $LOOM_SUBAGENT_DIR` for `*.acceptance-stop-check.json` counters and `*.lock` files;
   - the hook's `systemMessage` lines;
   - `jq '.verification_manifest.acceptanceRunner, .acceptance_contracts' .claude/state/active_task_graph.json`.
6. After Wave 2, run one `/review-and-fix`, then open the PR.

## Measurements (preregistered)

Mechanics. Each is pass/fail, with evidence from the State File, the subagent directory, hook output and transcripts:

- **M1** Population freezes the runner: `verification_manifest.acceptanceRunner` equals the setup block, inside the digest-checked frozen manifest.
- **M2** **Induced block (T2):**
  - T2's first stop is blocked, and the message names its owed testcases as "did not run" or "failed".
  - The same agent id resumes with `stop_hook_active: true`.
  - Its counter reads 1.
  - Once its owed testcases pass, a later stop proceeds, the counter file is gone, and the Task settles normally.
- **M3** **Natural run (T3):** record whether it was ever blocked, how often, and whether each block was correct (a testcase it really owed was really failing).
- **M4** **Lock:** if T2 and T3 stop while a check is in flight, the second gets the "holds the runner" note and is not blocked. After the Wave, no `acceptance-stop-check.*.lock` remains.
- **M5** **Fail-open notes:** every `systemMessage` the check emits is recorded with its cause. Target: none beyond lock contention, so any other note is a finding.
- **M6** **Not evidence:** the Wave 2 gate's completion receipt and the Task proof records are shaped exactly as without the check, and the gate runs `project:verify` on its own.

Recorded, not claimed:

- **M7** Runner wall-clock per stop, against the 120 s `timeoutMs` and the 300 s hook budget, and the extra time each stop adds.
- **M8** Review findings per Wave Gate and remediation rounds before merge. Also every manual operator intervention, with its cause.

## Known limits to watch

- **The induced stop is artificial.** It proves the block-and-resume loop, not that agents stop early in practice. M3 is the natural sample, and n = 1.
- **Sibling noise.** T3's acceptance testcases fail until T3 is done. The check only runs a claimant's *own* owed testcases, so T2 is never blocked on T3's. A block of T2 on T3's testcases is a defect.
- **The cap is per spawned agent.** A re-spawned T2 starts again at 0. Record it if that happens.
- **Pi is out of scope.** Pi is report-only and was unit-tested in #90. A Pi run is a separate, optional check.

## Stop rules

- **P1 fails** (attribution, file filtering, or the report path): stop and fix the setup. If the cause is in the engine, fix it on a branch first.
- **A spawn gate refuses the induced-stop line:** drop the induction, record M2 as not exercised, and continue with natural stops only.
- **A block of the wrong agent, or for testcases it does not owe:** stop and record a G4 defect. The same applies to any stop-check effect on the TaskGraph or on Wave Gate evidence.
- **Never hand-edit protected state** to get past a block. Hitting the cap and letting the Wave Gate judge is the designed escape.

## Done

The feature is merged, and M1–M6 have evidence. M7 and M8 are written up in the vault G4 note under "Live pilot results". G4 slice 2 is scoped from those findings: I7 affected tests beyond claimants, I6 the free red state, or a fix the pilot shows is needed first.
