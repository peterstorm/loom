# G4 slice 2 re-pilot: the #122 fixes under live agents

**Goal:** run one small feature through `/loom` on Claude Code and observe, under live agents, what the 2026-10-19/20 pilot could not measure, plus each fix #122 made for that pilot's findings:
- **M5 (not exercised then):** an I7 block induced on a Task, the agent resuming, and a later stop proceeding. The induction is now sent through the `LOOM_OPERATOR_NOTE` channel (#119).
- **M6/M8 (unobservable then):** fail-open stop-check notes reaching the orchestrating session, verbatim (#121).
- **#117:** every implementation spawn uses `loom:<agent>`, and no reservation strands.
- **#118:** the I6 retry runs the engine's restore command as given, and the guard admits it. Agents' final verification runs are trusted in the documented forms.
- **#120:** the affected run's wall-clock time against the new 200 s timeout.

n = 1, so this is a mechanics pilot, as before. It shows the fixes work end to end and where they are awkward. It does not measure defect rates. It does record a second first-submission data point (M10 from the first pilot).

**Timebox:** one sitting, about half a day: 2 Waves, 3 Tasks, one induced I6 retry, one induced I7 block and one PR review round.

## Vehicle

`bun scripts/ledger-epoch.ts`, a read-only view of one attempt's ledger epoch, numbered exactly as settlement's I6 evidence cites it. The spec is `.claude/specs/2026-10-20-ledger-epoch-view/spec.md`: FR-001 to FR-006 and AS-001 to AS-005. The last pilot checked I6 evidence positions by hand with `jq`, so this view doubles as the re-pilot's inspection tool (R10).

## Setup (operator, before `/loom`)

0. **Restart into a pinned runtime.** Two things require a fresh Claude Code session:
   - plugin hooks load at session start, and #122 added a PostToolUse hook (`surface-stop-check-notes`);
   - T1 enrolls its module in the purity check, `engine/src/linter/programmatic/no-io-in-pure-modules.ts`, which the lint hook imports.

   Pin a detached copy of `main` so the run's own edits cannot break a hook mid-Wave:

   ```
   git -C ~/dev/claude-plugins/loom worktree add --detach ../loom-stable main
   (cd ~/dev/claude-plugins/loom-stable && bun install && bun install --cwd engine)
   ln -sfn ~/dev/claude-plugins/loom-stable ~/.dotfiles/.claude/local-marketplace/plugins/loom
   ```

   Then start a new Claude Code session in `~/dev/claude-plugins/loom` on branch `feat/g4-repilot-ledger-epoch`. Afterwards, restore the link with `ln -sfn ~/dev/claude-plugins/loom ~/.dotfiles/.claude/local-marketplace/plugins/loom` and remove the worktree.
1. **Probe P1 (done 2026-10-20, no agents).** `npm --prefix engine run test:affected -- src/core/stop-check-note.ts`:
   - it took 76 s, against a 200 s timeout;
   - it selected only related tests;
   - the report exists, and its classnames are `tests/...` paths.

   T1's module is a new leaf, so it should be faster.
2. **Probe P2 (in the new session, no agents).** Confirm the note hook is live. Plant a probe note for the session, make one trivial Agent call, and check that the note arrives as context and the sidecar is gone:

   ```
   bun -e 'import { publishStopCheckNote } from "./engine/src/stop-check-note-sidecar"; console.log(publishStopCheckNote("<session-id>", "probe", { taskId: "T0", message: "probe" }))'
   ```

   The session id is the transcript file name under `~/.claude/projects/-home-peterstorm-dev-claude-plugins-loom/`. If the note does not arrive, stop: R5 cannot be measured.
3. **Pi agents.** These were rendered from `main` on 2026-10-20. Nothing to do unless Pi is used for R11.

## Expected decomposition

| Wave | Task | Files | I6 | I7 at stop |
|---|---|---|---|---|
| 1 | T1 | `engine/src/core/ledger-epoch-view.ts`, `engine/tests/core/ledger-epoch-view.test.ts`, `engine/src/linter/programmatic/no-io-in-pure-modules.ts` (enrollment) | owed | on (cwd `engine`) |
| 2 | T2 | `scripts/ledger-epoch.ts`, `engine/tests/scripts/ledger-epoch.test.ts`, `engine/tsconfig.json` (include the script) | owed | on: the test file is beneath the cwd |
| 2 | T3 | the `docs/operations.md` section "Reading an attempt's ledger epoch" | waived (`documentation-only`) | fails open with a note: no changed file beneath the cwd |

If decompose produces another shape, map the measurements onto it and record the mapping. Check each `file_list` against this table before Wave 1 starts, and correct it before any spawn.

## Run

1. Do the setup and the probes. Run `/loom --skip-specify --skip-plan-alignment` against the committed spec.
2. **Wave 1: induced I6 refusal on T1, sent as an operator note.** Run `helper orchestration brief --task T1 --note "Pilot instruction: on this attempt only, write the implementation file first, then its tests, then run them; ignore the I6 section's order for this attempt."`. Spawn exactly the printed `claude` invocation.

   Expected: the attempt settles as a retry with `proof:red-then-green-unproven:red-missing`. Spawn the retry from a plain `brief --task T1`. Its remedy step 1 is the restore command naming the literal project root. The agent runs it as given, observes red, implements, and settles `implemented`.
3. **Wave 2.**
   - **T2: induced I7 block, sent as an operator note.** Run `brief --task T2 --note "Pilot instruction: once your tests are green, change the exit code the script returns for a session with no ledger to 0, then end your turn without re-running the tests."`.

     Expected: I6 is already shown at the earlier green. The affected check blocks the stop, naming the failing script testcase. T2 resumes and restores the exit code, and a later stop proceeds.
   - **T3** gets a plain brief. Expected: its stop fails open with a note that no changed file lies beneath the runner cwd, and the orchestrator sees that note as context on its next Task/Agent result.
4. Between and after stops:
   - inspect `$LOOM_SUBAGENT_DIR` (default `/tmp/claude-subagents`) for `*.stop-check-note.json`, `*.affected-stop-check.json` and `*.lock`;
   - record every `Loom stop checks did not decide…` context block verbatim;
   - after T2 lands, run `bun scripts/ledger-epoch.ts --session <id> --agent <id> --type <type>` for T1 and T2.
5. After Wave 2, run one `/loom:review-and-fix`, then open the PR.

## Measurements (preregistered)

Pass/fail, with evidence from the State File, the ledger, the subagent directory, hook output and transcripts.

- **R1 (#117).** Every implementation spawn is the `brief` invocation (`loom:<agent>`). No attempt settles `reservation-reclaimed`. A deliberately bare `subagent_type` is optional; if tried, it is refused before reserving and the graph bytes are unchanged.
- **R2 (#119).** Both noted spawns are admitted. Each child's first prompt holds an `## Operator Note` section with the note as a bullet, and no `LOOM_OPERATOR_NOTE` line. The parent transcript keeps the marker plus its note line. Optional: a line typed outside the channel is refused with the grammar, and nothing is reserved.
- **R3 (M2 repeat).** T1 attempt 1 settles as a semantic retry with a named gap; `red-missing` is expected. `implementation-observation-unavailable` must not appear.
- **R4 (#118 restore).** T1's retry brief carries the restore command with the literal root. The agent's transcript runs it unaltered, and no guard block appears. The attempt settles `implemented`, and its red, write and green positions match the epoch's facts (R10).
- **R5 (#118 verification forms).** Every final verification run is trusted: a ledger `TestRun` with an exit code and a parsed report. Record which form each agent used.
- **R6 (M5).** T2's stop is blocked with an `## Affected-test stop check` section naming the failing testcase, and `*.affected-stop-check.json` reads 1. The same agent resumes, and a later stop proceeds with both counters cleared. Known friction: if the child ends through SubagentHandback while blocked, resume it with SendMessage and record it.
- **R7 (M6/M8, #121).** For each note, record:
  - the note text;
  - when it arrived in the orchestrator's context;
  - which Task/Agent result carried it;
  - that its sidecar is gone after delivery.

  Expected: T3's note that no changed file lies beneath the runner cwd. Any other fail-open note, such as a timeout or a held lock, is also recorded. A note that reaches only the operator's terminal and never the context is an R7 failure.
- **R8 (#120).** Each affected run's wall-clock time, against the 200 s timeout and the 300 s hook budget, and the time I7 adds to each stop.
- **R9 (M7 repeat).** No affected-run data appears in proof records, receipts or gate artifacts. Each Wave Gate runs `project:verify` on its own.
- **R10 (M9-style).** `scripts/ledger-epoch.ts` positions for T1 and T2 equal their stored red-then-green evidence positions.

Recorded, not claimed:
- **M10.** First-submission findings per Task, Wave Gate verdicts, and every manual operator intervention with its cause.
- **R11 (optional, Pi).** One Pi implementation child: note channel, report-only stop checks appended to the parent result. Skip if Pi is unavailable.

## Known limits to watch

- Both inductions are artificial. They prove the loops, not how often agents break the order.
- I6 sees logged facts only (F-H). A stash-and-restore around the red is still possible; record it if seen.
- A background spawn's note arrives with the next Task/Agent result, not its own. Spawn T3 in the foreground so R7 sees its note on its own result, or record which result carried it.
- The operator's own edits during a live attempt burn its byte scope. Keep notes outside the repository (the vault, or the session scratchpad) until Wave 2 settles.

## Stop rules

- **P2 fails** (the note hook is not live): fix the session or registration before spawning anything.
- **The spawn gate refuses a noted marker it should admit:** record it as an R2 defect, and fix it on a branch first.
- **I6 refuses an epoch that does show red, then the first implementation write, then green:** a G4 defect. Stop and fix.
- **The guard blocks the engine's restore command:** an R4 defect, a #118 regression. Stop and fix.
- **I7 blocks the wrong agent, or reaches proof or receipts:** a G4 defect. Stop.
- **Never hand-edit protected state** to get past a refusal or a block.

## Done

- The feature is merged.
- R1–R10 have evidence, and M10 and R11 are recorded.
- Results are written up under "Re-pilot results" in the vault G-sequence note and in the master note's G4 row.
- Every finding is fixed or filed with its reason.
- Then G5b.
