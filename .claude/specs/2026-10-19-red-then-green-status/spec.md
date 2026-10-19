# Feature: Red-Then-Green Status — where a Task stands on I6

**Status:** Draft 2026-10-19. G4 slice 2 live pilot (`.claude/plans/2026-10-19-g4-slice-2-pilot.md`).

## Summary

G4 slice 2 added I6, the red-then-green proof obligation. A Task that owes it settles `implemented` only when its attempt epoch's ledger shows a qualifying failing run on one of its test files, then its first implementation write, then a qualifying passing run covering every test file. Settlement judges this and fails closed, but an operator sees only the result: `proof:red-then-green-unproven:<gap>` in a settlement line. Nothing says beforehand whether a Task owes I6 or which of its files count as tests, and nothing shows mid-attempt which step is met.

`helper red-then-green-status --task <id>` prints that. It is read-only and derives nothing of its own. The output covers:
- whether the Task owes I6, and why not when it doesn't;
- how settlement splits the Task's files into test and implementation files;
- for a live attempt, the judgment over the epoch so far;
- for a settled Task, the stored result.

## User Scenarios

### US1: [P1] Know whether a Task owes I6, and why not

**As an** operator running a Loom orchestration
**I want to** see whether a Task owes the red-then-green obligation
**So that** a refusal is never a surprise and an exemption is never a mystery

**Acceptance Scenarios:**
- AS-001: Given a TaskGraph whose frozen manifest carries a test-file classification, and a non-claimant Task whose new tests are required, when `red-then-green-status` renders that Task, then it states that the Task owes I6
- AS-002: Given an Acceptance Contract claimant, a Task whose new tests are waived, or a TaskGraph frozen before I6 existed, when the Task renders, then it states that the Task does not owe I6 and names exactly that one reason, including the waiver's reason when new tests are waived

### US2: [P1] See the test and implementation files exactly as settlement splits them

**As an** operator
**I want** the Task's files listed as test files and implementation files
**So that** I know which run counts as red or green and which write counts as the first implementation write

**Acceptance Scenarios:**
- AS-003: Given a Task that owes I6, when it renders, then its test files and implementation files are listed in `file_list` order, exactly as the frozen classification splits them; a Task whose `file_list` holds no test file states that it has none

### US3: [P1] See the live attempt's progress

**As an** operator watching a Wave
**I want to** see which I6 step a running attempt has met
**So that** I can tell before settlement whether it will be refused, and for which step

**Acceptance Scenarios:**
- AS-004: Given a Task with a live Claude Code attempt, when it renders, then the output shows settlement's judgment over that attempt's epoch so far: each met step with the ledger entry that met it, or the first unmet step named as settlement would name its gap
- AS-005: Given a Task with no live attempt, when it renders, then it states that there is no live attempt and shows no live judgment

### US4: [P2] See a settled Task's stored result

**As an** operator reviewing a Wave
**I want** a settled Task's stored I6 result
**So that** I can check what settlement recorded without reading the State File by hand

**Acceptance Scenarios:**
- AS-006: Given a Task settled `implemented` that owed I6, when it renders, then it shows the stored red-then-green evidence (the red run, the first implementation write and the green run); given a Task whose latest settlement failed I6, it shows the stored gap

### US5: [P2] Refuse bad input

**As an** operator
**I want** a clear refusal for a wrong Task id or a missing TaskGraph
**So that** I never mistake a typo for "not owed"

**Acceptance Scenarios:**
- AS-007: Given an unknown Task id, when `red-then-green-status` runs, then it refuses naming the id and exits non-zero; given no TaskGraph, it refuses naming the path it looked for and exits non-zero

## Functional Requirements

- FR-001: The system MUST state whether a Task owes I6. When it does not, it MUST name exactly one reason: the TaskGraph predates I6, the Task is an Acceptance Contract claimant, or its new tests are waived (with the waiver reason).
- FR-002: The system MUST list a Task's test files and implementation files as settlement classifies them under the TaskGraph's frozen test-file classification, in `file_list` order.
- FR-003: For a live Claude Code attempt, the system MUST show the red-then-green judgment of that attempt's epoch as settlement would compute it: each met step with its ledger reference, or the first unmet step's gap name.
- FR-004: For a settled Task, the system MUST show its stored red-then-green proof result: the evidence when satisfied, or the gap when its latest settlement failed I6.
- FR-005: Whether a Task owes I6, the file classification and the judgment MUST come from the engine's existing derivations (the I6 era, the test-file classifier, the red-then-green judge and the live-attempt evidence port). The feature MUST NOT re-derive any of them.
- FR-006: Rendering MUST be a pure function of its parsed inputs, total over every TaskGraph the State File parser admits. It MUST NOT throw or read the filesystem; all reads happen in the handler.
- FR-007: The helper MUST be read-only. It MUST NOT write the State File or take its lock. It MUST refuse an unknown Task id (naming it) and a missing TaskGraph (naming the path it looked for), each with a non-zero exit.

## Non-Functional Requirements

- NFR-001: The helper follows the existing read-only helper pattern, as `helper stop-check-plan` and `helper contract-status` do: a route in `KNOWN_HANDLERS.helper` only (not `WHITELISTED_HELPERS`), one handler, and a pure core module enrolled in the purity check.
- NFR-002: Pi live epochs are out of scope. On a harness whose live attempt cannot be observed, the output says the live attempt is not observable rather than guessing.

## Success Criteria

- SC-001: All seven acceptance scenarios pass through the real helper entry point by the final Wave Gate.
- SC-002: During the pilot, the helper's view of each Task agrees with settlement's stored result for that Task.

## Out of Scope

- OOS-001: Changing how I6 is judged or enforced.
- OOS-002: The I7 affected-test check and the acceptance check (`helper stop-check-plan` shows those).
- OOS-003: Machine-readable (JSON) output.
- OOS-004: Pi live attempts.

## Dependencies

- G4 slice 2: I6, the red-then-green obligation (#99), and the I6 era ADT (#100)
- `helper stop-check-plan`'s live-attempt evidence port (`claudeLiveAttemptEvidence`)

## Appendix: Glossary

| Term | Definition |
|------|------------|
| I6 | The red-then-green proof obligation: red on a Task test file, then the first implementation write, then green covering every Task test file, in one attempt epoch |
| Qualifying run | A ledger TestRun with an exit code and a parsed structured report that records per-file results |
| I6 era | Whether a TaskGraph owes I6 at all: owed when its frozen manifest carries a test-file classification |
| Gap | The first unmet I6 step, named as settlement names it (for example `red-missing`) |

## Change Log

- 2026-10-19: initial spec for the G4 slice 2 live pilot
