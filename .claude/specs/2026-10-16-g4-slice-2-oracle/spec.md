# Feature: G4 slice 2 — the oracle inside the loop (I6 red-then-green, I7 affected-test stop check)

**Status:** Draft 2026-10-16. Brainstorm: `.claude/specs/2026-10-16-g4-slice-2-oracle/brainstorm.md` (Approach A). Interview: every question resolved to its recommended option (1A–8A).

> **Amended 2026-10-16 (architecture interview Q1):** Pi had no evidence ledger. As first written, I6 could never be satisfied on Pi and I7 could never see a Pi Task's changed files. The operator chose to build a Pi ledger recorder in this slice. Pi now mints the same trusted ledger facts as Claude Code through one shared minting rule (US8, FR-031 to FR-035, AS-036 to AS-041, SC-007). FR-008 and OOS-009 were reworded so that only untrusted evidence stays excluded, meaning Pi-structured transcript evidence, which is not a ledger fact. Existing anchors keep their numbers, and new anchors are appended.

## Summary

G4 slice 1 put the operator-declared acceptance runner at a claimant's SubagentStop. Slice 2 puts the oracle inside the implementation loop through two requirements that have different trust models.

**I6 (red-then-green)** is a completion proof obligation, and it fails closed. A non-claimant implementation Task that must add new tests has to show, in its epoch's ordered ledger, a failing run of its own tests, then its first implementation write, then a passing run of its own tests. A wrong or missing order fails proof, and settlement retries the Task.

**I7 (affected tests)** is a stop check, and it fails open. At SubagentStop for every implementation Task, the operator-declared affected runner runs over the Task's changed files. A failing test blocks the stop, so the same agent resumes. I7 is never completion evidence.

Nothing is model-chosen. The runners and the test-file pattern come from the operator's manifest. A Task's tests come from its `file_list`. Which tests a run covered comes only from the structured report at capture.

## User Scenarios

### US1: [P1] Test runs record which test files ran and how each fared

**As the** Loom engine deciding I6
**I want** every captured TestRun fact to carry per-file pass/fail results taken from the structured report
**So that** I6 can be decided from ledger facts alone, without trusting the agent's command string

**Acceptance Scenarios:**
- AS-001: Given a test run whose structured report lists testcases in several files, when the run is captured, then the TestRun fact records each reported test file with whether any testcase in it failed, alongside the existing command, exit and count fields
- AS-002: Given a captured TestRun fact, when the ledger is read back, then the existing count consistency checks still apply, and per-file results that are malformed or that contradict the counts fail closed as unreadable evidence
- AS-003: Given a ledger written before this feature, whose TestRun facts have no per-file results, when it is read back, then it reads without error and those facts are treated as having no per-file results
- AS-004: Given a test run whose command names one file but whose report covers others, when it is captured, then the recorded files are exactly those in the report, and the command string contributes nothing

### US2: [P1] A non-claimant Task that must add tests proves red, then implementation, then green

**As an** operator
**I want** completion to require proof that the Task's new tests failed before the implementation was written and passed after
**So that** tests written to fit finished code, or tests that never failed, cannot settle a Task

**Acceptance Scenarios:**
- AS-005: Given a non-claimant implementation Task whose frozen policy has `newTests: required`, and whose epoch ledger shows a trusted TestRun where at least one testcase in one of the Task's test files fails, then a later first FileWrite to one of its implementation files, then a later trusted TestRun in which the Task's test files pass, when proof is evaluated, then the I6 obligation is satisfied
- AS-006: Given the same Task whose first implementation write comes before any qualifying red run, when proof is evaluated, then proof fails with a failure naming the red step as missing before the first implementation write, and settlement retries the Task
- AS-007: Given a Task with a qualifying red run and an implementation write but no later run in which its test files pass, when proof is evaluated, then proof fails naming the green step as missing
- AS-008: Given a Task that has a red run and a green run but never writes an implementation file, when proof is evaluated, then proof fails naming the implementation-write step as missing
- AS-009: Given a Task that creates no implementation file, whose only failing run of its test files is a collection or import error with no failing testcase in those files, when proof is evaluated, then that run does not count as red, and proof fails naming the red step as missing
- AS-010: Given a Task that writes a fixture, helper or type file from its `file_list` that does not match the test pattern, before any red run, when proof is evaluated, then that write counts as the first implementation write, and proof fails naming the red step as out of order
- AS-011: Given a red or green step that is satisfied only by a Pi-structured or otherwise untrusted run, when proof is evaluated under any evaluation policy, then that run does not count, and proof fails naming the unsatisfied step and saying that only trusted ledger runs qualify
- AS-012: Given a claimant Task (`covered-by-acceptance-contract`), when proof is evaluated, then it owes no observed-red step and is credited red from the frozen acceptance red window
- AS-013: Given a Task whose `file_list` contains no file matching the test pattern while it owes I6, when proof is evaluated, then proof fails with a failure saying the Task declares no test files
- AS-014: Given the same ledger facts evaluated twice, when proof is evaluated, then the result is identical both times (the judgment is computed from the facts at read time)

