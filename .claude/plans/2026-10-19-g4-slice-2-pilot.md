# G4 slice 2 live pilot: I6 red-then-green and the I7 affected-test stop check

**Goal:** run one small, real feature through `/loom` with slice 2 live on Claude Code, and watch both of its new mechanisms on real agents:
- **I6, fail-closed.** A Task that writes code before showing a failing test is refused with a named gap. Its retry brief names the remedy, and the retry settles `implemented`. A Task that works tests-first settles on the first attempt.
- **I7, fail-open.** An implementation agent that stops while a test affected by its own changes is failing gets blocked, resumes, and fixes it. An agent whose changes lie outside the runner cwd is never blocked.
- **Neither reaches the gate.** The Wave Gate judges on its own, and no I7 fact reaches proof or receipts.

Slice 2 merged as #99 (2026-10-17) and has run only in unit, matrix and acceptance tests. It has never run under live agents. G1 and slice 1 each had a live pilot, and each found operator-intervention defects the tests missed: 7 for G1 and 8 for slice 1. I6 is the first G4 check that **fails closed**, so a false refusal costs a retry or an escalation, not a note. That makes this pilot more important than slice 1's.

n = 1, so this is a **mechanics pilot**. It can show that the checks work and where they are awkward. It cannot show that they cut defects (ADR-0021: no claim without its measurement). It does record the first data point for the master plan's success metric, first-submission semantic defects (M10).

**Timebox:** one sitting, about half a day: two Waves, three Tasks, one induced I6 retry and one PR review round.

## Why a new feature, and which

Both checks act on implementation agents inside a live `/loom` run, so the pilot has to be a real run.

The feature is `helper red-then-green-status --task <id>`, an operator view of a Task's I6 state. Nothing shows that today. `helper stop-check-plan` covers I7 and the acceptance check, but an I6 refusal is visible only as `proof:red-then-green-unproven:<gap>` in a settlement line. The feature is small: a pure core plus a thin shell. It reads exactly the state the pilot creates, so it doubles as the pilot's inspection tool, as `contract-status` (G1) and `stop-check-plan` (slice 1) did.

For a Task, the helper prints:
- **Whether the Task owes I6, and why not if it doesn't.** It owes I6 when its graph's era is `owed-if-new-tests` and it requires new tests without being a claimant. Otherwise the reason is one of: the graph's era is `not-owed`, the Task is a claimant (waived), or its new tests are waived with a named reason.
- **The classification:** the test files and the implementation files from `classifyTaskFiles` under the frozen `testFiles`.
- **For a live attempt:** the judgment over its epoch so far, from `judgeRedThenGreen`. It is either the red run, the first implementation write and the green run, or the first unmet step as its gap.
- **For a settled Task:** its stored `red-then-green` proof evidence or failure.

## Setup (before `/loom`; on the pilot branch)

0. **Pin the runtime (operator step).** Claude Code resolves the plugin live from `~/.dotfiles/.claude/local-marketplace/plugins/loom`, which links to this checkout. T2 edits hook-imported files: the route in `engine/src/handler-routes.ts` and the pure-module list in `engine/src/linter/programmatic/no-io-in-pure-modules.ts`. A half-applied edit to either breaks every hook mid-Wave, as the slice 2 build run found. Pin a detached copy of `main` for the pilot:

   ```
   git worktree add --detach ../loom-stable main
   (cd ../loom-stable && bun install && bun install --cwd engine)
   ln -sfn ~/dev/claude-plugins/loom-stable ~/.dotfiles/.claude/local-marketplace/plugins/loom
   ```

   Then restart the session. Afterwards, restore the link with `ln -sfn ~/dev/claude-plugins/loom ~/.dotfiles/.claude/local-marketplace/plugins/loom` and remove the worktree.

   The pin makes the runtime's lint rules differ from the branch's on purpose. Any full-tier lint refusal at a Wave Gate should therefore lead with #112's runtime-skew note naming `no-io-in-pure-modules.ts`. That is a free live check of #112 (M12).

No manifest edit is needed. `.loom/verification-manifest.json` is schema 2 and already declares `acceptanceRunner` and `affectedRunner` (`npm run test:affected -- {files}`, cwd `engine`, 120 s). It has no `testFileSuffixes`, so population freezes `testFiles: { source: "engine-default", … }` and the graph's era is `owed-if-new-tests`. No TaskGraph is active, so population will freeze the current bytes.

