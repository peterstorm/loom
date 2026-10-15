# Feature: Stop-Check Plan — what the Acceptance Stop Check would do

**Status:** Draft 2026-10-14. G4 live pilot (`.claude/plans/2026-10-14-g4-stop-check-pilot.md`).

## Summary

G4 slice 1 runs the frozen acceptance runner at a claimant's SubagentStop and blocks the stop while an owed testcase is not passing. What a Task owes, which files the runner gets and the exact command line are derived at that moment and never shown in advance. `helper stop-check-plan --task <id>` prints them, read-only and without running anything, so an operator can tell before and during a Wave what the check will do at that Task's stop, or why it will do nothing.

## User Scenarios

### US1: [P1] See what a claimant owes at its stop

**As an** operator running a Loom orchestration with a frozen acceptance runner
**I want to** see, for one Task, the owed testcases, the files and the exact runner command
**So that** I can predict and explain any block before the agent stops

**Acceptance Scenarios:**
- AS-001: Given a Task that claims Requirements of a frozen contract due by its Wave, when `stop-check-plan` renders it, then every owed testcase is listed under its contract id, the acceptance files are listed, the runner argv holds each file (relative to the runner cwd) as one argument in place of `{files}`, and the report path is shown
- AS-002: Given a roster testcase with an anchor not due by the Task's Wave, when the Task renders, then that testcase is not listed

### US2: [P1] Know why the check is off

**As an** operator
**I want** a plain reason when the check would do nothing at this Task's stop
**So that** a silent stop is never a mystery

**Acceptance Scenarios:**
- AS-003: Given no frozen acceptance runner, or a Task that owes nothing (it claims nothing, its contract is not yet frozen, or its anchors are not yet due), or owed files the runner cannot be given (outside its cwd), when the Task renders, then it states that the check is off and names that reason

### US3: [P2] Refuse bad input

**As an** operator
**I want** a clear refusal for a wrong Task id or a missing TaskGraph
**So that** I never mistake a typo for "nothing owed"

**Acceptance Scenarios:**
- AS-004: Given an unknown Task id, when `stop-check-plan` runs, then it refuses naming the id and exits non-zero; given no TaskGraph, it refuses with the path it looked for

## Functional Requirements

- FR-001: The system MUST render, for a Task that owes testcases, each owing contract's id with its owed testcases (file and name), the distinct acceptance files, the runner argv after `{files}` expansion, the runner cwd and the report path
- FR-002: What is owed MUST come from `stopCheckExpectation` and the argv from `acceptanceRunnerCheck`; the feature MUST NOT re-derive either
- FR-003: When the check is off, the system MUST say so and name exactly one reason: no runner frozen; nothing owed; or the runner command could not be formed (with its refusal text)
- FR-004: Rendering MUST be a pure function of the parsed TaskGraph and the Task id, total over every graph the State File parser admits; it MUST NOT throw, read the filesystem or run the runner
- FR-005: The helper MUST be read-only: it MUST NOT write the State File or take its lock; it MUST refuse an unknown Task id naming it, and a missing TaskGraph with the path it looked for, each with a non-zero exit

## Non-Functional Requirements

- NFR-001: The helper follows the existing read-only helper pattern (route in `KNOWN_HANDLERS.helper` only, not `WHITELISTED_HELPERS`; one handler; a pure core module enrolled in the purity check), as `helper contract-status` does

## Success Criteria

- SC-001: All four acceptance scenarios pass through the real helper entry point at the final Wave Gate, with the contract's frozen bytes unchanged since its freeze

## Out of Scope

- OOS-001: Running the runner or showing a verdict (the stop check itself does that)
- OOS-002: The per-agent block counter and runner lock (agent-scoped, not TaskGraph state)
- OOS-003: Machine-readable (JSON) output

## Dependencies

- G4 slice 1 Acceptance Stop Check (#90) and the runner-cwd file fix (#91)
- G1 Acceptance Contracts (`engine/src/core/acceptance-contract/`)

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Acceptance Stop Check | The SubagentStop hook step that runs a claimant's owed acceptance testcases and blocks the stop while one is not passing |
| Owed testcase | A frozen-roster testcase the Task claims, every anchor of which is due by the Task's Wave |
| Acceptance runner | The manifest's schema-2 `acceptanceRunner`, frozen into the TaskGraph at population |

## Change Log

- 2026-10-14: initial spec for the G4 live pilot