### US3: [P1] The operator declares the affected runner and the test-file pattern

**As an** operator
**I want to** declare, in my verification manifest, the affected-test runner and optionally the test-file pattern
**So that** the engine never guesses which command runs my tests or which files are tests

**Acceptance Scenarios:**
- AS-015: Given a manifest with an `affectedRunner` that uses the `{files}` placeholder and passes the same form checks as `acceptanceRunner`, when the TaskGraph is populated, then the runner is frozen into the TaskGraph and digest-checked exactly like `acceptanceRunner`
- AS-016: Given an `affectedRunner` that fails a form check, when the manifest is read, then it is refused with a message naming the failed check, exactly as for `acceptanceRunner`
- AS-017: Given a schema-1 manifest, or a schema-2 manifest without the new keys, when it is read, then it stays valid, I7 is off with a stated reason, and test files are classified by the engine's default test-suffix list
- AS-018: Given a manifest that declares a test-file pattern, when a Task's `file_list` is classified, then a file is a test file exactly when it matches that pattern, and every other `file_list` entry is an implementation file
- AS-019: Given a frozen affected runner or test-file pattern whose bytes change after population, when it is used, then the digest check refuses it, as for the acceptance runner

### US4: [P2] Every implementation Task's stop runs its affected tests

**As an** operator
**I want** each implementation Task's stop blocked while tests affected by its changed files fail
**So that** the same agent fixes the regression it caused while its context is still live

**Acceptance Scenarios:**
- AS-020: Given an implementation Task (claimant or not) with a frozen affected runner and at least one changed file, when the agent stops and the affected run reports a failing test, then the stop is blocked with a message naming each failing test and its file, and the same agent resumes
- AS-021: Given the affected run reports all tests passing, when the agent stops, then the affected check does not block
- AS-022: Given a Task with no changed files in its epoch, when the agent stops, then the affected check is skipped with a note stating that there are no changed files
- AS-023: Given an affected run that reports zero tests, when the agent stops, then the check passes with a note stating that zero affected tests were found
- AS-024: Given a changed file that was deleted by stop time, when `{files}` is expanded, then it is excluded. Given a renamed file, then it is passed under its new path
- AS-025: Given the affected check has blocked this agent 3 times, when it stops again with failures, then the check fails open with a note and does not block
- AS-026: Given the affected runner times out (120 s), exits without a readable report, or cannot be started, when the agent stops, then the check fails open with a note naming the cause
- AS-027: Given any affected-check outcome, when proof, receipts or gate evidence are computed, then nothing from the affected check appears in them

### US5: [P2] The acceptance and affected checks share one stop safely

**As an** operator
**I want** both runners to run at one stop without corrupting each other's reports or exceeding the hook budget
**So that** one stop gives one coherent verdict

**Acceptance Scenarios:**
- AS-028: Given a claimant with both runners frozen, when it stops, then the acceptance runner runs first and the affected runner second, in sequence under one lock, and a single combined block message lists the failures of each check under its own heading
- AS-029: Given one check has used up its own block cap, when the agent stops again, then only the other check can still block, because each check has its own counter capped at 3
- AS-030: Given the acceptance run leaves too little of the 300 s hook budget for a full affected run, when the stop proceeds, then the affected check fails open with a note stating that the budget was exhausted, and the hook finishes within 300 s
- AS-031: Given two agents stopping concurrently in the same project, when both checks run, then no report file is read while another run is writing it

### US6: [P2] The plan view shows the affected-test plan

**As an** operator
**I want** `helper stop-check-plan --task <id>` to show the affected-test plan next to the acceptance plan
**So that** I can predict and explain any I7 block before it happens

**Acceptance Scenarios:**
- AS-032: Given a Task with a frozen affected runner, when `stop-check-plan` renders it, then the affected plan shows the Task's current changed files, the runner argv after `{files}` expansion, the runner cwd and the report path, next to the unchanged acceptance plan
- AS-033: Given the affected check would be off (no runner frozen, no changed files, or the command cannot be formed), when the Task renders, then the affected plan states that it is off and names exactly one reason
- AS-034: Given any planner fixture, when the live SubagentStop hook and `stop-check-plan` evaluate it, then they produce the same plan

