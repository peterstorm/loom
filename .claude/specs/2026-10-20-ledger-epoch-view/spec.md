# Feature: Ledger Epoch View — what one attempt's ledger recorded

**Status:** Draft 2026-10-20. Vehicle for the G4 slice 2 re-pilot (`.claude/plans/2026-10-20-g4-slice-2-repilot.md`).

## Summary

I6 settlement judges an implementation attempt from its ledger epoch, the evidence facts the attempt's agent recorded. Its proof evidence cites entries by position, for example red `#3`, the first implementation write at `#4` and green `#5`. Nothing shows those entries. Operators and pilots have read `<session>.evidence.jsonl` by hand with `jq`, filtering by epoch and dropping duplicate deliveries themselves. A mistake there quietly shifts every position.

`bun scripts/ledger-epoch.ts` prints one epoch's facts, numbered exactly as settlement numbers them. It can also list a session's epochs. It is read-only and derives nothing of its own.

## User Scenarios

### US1: [P1] Read one attempt's facts, numbered as settlement cites them

**As an** operator checking an I6 settlement
**I want** an attempt's ledger facts listed with the positions settlement uses
**So that** I can check `red #3, write #4, green #5` against what actually happened

**Acceptance Scenarios:**
- AS-001: Given a session ledger with facts from several epochs, including a duplicate delivery of one fact, when the view renders one agent's epoch, then it lists exactly that epoch's facts, in ledger order, with the duplicate dropped, and each fact's position equals the position settlement's red-then-green evidence would cite for it
- AS-002: Given an epoch's facts, when the view renders them, then:
  - a file write shows its path and whether it came from a file tool or the shell;
  - a file read shows its path;
  - a test run shows its command, its exit code (or that none was recorded) and its report summary: total and failed counts, then each file's executed, failed and skipped counts and any collection error. A run with no structured report says so.

### US2: [P2] Find the epoch to read

**As an** operator who knows the session but not the agent id
**I want** the session's epochs listed
**So that** I can pick the attempt to read

**Acceptance Scenarios:**
- AS-003: Given a session ledger, when the view runs without an agent, then it lists every epoch in first-appearance order with its number of facts (duplicates dropped)

### US3: [P2] Refuse bad input

**As an** operator
**I want** a clear refusal for a wrong session, a damaged ledger or a missing argument
**So that** I never mistake a typo for "the agent recorded nothing"

**Acceptance Scenarios:**
- AS-004: Given a session with no ledger file, when the view runs, then it refuses naming the path it looked for, and exits non-zero; given a ledger with an unparseable line, it refuses naming that line, and exits non-zero
- AS-005: Given an agent whose epoch holds no facts, when the view renders it, then it states that the epoch is empty, which is not a refusal; given a missing or malformed argument, it prints its usage and exits non-zero

## Functional Requirements

- FR-001: The system MUST list one epoch's facts in ledger order, with duplicate deliveries dropped, using exactly the engine's own epoch derivation (`eventsForEpoch`). Each fact's position MUST be the position settlement's I6 evidence cites.
- FR-002: The system MUST render every evidence kind: a file write (path and source: tool or shell), a file read (path), and a test run (command, exit code or "none recorded", and the report summary with per-file executed, failed and skipped counts and collection errors, or "no structured report").
- FR-003: Without an agent, the system MUST list the session's epochs in first-appearance order, each with its fact count after duplicates are dropped.
- FR-004: The system MUST refuse a session with no ledger (naming the path), a ledger with an unparseable line (naming the line), and missing or malformed arguments (printing usage). Each refusal exits non-zero. An empty epoch is stated, not refused.
- FR-005: Rendering MUST be a pure function of the parsed records, total over every record the ledger parser admits. All reads happen in the script.
- FR-006: The script MUST be read-only. It MUST NOT write or truncate the ledger or any other file.

## Non-Functional Requirements

- NFR-001: The pure renderer lives in `engine/src/core/` and is enrolled in the purity check. The script lives in `scripts/` beside the other operator scripts and is typechecked with the engine.
- NFR-002: The ledger location follows the engine's own (`LOOM_SUBAGENT_DIR`, or its default); the script never assumes a path.

## Success Criteria

- SC-001: All five acceptance scenarios pass through the real script entry point by the final Wave Gate.
- SC-002: During the re-pilot, the view's positions for each settled Task agree with that Task's stored red-then-green evidence.

## Out of Scope

- OOS-001: Judging I6. `helper red-then-green-status` shows the judgment; this view shows only the facts.
- OOS-002: Pi children's epochs, which live under grant epochs in the parent ledger.
- OOS-003: Machine-readable (JSON) output.

## Dependencies

- The evidence ledger and `eventsForEpoch` (`engine/src/machine`)
- I6 red-then-green settlement (#99) and its evidence positions

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Epoch | One agent's slice of a session's evidence ledger, keyed by `<agentId>:<agentType>` |
| Fact | One evidence event: a file write, a file read or a test run |
| Position | A fact's 0-based place in its epoch after duplicates are dropped; I6 evidence cites facts by it |
| Duplicate delivery | The same fact recorded twice under one tool-call id, which `eventsForEpoch` drops |

## Change Log

- 2026-10-20: initial spec for the G4 slice 2 re-pilot
