# Feature: Contract Status — an operator view of Acceptance Contracts

**Status:** Draft 2026-10-14. G1 live pilot (`.claude/plans/2026-10-14-g1-live-pilot.md`).

## Summary

G1 persists Acceptance Contracts in the TaskGraph: each contract's freeze state, the roster of testcases observed RED, and its revisions. An operator can see none of this without reading raw State File JSON. `helper contract-status` prints that state, read-only, so an operator can tell during a run what each contract has frozen, which Requirement is due in which Wave, and whether a Contract Revision has happened.

## User Scenarios

### US1: [P1] See every contract's freeze state

**As an** operator running a Loom orchestration with contracts
**I want to** see each contract's freeze state and its contract Task
**So that** I know whether its RED was observed and in which Wave the freeze was stamped

**Acceptance Scenarios:**
- AS-001: Given a TaskGraph with a contract awaiting RED and a contract frozen at Wave N, when `contract-status` renders it, then each contract shows its id, title and contract Task, the first reads as awaiting RED, and the second names Wave N

### US2: [P1] See the roster and when each Requirement is due

**As an** operator
**I want to** see the frozen roster and each covered Requirement's due Wave
**So that** I know which acceptance testcase must turn GREEN at which Wave Gate

**Acceptance Scenarios:**
- AS-002: Given a frozen contract, when it renders, then every roster testcase is listed with its anchors, and each covered anchor shows the Wave of the Task that completes it (or "unclaimed" when no Task claims it)

### US3: [P2] See revisions, and get a clear answer when there is nothing to show

**As an** operator
**I want to** see a contract's revision count, and a plain answer when there are no contracts or no TaskGraph
**So that** I can tell that a Contract Revision happened, and I'm never shown an empty screen or a stack trace

**Acceptance Scenarios:**
- AS-003: Given a contract with recorded Contract Revisions, when it renders, then it shows the freeze state as revised and the number of revisions
- AS-004: Given a TaskGraph without contracts, when `contract-status` runs, then it prints "no Acceptance Contracts" and exits successfully; given no TaskGraph, it refuses with the path it looked for

## Functional Requirements

- FR-001: The system MUST render, for each Acceptance Contract in TaskGraph order, its id, title, contract Task and freeze state; a frozen state names its Wave
- FR-002: The system MUST render each frozen roster testcase with its anchors, and each covered anchor with its due Wave derived from the Task roster (the latest Wave of a Task that claims it), or "unclaimed"
- FR-003: The system MUST render a revised contract's revision count
- FR-004: Rendering MUST be a pure function of the parsed TaskGraph, total over every graph the State File parser admits; it MUST NOT throw and MUST NOT read the filesystem
- FR-005: The helper MUST be read-only: it MUST NOT write the State File or take its lock, and it MUST refuse a missing TaskGraph with the path it looked for
- FR-006: A TaskGraph without contracts MUST render the single line "no Acceptance Contracts" and succeed

## Non-Functional Requirements

- NFR-001: The helper follows the existing whitelisted-helper pattern (route in `handler-routes.ts`, one handler, a pure core module enrolled in the purity check)

## Success Criteria

- SC-001: All four acceptance scenarios pass through the real helper entry point at the final Wave Gate, with the contract's frozen bytes unchanged since its freeze

## Out of Scope

- OOS-001: Editing contracts or recording revisions (that is `helper revise-contract`)
- OOS-002: Showing per-testcase pass/fail from the latest report (receipts already hold it)
- OOS-003: Machine-readable (JSON) output

## Dependencies

- G1 Acceptance Contracts (`engine/src/core/acceptance-contract/`), merged in #84/#85

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Acceptance Contract | A plan's `CT-N` block: frozen types and acceptance tests observed RED, then GREEN by Requirement |
| Freeze state | A contract's `awaiting-red`, `frozen` (with its Wave) or `revised` state in the TaskGraph |
| Due Wave | The latest Wave of a Task that claims a covered Requirement; the Wave Gate from which its testcases must pass |
| Contract Revision | An operator-recorded change to a contract's frozen bytes (`helper revise-contract`) |

## Change Log

- 2026-10-14: initial spec for the G1 live pilot