### US8: [P1] Pi records the same ledger facts as Claude Code

**As an** operator running Loom under Pi
**I want** every Pi implementation child to mint the same ledger facts that Claude Code's recorder mints for the same tool calls
**So that** I6 and I7 decide from trusted ledger facts on both harnesses, instead of Pi failing I6 closed for lack of a ledger

**Acceptance Scenarios:**
- AS-036: Given the same read, edit, write and bash tool calls (including a test run with a structured report), delivered once through Claude Code's recorder and once through a Pi implementation child, when both are recorded, then the two ledgers hold identical facts in identical order under each agent's epoch
- AS-037: Given a Pi non-claimant implementation Task with `newTests: required` whose child's ledger shows a behavioral red run of its test files, then its first implementation write, then a green run, when the batch is settled, then the I6 obligation is satisfied
- AS-038: Given a Pi Task whose only test evidence is Pi-structured transcript evidence and whose epoch holds no trusted ledger TestRun, when proof is evaluated, then I6 fails naming the untrusted-only step
- AS-039: Given a Pi child with no write grant, or whose grant was rejected, when it runs tool calls, then nothing is recorded into any epoch and the child's stderr says why
- AS-040: Given a Pi implementation Task with a frozen affected runner whose child wrote files, when the batch is settled, then the report-only affected check runs over the changed files taken from that child's epoch
- AS-041: Given a literal `mv a b`, `git mv a b` or `cp a b` run through either harness, when it is recorded, then a shell FileWrite for `b` is minted, so a renamed file appears among the changed files under its new path
- AS-042: Given a Task that creates an implementation file (one its artifact baseline records as missing), whose only failing run of its test files before its first implementation write is a collection or import error, followed by that write and a green run, when proof is evaluated, then that run counts as red and I6 is satisfied

### US7: [P3] Docs state the obligation and its soundness limit

**As an** operator or contributor
**I want** the I6/I7 behaviour and I6's soundness limit documented where they live
**So that** no one reads the ordering proof as a filesystem guarantee

**Acceptance Scenarios:**
- AS-035: Given the updated docs (the vault G4 section, the I6 and I7 notes, and the in-repo stop-check and proof-obligation docs), when they are read, then they describe both checks, their trust models and the limit: the proof covers logged facts only, and writes with no ledger event (scripts, generators, unseen tools) are silent holes, while shell writes are logged but cannot be vetoed

## Functional Requirements

### Per-file TestRun results
- FR-001: At capture, each TestRun fact MUST record the set of test files in its structured report (JUnit or vitest JSON), each with a pass/fail result. A file fails when at least one of its testcases fails, and a file with only collection or import errors MUST be distinguishable from one with a failing testcase
- FR-002: The files recorded MUST come only from the structured report. The command string MUST NOT contribute to test identity
- FR-003: Ledger read-back MUST keep the existing count checks and MUST fail closed on per-file results that are malformed or inconsistent with the counts
- FR-004: TestRun facts without per-file results (legacy) MUST read without error, and MUST NOT satisfy any I6 step

### I6 obligation
- FR-005: I6 MUST be owed by exactly the non-claimant implementation Tasks whose frozen verification policy has `newTests: required`, in TaskGraphs populated after this feature. TaskGraphs populated earlier MUST NOT be newly obligated
- FR-006: I6 MUST be satisfied only when the epoch's ordered ledger shows (1) a trusted TestRun in which at least one testcase in one of the Task's test files fails, then (2) the first FileWrite to one of the Task's implementation files, then (3) a later trusted TestRun in which the Task's test files pass
- FR-007: A file-level collection or import error with no failing testcase MUST NOT count as red for step 1, except as FR-007a allows
- FR-007a: When the Task creates an implementation file, meaning a `file_list` implementation file that the Task-level artifact baseline records as missing, a collection or import error in a Task test file MUST count as red for step 1. Before the first write to a module the Task creates, a test that imports it can only fail to load, so that failure is the behavioral absence. A Task with no recorded baseline creates nothing for this purpose, and FR-007 applies unchanged
- FR-008: Only trusted ledger TestRuns (an exit code and a parsed structured report) MUST count for steps 1 and 3, on both harnesses and under every proof evaluation policy. Untrusted evidence MUST NOT count, even under the Pi structured-evidence policy. This includes Pi-structured transcript evidence, which is not a ledger fact
- FR-009: Each I6 failure MUST be a distinct proof failure that names which step is missing or out of order (red missing, red after the first implementation write, implementation write missing, green missing, no test files declared, or untrusted run only)
- FR-010: Claimant Tasks MUST NOT owe step 1. They MUST be credited red from the frozen acceptance red window
- FR-011: I6 MUST be decided at completion only. It MUST NOT block a stop, and MUST NOT veto any write
- FR-012: The I6 judgment MUST be a pure, deterministic function of the ordered ledger facts and the frozen Task data, computed at read time