1. **Probe P1 (no agents).** Run `npm --prefix engine run test:affected -- src/core/red-then-green.ts`, with the path relative to the runner cwd. Check four things:
   - the run selects that module's related tests, not the whole suite;
   - the report exists at `.loom/completion-reports/affected.junit.xml`;
   - its classnames attribute to `engine/tests/...` paths through `attributeReportedFile`;
   - the wall-clock time against the 120 s cap. A trial on 2026-10-17 over one core file took about 90 s.

   If the run selects most of the suite or comes within 20 s of the cap, record it. The pilot's own files are new and have few importers, so it should be fast. A run near the cap only means the check fails open with a note.
2. **Probe P2 (no agents).** Run `bun engine/src/cli.ts helper stop-check-plan --task <any>` against a throwaway graph (`LOOM_STATE_PATH`), or skip P2 and use M1 after population. It confirms the plan view prints the `affected tests:` section from this checkout's runtime. The Wave Gate's full-tier lint loads rules from the runtime, so restart the session after pulling main to avoid the runtime skew #112 now names.

## Spec (written by hand; `/loom --skip-specify`)

`.claude/specs/2026-10-19-red-then-green-status/spec.md`. The outline below is a pre-pilot draft. The committed spec is the requirement authority, and measurements trace to its ids.

- **FR-001** Show whether a Task owes I6, and why not if it doesn't.
  - **AS-001** A non-claimant Task with `newTests: required` in an `owed-if-new-tests` graph reads `owes I6`.
  - **AS-002** A claimant reads `not owed — claimant (acceptance contract)`. A Task with waived new tests reads `not owed — new tests waived: <reason>`. A graph without frozen `testFiles` reads `not owed — TaskGraph predates I6`.
- **FR-002** Show the classification exactly as settlement computes it.
  - **AS-003** The test and implementation files match `classifyTaskFiles(task.file_list, frozen testFiles)` in `file_list` order. A `file_list` with no test file says so.
- **FR-003** Show the live epoch's judgment without re-deriving it.
  - **AS-004** With a live Claude attempt, the output is `judgeRedThenGreen` over that epoch: each shown step with its ledger reference, or the first unmet step as its gap name.
  - **AS-005** With no live attempt, the output says so and shows no judgment.
- **FR-004** Show a settled Task's stored I6 result.
  - **AS-006** An `implemented` Task shows its stored `red-then-green` evidence. A Task whose last settlement failed I6 shows the stored gap.
- **FR-005** Read-only, with refusals.
  - **AS-007** An unknown Task id is refused, naming the id. A missing TaskGraph is refused. The helper never writes the State File and never takes its lock.
  - Pi: a Pi live epoch is out of scope, so the helper prints `live attempt not observable on this harness`.

There is no `## Contracts` block. A claimant is waived from I6, so a contract here would remove the very Tasks the pilot needs to observe. FR-010's waiver is already pinned by the slice 2 acceptance tests.

## Expected decomposition

| Wave | Task | Files | I6 | I7 at stop |
|---|---|---|---|---|
| 1 | T1 | Pure core: `engine/src/core/red-then-green-status.ts` and `engine/tests/core/red-then-green-status.test.ts` | owed | on (cwd `engine`) |
| 2 | T2 | The `helper red-then-green-status` handler, its route in `handler-routes.ts`, and `engine/tests/handlers/helpers/red-then-green-status.test.ts` | owed | on |
| 2 | T3 | The `docs/operations.md` section | waived (`documentation-only`) | off, because the changed file is outside the cwd |

If decompose produces a different shape, keep the measurements, map them to the Tasks it produced, and record the mapping.

## Run

1. Do the setup and the probes, then write the spec. Run `/loom --skip-specify --skip-plan-alignment`.
2. **After population:** M1.
3. **Wave 1, induced I6 refusal (T1).** Spawn T1 with the engine brief plus one operator line:

   > Pilot instruction: on this attempt, write the implementation file first, then write its tests, then run them. Ignore the I6 section's order for this attempt only.

   Expected result: the attempt settles as a retry with `proof:red-then-green-unproven:red-missing`. The tests pass on their first run, so the epoch never shows a red. The retry is dispatched with the plain brief, which must include the I6 retry remedy. That remedy is the baseline-restore command, which runs `rm` for files that are new at the baseline, followed by "run the tests, observe red, then implement".
