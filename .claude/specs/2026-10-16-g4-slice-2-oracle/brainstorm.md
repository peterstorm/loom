# Brainstorm Summary

**Building:** G4 slice 2 puts the oracle inside the implementation loop with two separate requirements. The first is I6, a fail-closed red-then-green proof obligation for non-claimant Tasks that must add new tests. The second is I7, an affected-test stop check at SubagentStop for every implementation Task. Both reuse slice 1's operator-declared runner, so no model chooses which tests run.

**Approach:** Approach A. Add an I6 ledger obligation and an I7 affected-runner stop check in one slice. TestRun ledger facts gain per-file results. A new `red-then-green` proof obligation is decided from ordered ledger facts. A new manifest `affectedRunner` lets the shared stop-check planner plan affected tests for every implementation Task.

**Key Constraints:**
- Nothing is model-chosen. Runners come only from the operator's `.loom/verification-manifest.json`. A Task's tests are its `file_list` entries that match the test pattern. Which tests a run covered comes only from the structured report (JUnit or vitest JSON) at capture, never from the agent's command string.
- Today's TestRun facts hold only `{command, exit, report:{total, failed, source}}` (`engine/src/machine/types.ts:40-48`, `engine/src/core/structured-test-report.ts:7-11`). I6 cannot be decided until capture records per-file results. The existing `parseJunitTestcases` is the starting point. Facts stay facts: judgments are still computed at read time (`judgeTestRun`).
- Two trust models, kept apart:
  - I6 is a completion proof obligation in `engine/src/core/proof-obligations.ts`. It fails closed: a wrong order fails proof and settlement retries the Task.
  - I7 follows slice 1's stop-check rules. It fails open with a block cap (`ACCEPTANCE_STOP_CHECK_MAX_BLOCKS`), and its data never reaches Task proof, receipts or gate evidence (pilot M6).
- A missed I6 order cannot be repaired by resuming the agent, because the order lies in the past. So I6 is never a stop block, and there is no PreToolUse write veto.
- `planStopCheck` (`engine/src/core/acceptance-contract/stop-check-planner.ts`) stays the single pure decision point. Both the live SubagentStop hook and the read-only `helper stop-check-plan` consume it, and they must not disagree. The planner stays pure and total.
- Runner limits stay as they are: 120 s per runner and a 300 s hook budget. Runs are serialized by a lock, because each runner has one declared report path. The affected runner and the acceptance runner must not corrupt each other's reports, and both must fit in one stop's budget.
- The manifest schema changes additively. Schema 1 and schema 2 without the new key stay valid, and a missing `affectedRunner` means the I7 check is off with a stated reason.
- Soundness limit, to be documented where the obligation lives: I6's ordering proof is only as strong as the guarantee that every write and every test run produced a ledger fact. Changes made without a ledger event (scripts, generators, writes through tools the hooks do not see) are silent holes. Shell writes are logged as `FileWrite via: "shell"` but cannot be vetoed. The obligation is a proof over logged facts, not over the filesystem.
- This feature run is the first live use of the Claude Code `LOOM_IMPLEMENTATION_BRIEF` marker expansion (PR #97). That does not change scope.

**In Scope:**
- **Per-file TestRun results.** At capture, a TestRun fact records which test files ran and whether each passed or failed, taken from the structured report. The ledger read-back keeps the existing count checks and fails closed on malformed data.
- **I6 obligation.**
  - Who owes it: non-claimant implementation Tasks whose verification policy has `newTests: required`.
  - The rule: the epoch's ordered ledger must show, in this order:
    1. a TestRun with a failing result on at least one of the Task's test files;
    2. the first FileWrite to a non-test (implementation) file;
    3. a later TestRun in which the Task's test files pass.
  - Proof failures are a new `ProofFailure` variant that names which step was missing or out of order.
  - Claimants (`covered-by-acceptance-contract`) do not owe the observed-red step. They are credited red from the frozen acceptance red window.
- **`affectedRunner` manifest entry.**
  - It is operator-declared and uses the same `{files}` placeholder and form checks as `acceptanceRunner`.
  - `{files}` is set to the Task's changed files, e.g. `vitest related --run {files}`.
  - Population freezes it, digest-checked, into the TaskGraph exactly like `acceptanceRunner`.
- **I7 affected-test stop check.**
  - It applies at SubagentStop for every implementation Task, claimant or not.
  - It runs the affected runner over the Task's changed files and blocks the stop with the failing tests, so the same agent resumes.
  - It fails open with the same notes, lock and block cap as slice 1, and is never completion evidence.
- **Planner and view.** The shared stop-check planner, and therefore `helper stop-check-plan --task <id>`, shows the affected-test plan next to the acceptance plan, with an explicit off-reason when the check is off.
- **Docs.** Update the vault G4 section and the I6/I7 notes, plus the in-repo docs that describe the stop check and proof obligations, including the soundness limit.

**Out of Scope:**
- I5 (per-edit diagnostics) and the repeat-tool loop-breaker.
- I8 (a full deterministic suite at SubagentStop: typecheck, lint, architecture rules).
- The original I7 cadence rule ("a test run within the last N writes") and any PreToolUse advice or veto for it.
- A PreToolUse veto on the first implementation write (I6 is checked only at completion).
- A declared source-to-test map, and any model-chosen or command-string-derived test identity.
- Engine-owned red baseline runs at SubagentStart.
- Closing the ledger soundness holes themselves (full event coverage, HMAC or out-of-reach ledger). They are documented as a limit, not fixed.
- Changes to Wave Gate verification. `project:verify` stays its own authority.

**Open Questions:**
- What is the exact test-file pattern used to split `file_list` into test and implementation files? Is it operator-declared in the manifest or a fixed engine default? And how are files in neither class handled, such as fixtures, helpers and types?
- What are "the Task's changed files" for the affected runner? Options: ledger FileWrite paths for the epoch, the git diff against the attempt baseline, or `files_modified` crossed with `file_list`. And how are deleted and renamed files handled?
- How does I6 treat a Task whose test files fail for a non-behavioral reason, such as an import or collection error? The vault says a missing import alone is not a behavioral red. Does a report-level failure count, or must at least one testcase in the file fail with an assertion failure?
- Does I6 apply under `PI_STRUCTURED_EVIDENCE_POLICY` and untrusted runs, or only to trusted ledger runs (a run with an exit code and a parsed report)?
- How do the two runners share a stop? Are they sequenced under one lock with one combined block message, or kept as separate checks with separate block counters? And how does the budget split between them?
- Does the I7 check skip for a Task with no changed files, or one whose affected run finds zero tests, and is that a silent skip or a note?
- Are existing ledgers and TestRun facts without per-file results read without error? I6 would then be unprovable for them, so they fail closed or are grandfathered for TaskGraphs that are already running.