### Test-file classification
- FR-013: A Task's test files MUST be its `file_list` entries that match the test-file pattern. Every other `file_list` entry (including fixtures, helpers and type files) MUST count as an implementation file
- FR-014: The test-file pattern MUST be the operator-declared manifest pattern when present, otherwise the engine's existing default test-suffix list, and it MUST be frozen at population

### Affected runner manifest entry
- FR-015: The manifest MUST accept an optional, operator-declared `affectedRunner` with the same `{files}` placeholder and form checks as `acceptanceRunner`
- FR-016: Population MUST freeze the affected runner and the test-file pattern into the TaskGraph, digest-checked like `acceptanceRunner`
- FR-017: The schema change MUST be additive. Schema-1 manifests and schema-2 manifests without the new keys MUST stay valid, and a missing `affectedRunner` MUST turn I7 off with a stated reason

### I7 affected-test stop check
- FR-018: At SubagentStop for every implementation Task, claimant or not, the system MUST run the frozen affected runner with `{files}` set to the Task's changed files
- FR-019: The changed files MUST be the epoch's ledger FileWrite paths, excluding files absent at stop time and using a renamed file's new path
- FR-020: When the affected run reports a failing test, the system MUST block the stop with a message naming each failing test and its file
- FR-021: With no changed files, the check MUST be skipped with a note. When the run reports zero tests, the check MUST pass with a note
- FR-022: The check MUST fail open, with a note naming the cause, on runner timeout (120 s), unreadable report, start failure, exhausted hook budget, or a reached block cap
- FR-023: The affected check MUST have its own per-agent block counter, capped at 3 like `ACCEPTANCE_STOP_CHECK_MAX_BLOCKS`, independent of the acceptance check's counter
- FR-024: The acceptance and affected runners MUST run in sequence under one lock, acceptance first, and when both block they MUST produce one combined block message
- FR-025: Both runs together MUST finish within the 300 s hook budget. Each runner MUST keep its 120 s limit
- FR-026: Affected-check data MUST NOT reach Task proof, receipts or gate evidence

### Planner and view
- FR-027: The shared stop-check planner MUST remain the single pure, total decision point for both checks, and the live hook and `helper stop-check-plan` MUST consume it
- FR-028: `helper stop-check-plan --task <id>` MUST render the affected plan next to the acceptance plan: changed files, expanded argv, cwd and report path, or exactly one off-reason (no runner frozen, no changed files, command could not be formed)
- FR-029: The helper MUST stay read-only and keep its existing refusals for an unknown Task id and a missing TaskGraph

### Pi ledger capture
- FR-031: Every Pi implementation child that holds a write grant MUST record ledger facts for its own tool calls: FileRead, FileWrite with `via`, and TestRun with per-file results. It MUST use the same minting rule as Claude Code's recorder, so the same tool call yields the same facts on both harnesses
- FR-032: A Pi child MUST record into the parent session's ledger, under an epoch derived from the parent-issued grant identity and the agent type. A child with no grant, or with a rejected grant, MUST record nothing and say so
- FR-033: A Pi TestRun's exit status MUST come only from the Pi tool result of that call. That is its exit code when the harness exposes one, and otherwise its error flag, read as 1 (error) or 0 (no error). Report discovery, freshness and the agent-authored-artifact veto MUST apply exactly as on Claude Code
- FR-034: On both harnesses, a literal `mv`, `git mv` or `cp` MUST mint a shell FileWrite for its destination path
- FR-035: Pi settlement (I6) and the Pi report-only stop check (I7) MUST read the child's epoch from that ledger

### Docs
- FR-030: The vault G4 section, the I6 and I7 notes, and the in-repo stop-check and proof-obligation docs MUST be updated, including I6's soundness limit stated where the obligation is defined

## Non-Functional Requirements

- NFR-001: Every new decision (per-file read-back, I6 judgment, test-file classification, affected planning) lives in the pure core. Effects (running runners, reading reports, taking the lock) stay in the hook shell
- NFR-002: Both harnesses (Claude Code and Pi) get the same I6 judgment and the same I7 plan from the same facts, and mint the same facts from the same tool calls

## Success Criteria