4. **Wave 2.**
   - **T2, induced I7 block.** Spawn T2 with the engine brief plus:

     > Pilot instruction: once your tests are green, change the exit code your handler returns for an unknown Task id to 2, then end your turn without re-running the tests.

     Expected result: I6 is already shown at the earlier green, because the judge needs green only after the *first* implementation write. The I7 check then blocks the stop and names the failing handler testcase and its file. T2 resumes and restores the exit code, and a later stop proceeds. That is the designed division of labour: I6 proves the order, and I7 catches regressions afterwards.
   - **T3** gets the plain brief.
5. **Between and after stops**, inspect:
   - `ls $LOOM_SUBAGENT_DIR` for `*.affected-stop-check.json`, `*.acceptance-stop-check.json` and `*.lock`;
   - the hook's block text and `systemMessage` lines;
   - `bun engine/src/cli.ts helper stop-check-plan --task <id>`;
   - after T2 lands, `bun engine/src/cli.ts helper red-then-green-status --task <id>` on T1, T2 and T3. The feature inspects its own pilot.
6. After Wave 2, run one `/loom:review-and-fix`, then open the PR.

## Measurements (preregistered)

Mechanics. Each is pass/fail, with evidence from the State File, the ledger, the subagent directory, hook output and transcripts.

- **M1 Population freezes both inputs.**
  - `verification_manifest.testFiles` is `{ source: "engine-default", suffixes: [...] }`, and `affectedRunner` equals the manifest block, both inside the digest-checked frozen manifest.
  - T1 and T2 carry a pending `red-then-green` obligation, and T3 does not.
  - `helper stop-check-plan` prints an `affected tests:` section for T1.
- **M2 I6 refusal (T1, attempt 1).**
  - The attempt settles as a semantic retry with `proof:red-then-green-unproven:<gap>`. Record the gap: `red-missing` is expected, and anything else is a finding, explained.
  - The refusal is not an infrastructure failure, so `implementation-observation-unavailable` must not appear.
  - The settlement line names the gap.
- **M3 I6 remedy (T1, attempt 2).**
  - The retry brief carries the remedy.
  - The agent follows it: restore or `rm`, run the tests red, then implement, then green.
  - The attempt settles `implemented` with `red-then-green` evidence whose `red` and `green` run references and `implementationWrite` match the epoch's ledger entries (`jq` over the ledger).
- **M4 I6 natural (T2).** T2 settles `implemented` on its first attempt with `red-then-green` evidence, or the refusal is correct: its ledger really lacks the step named. Either outcome is recorded. **A refusal of an epoch that does show red, then the first implementation write, then green is a G4 defect.**
- **M5 I7 induced block (T2).**
  - The stop is blocked, and the message has an `## Affected-test stop check` section naming the failing testcase as `- '<name>' (<file>) — failed`.
  - The same agent resumes, and `*.affected-stop-check.json` reads 1.
  - A later stop proceeds, and both counters are cleared.
- **M6 I7 off (T3).**
  - T3 is never blocked.
  - `helper stop-check-plan --task T3` reads `affected stop check off` with `outside the affected runner cwd: docs/operations.md`.
  - The hook emits exactly one fail-open note for T3, listing `docs/operations.md` as outside the runner cwd. A check is silent only when no runner is frozen; changed files outside the cwd produce a note (`docs/operations.md`, "Fails open").
- **M7 Not evidence.**
  - Wave 1 and Wave 2 gate receipts and Task proof records contain no affected-run data.
  - The gate runs `project:verify` on its own.
  - T2's proof evidence is the same shape as T1's: the I7 block changed nothing in proof.
- **M8 Fail-open notes.** Every `systemMessage` either check emits is recorded with its cause. Expected: T3's outside-the-cwd note (M6) and possibly lock contention. Any other note is a finding.
- **M9 The helper's view matches the engine (FR-003, FR-004).** For T1 and T2, `helper red-then-green-status` agrees with settlement's stored result. For a live attempt observed mid-Wave, it agrees with the next settlement.