- SC-001: Across the I6 fixture set (every permutation of red, implementation write and green, plus non-behavioral red, untrusted-only runs, legacy facts and no test files), there are 0 false I6 passes, and each failing fixture reports the expected named step
- SC-002: On 100% of planner fixtures, the live SubagentStop hook and `helper stop-check-plan` produce identical acceptance and affected plans
- SC-003: In 100% of stop-check tests, including both runners at their 120 s timeouts, the SubagentStop hook finishes within 300 s
- SC-004: Existing schema-1 and schema-2 manifests and pre-feature ledgers in the test corpus produce 0 new read errors
- SC-005: An agent is blocked by each check at most 3 times per stop sequence (verified by test), and affected-check data appears in 0 proof, receipt or gate-evidence records
- SC-006: All 41 acceptance scenarios pass through the real hook, Pi extension and helper entry points at the final Wave Gate
- SC-007: On 100% of minting-matrix fixtures, Claude Code's recorder and the Pi recorder produce identical ledger facts

## Out of Scope

- OOS-001: I5 per-edit diagnostics and the repeat-tool loop-breaker
- OOS-002: I8 full deterministic suite at SubagentStop (typecheck, lint, architecture rules)
- OOS-003: The original I7 cadence rule ("a test run within the last N writes") and any PreToolUse advice or veto for it
- OOS-004: A PreToolUse veto on the first implementation write (I6 is checked at completion only)
- OOS-005: A declared source-to-test map, and any model-chosen or command-string-derived test identity
- OOS-006: Engine-owned red baseline runs at SubagentStart
- OOS-007: Closing the ledger soundness holes (full event coverage, HMAC or an out-of-reach ledger). They are documented as a limit only
- OOS-008: Changes to Wave Gate verification (`project:verify` stays its own authority)
- OOS-009: Crediting untrusted evidence toward I6. That means Pi-structured transcript evidence, or any TestRun without an exit code and a parsed structured report. Pi ledger facts minted under FR-031 count exactly like Claude Code's
- OOS-010: Retroactively obligating I6 in TaskGraphs populated before this feature
- OOS-011: Git-diff-derived changed files (the ledger is the only source)

## Dependencies

- G4 slice 1 Acceptance Stop Check (#90), the runner-cwd file fix (#91) and the stop-check plan helper (2026-10-14-stop-check-plan)
- The shared stop-check planner (#96)
- Structured test report capture and existing TestRun facts

## Appendix: Glossary

| Term | Definition |
|------|------------|
| I6 | Red-then-green proof obligation: the Task's test files are observed failing, then implementation is written, then they are observed passing |
| I7 | Affected-test stop check: at SubagentStop, run the affected runner over the Task's changed files and block while a test fails |
| Affected runner | The operator-declared manifest `affectedRunner`, frozen into the TaskGraph at population, whose `{files}` is set to the Task's changed files |
| Test-file pattern | The operator-declared pattern, or else the engine default test-suffix list, that classifies `file_list` entries as test files |
| Test file | A `file_list` entry that matches the test-file pattern |
| Implementation file | Any `file_list` entry that does not match the test-file pattern, including fixtures, helpers and type files |
| Changed files | The epoch's ledger FileWrite paths, excluding files absent at stop time, with renamed files under their new path |
| Trusted TestRun | A ledger TestRun fact, minted on either harness, with an exit code and a parsed structured report |
| Pi ledger recorder | The Pi child's tool-result hook that mints ledger facts through the shared minting rule into the parent session's ledger |
| Behavioral red | A trusted TestRun in which at least one testcase in a Task test file fails. A collection or import error alone counts only when the Task creates an implementation file (FR-007a) |
| Created implementation file | An implementation file the Task-level artifact baseline records as missing: a module the Task creates |
| Per-file result | The pass/fail result of one test file as recorded from the structured report at capture |
| Claimant | A Task whose policy is `covered-by-acceptance-contract`, credited red from the frozen acceptance red window |
| Fail open | On infrastructure failure or a reached cap, the stop check notes the cause and does not block |
| Soundness limit | I6 proves order over logged ledger facts only. Writes without a ledger event are not seen |

## Change Log

- 2026-10-16: initial spec from brainstorm (Approach A) and interview answers 1A–8A
- 2026-10-16: amended after architecture interview Q1, where the operator chose C (build the Pi ledger recorder in this slice). Added US8, FR-031 to FR-035, AS-036 to AS-041 and SC-007, and reworded FR-008, NFR-002, SC-006 and OOS-009
- 2026-10-20: amended after the slice 2 live pilot found that the I6 retry remedy could not be satisfied by a Task that creates a module. Its static import of the deleted module is a collection error, which FR-007 never counted as red. Added FR-007a and AS-042, narrowed AS-009 to Tasks that create no implementation file, and updated the glossary (ADR-0026 amendment, loom #115)