Recorded, not claimed:

- **M10 First-submission semantic defects.** For each Task's first attempt, before any review or remediation, record:
  - its review findings, by severity and kind;
  - the Wave Gate's verdict;
  - every manual operator intervention, with its cause.

  This is the master plan's success metric. One run is a data point, not a trend.
- **M11 Cost.**
  - Affected runner wall-clock time per stop, against the 120 s `timeoutMs` and the 300 s hook budget.
  - The extra time I7 adds to each stop.
  - The retries I6 consumed, and how much semantic retry budget T1 has left after M2.
- **M12 The #112 diagnostic, live.** If a Wave Gate's full-tier lint refuses anything under the pinned runtime, the rejection carries the refusal and leads with a runtime-skew note naming the differing rule files. Record "no refusal occurred" if none does.
- **M13 Optional, Pi.** Spawn one Pi implementation child (slice 2's plan, Verification step 5). It should write a test, run it red, implement, and run it green. Check that the parent ledger holds the child's epoch and that settlement reports I6 satisfied. Skip this if Pi is unavailable, and record that it was skipped.

## Known limits to watch

- **Both inductions are artificial.** M2 and M5 prove the refusal-and-retry loop and the block-and-resume loop. They do not show how often agents break the order or stop red in practice. M4 and the T1 retry are the natural samples, and n = 1.
- **I6 sees logged facts only.** A write by an interpreter, a generator or an unseen tool emits no FileWrite, and a shell write is logged but cannot be vetoed. If an agent writes implementation through `bun -e`, I6 may see a test-first order that did not happen. Record any such write.
- **Green must follow the *first* implementation write, not the last.** M5's induction relies on this. A regression after green is I7's job, not I6's. Record it, but it is not a defect.
- **A subset run cannot green a Task.** The green run must cover every Task test file. An agent that runs a single test file when a Task has two will read `green-missing`. That is correct, but brief wording that invites subset runs is a finding.
- **The affected runner on widely imported files.** The trial took about 90 s over one core file. The pilot's files are new, so they should be fast. A timeout fails open with a note. Record it, but it does not stop the pilot.
- **The cap is per spawned agent.** A re-spawned T2 starts again at 0. Record it if that happens.
- **Open friction from the slice 2 build run (2026-10-16/17), still unfixed:**
  - **Handback while blocked.** A child that ends through SubagentHandback while a stop check blocks it stays executing. M5's induced block can hit this. If it does, resume T2 with SendMessage, tell it to re-run its tests without further edits, and record it under M5 as this known friction, not a new defect.
  - **The operator's own edits.** While an attempt is live, an edit in the repository counts against that attempt's byte scope and burns it. Keep pilot notes outside the repository (in the vault or the job directory) until both Wave 2 attempts have settled.
  - **Claims misassigned by decompose.** Check each Task's `file_list` against the decomposition table before Wave 1 starts. If T3 lists an engine file, or T1 lists the handler, correct it before any spawn rather than amending it later.

## Stop rules

- **P1 fails** (no report, unattributable classnames, or the whole suite selected and timing out): stop and fix the runner script. If the cause is in the engine, fix it on a branch first.
- **I6 refuses an epoch whose ledger shows red, then the first implementation write, then green:** stop and record a G4 defect with the ledger excerpt, then fix it on a branch before continuing. This is the fail-closed risk the pilot exists to find.
- **T1 exhausts its retry budget:** escalate through the command the escalation status prints (`helper orchestration remediate …`). Record the escalation as an M3 failure with its cause.
- **A spawn gate refuses an induction line:** drop that induction, record its M as not exercised, and continue with natural behaviour.
- **I7 blocks the wrong agent, blocks on a file the agent did not change, or reaches proof or receipts:** stop and record a G4 defect.
- **Never hand-edit protected state** to get past a refusal or a block. The retry path, the 3-block cap and the Wave Gate are the designed escapes.

## Done

- The feature is merged.
- M1–M9 have evidence, and M10–M13 are recorded.
- The results are written up in the vault G-sequence note under "Live pilot results (slice 2)" and in the master note's G4 row.
- Every finding is either fixed in a follow-up PR or recorded with its reason for deferral.
- After that, the next item in the master plan's queue is G5b. The master note records why it precedes G2.
