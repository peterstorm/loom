# Feature: GSD Patterns for Loom Orchestration

**Spec ID:** 2026-02-11-gsd-patterns-for-loom
**Created:** 2026-02-11
**Status:** Draft
**Owner:** peterstorm

## Summary

Enhance loom orchestration system with four high-value patterns from the GSD (Get Shit Done) framework: decision-locking in brainstorm, parallel research agents, plan validation, and deviation logging. These patterns address weak handoffs between phases, improve plan quality, and provide structured autonomy during execution while maintaining loom's hook-based enforcement architecture.

---

## User Scenarios

### US1: [P1] Decision-Locked Brainstorming

**As a** loom user
**I want** ambiguous feature decisions identified and locked before specification
**So that** architects and implementers work from concrete requirements, not assumptions

**Why P1:** Brainstorm→specify handoff identified as weakest link in loom review. Blocks quality specs.

**Acceptance Scenarios:**
- Given feature with scope ambiguity, When brainstorm completes, Then brainstorm.md contains decision-locking section with locked/discretion/deferred buckets
- Given feature with naming convention choice, When brainstorm completes, Then specific choice captured as locked decision
- Given out-of-scope suggestion during brainstorming, When captured, Then marked as deferred idea, not rejected
- Given brainstorm without ambiguity, When simple feature detected, Then decision-locking skipped, proceed to specify

### US2: [P1] Parallel Research Agents

**As a** loom user
**I want** three specialized research agents exploring codebase, risks, and external resources during brainstorm
**So that** brainstorm captures comprehensive context without sequential exploration delays

**Why P1:** Single-agent brainstorm misses context; parallel exploration proven in GSD, fits Task tool spawning pattern.

**Acceptance Scenarios:**
- Given brainstorm phase start, When orchestrator spawns agents, Then exactly 3 agents execute in parallel (single message, multiple Task calls)
- Given 3 research outputs complete, When brainstorm synthesizes, Then all findings integrated into brainstorm.md
- Given codebase explorer agent, When searching conventions, Then relevant patterns and existing implementations documented
- Given risk analyst agent, When identifying pitfalls, Then potential blockers and edge cases surfaced

### US3: [P1] Plan Validation Before Execute

**As a** loom user
**I want** decompose output validated for requirement coverage and dependency correctness before execution
**So that** invalid plans fail fast, not after wasting time on flawed task graphs

**Why P1:** Current validation only checks JSON schema, not whether plan achieves spec requirements.

**Acceptance Scenarios:**
- Given decompose output with missing spec anchor coverage, When validation runs, Then blocker-level finding with uncovered requirements listed
- Given task graph with dependency cycle, When validation runs, Then blocker-level finding with cycle path identified
- Given valid plan with all requirements covered, When validation runs, Then PASSED verdict, proceed to execute
- Given plan with vague task descriptions, When validation runs, Then warning-level finding for specificity (task description MUST contain action verb AND at least one file target)

### US4: [P1] Deviation Logging During Execution

**As a** implementation agent
**I want** structured rules for handling unexpected situations
**So that** I can auto-fix bugs without permission but escalate structural changes

**Why P1:** Impl agents currently binary (succeed/fail), no graduated autonomy or deviation tracking.

**Acceptance Scenarios:**
- Given impl agent encounters missing import, When auto-fixing, Then deviation logged as Rule 3 (blocking issue), task succeeds
- Given impl agent needs to refactor existing code structure, When detecting Rule 4 trigger, Then agent includes escalation proposal in task output (prompt-only guidance in impl-agent-context.md, NOT hook-enforced)
- Given task completion with deviations, When SubagentStop fires, Then deviations extracted from transcript and stored in task state
- Given impl agent fixing test failure, When auto-correcting, Then deviation logged as Rule 1 (code doesn't work), task succeeds

### US5: [P2] Archive on Complete

**As a** loom user
**I want** specs and plans moved to .claude/archive/ when workflow completes
**So that** .claude/specs/ and .claude/plans/ contain only active work

**Why P2:** Organizational clarity; prevents clutter but not critical to workflow correctness.

**Acceptance Scenarios:**
- Given completed loom workflow, When /loom --complete invoked, Then spec dir and plan file moved to .claude/archive/{slug}/
- Given archived artifacts, When searching active specs, Then completed work excluded from search results
- Given archive directory structure, When multiple features archived, Then flat structure .claude/archive/{slug}/ containing both spec/ subdirectory and plan.md

---

## Functional Requirements

### Brainstorm Enhancement

- FR-001: Brainstorm agent MUST spawn 3 parallel research sub-tasks via Task tool (single message, multiple calls): codebase explorer (Explore agent), external researcher (general-purpose with web search), risk/pitfall analyst (general-purpose). Brainstorm agent synthesizes results in-context.
- FR-002: Brainstorm phase MUST include decision-locking step that outputs locked decisions, discretion areas, and deferred ideas
- FR-003: Locked decisions MUST be marked as binding for downstream phases (specify, architecture, decompose)
- FR-004: Decision-locking step MAY be skipped for simple features with no detected ambiguity

### Plan Validation

- FR-010: System MUST validate decompose output before execute phase for requirement coverage
- FR-011: Plan validation MUST check every spec anchor (FR-xxx, SC-xxx, US.acceptance) mapped to at least one task
- FR-012: Plan validation MUST detect dependency cycles in task graph
- FR-013: Plan validation MUST verify no file ownership overlap between parallel tasks in same wave
- FR-014: Plan validation MUST output blocker/warning/info severity levels
- FR-015: System MUST block execute phase if plan validation returns blocker-level findings
- FR-016: System SHOULD warn for task descriptions that lack BOTH an action verb AND at least one file target

### Deviation Logging

- FR-020: Impl agent context template MUST include 4-rule deviation framework (auto-fix bugs, add critical functionality, fix blockers, escalate structural changes)
- FR-021: Task state MUST include `deviations` field for storing deviation log entries
- FR-022: SubagentStop handler MUST extract deviation entries from impl agent transcripts
- FR-023: Deviation log entry MUST capture rule number, description, and outcome
- FR-024: Impl agent MUST include escalation proposal in task output when Rule 4 (structural change) detected, enforced via prompt-only guidance in impl-agent-context.md template

### Archive on Complete

- FR-030: /loom --complete MUST move spec directory from .claude/specs/{slug}/ to .claude/archive/{slug}/spec/
- FR-031: /loom --complete MUST move plan file from .claude/plans/{slug}.md to .claude/archive/{slug}/plan.md
- FR-032: Archive operation MUST preserve all files in spec directory (spec.md, brainstorm.md, clarifications/)
- FR-033: Archive operation MUST NOT modify GitHub issue or state file references

---

## Non-Functional Requirements

### Performance

- NFR-001: Parallel research agents MUST complete within 3x single-agent baseline (parallelism benefit)
- NFR-002: Plan validation MUST complete in <5 seconds for task graphs with up to 12 tasks

### Compatibility

- NFR-010: Brainstorm enhancement MUST preserve existing hook architecture (TypeScript handlers, StateManager, chmod 444)
- NFR-011: Plan validation MUST integrate as helper function called by orchestrator after decompose phase, not as PreToolUse hook or new PHASE_ORDER entry
- NFR-012: Deviation logging MUST use existing SubagentStop handler pattern (update-task-status.ts)

### Maintainability

- NFR-020: Brainstorm agent MUST spawn its own 3 research sub-tasks internally (via Task tool) and synthesize results in-context before writing brainstorm.md. No separate research artifact files required.
- NFR-021: Deviation rules MUST be documented in impl-agent-context.md template with examples

---

## Success Criteria

- SC-001: 100% of brainstorm runs with detected ambiguity produce decision-locking section with at least 1 locked decision
- SC-002: Parallel research agents reduce brainstorm wall-clock time by >=40% compared to sequential exploration baseline
- SC-003: Plan validation catches 100% of task graphs with uncovered spec anchors before execute phase
- SC-004: Plan validation catches 100% of dependency cycles before execute phase
- SC-005: 90% of impl agent deviation scenarios correctly categorized by rule number (measured via manual review of 20 test cases)
- SC-006: Archive operation preserves 100% of spec and plan files without data loss
- SC-007: Zero regressions in existing loom workflow (all current hooks remain functional)

**Measurement approach:**
- SC-001, SC-003, SC-004: Unit tests with fixture task graphs and specs
- SC-002: Benchmark comparison (5 real features, before/after timings)
- SC-005: Test suite with 20 deviation scenarios (bug fix, missing dep, structural change, etc.)
- SC-006: Integration test with file verification
- SC-007: Full loom test suite (existing + new tests)

---

## Out of Scope

Explicitly NOT part of this feature:

- Phase 1 quick wins from GSD analysis (quick mode, atomic commit check, task specificity requirement)
- Phase 3 polish (checkpoints, metrics, model profiles, compressed summaries)
- Goal-backward verification / anti-stub detection / substance checks in wave gate
- Separate discuss-agent or discuss phase (merged into enhanced brainstorm)
- 4-agent GSD-style research (using 3 instead as per brainstorm decision)
- Plan validation as new phase (must be helper or hook, not new PHASE_ORDER entry)
- Modification of existing phase agents (specify, clarify, architecture remain unchanged)

---

## Open Questions

**All questions resolved:**

1. **Plan validation implementation** → Helper function called by orchestrator after decompose (not PreToolUse hook)
2. **Deviation Rule 4 enforcement** → Prompt-only guidance in impl-agent-context.md, NOT hook-enforced
3. **Research agent synthesis** → Agents write separate files (research-{codebase,external,risks}.md), orchestrator synthesizes into final brainstorm.md
4. **Archive structure** → Flat: .claude/archive/{slug}/ containing spec/ subdirectory and plan.md
5. **Task specificity threshold** → Task description MUST contain action verb AND at least one file target
6. **Vague task description** → Same as #5 (merged duplicate question)

---

## Dependencies

External factors this feature depends on:

- Existing loom hook system (TypeScript handlers in .claude/hooks/loom/)
- StateManager class for atomic state writes
- Task tool spawning mechanism (single message, multiple calls)
- Existing phase templates (brainstorm, impl-agent-context)
- SubagentStop transcript parsing infrastructure (parseTranscript, parseFilesModified)
- bun runtime for TypeScript hook execution

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Parallel research agents increase API cost 3x per brainstorm | Medium | Measured benefit (40% time reduction) justifies cost; can add --skip-research flag if needed |
| Decision-locking adds complexity to brainstorm, may confuse users | Medium | Clear template examples, optional skip for simple features |
| Plan validation false positives block valid plans | High | Severity levels (blocker/warning/info), user can override warnings |
| Deviation logging extraction fragile if transcript format changes | Medium | Test suite with diverse transcript fixtures, fallback to empty deviations if parse fails |
| Archive operation could lose data if file move fails mid-operation | High | Atomic operation (copy then verify then delete), rollback on failure |
| Integration with existing hooks may break current functionality | High | Comprehensive regression test suite before merge |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Decision-locking | Explicit capture of ambiguous choices during brainstorming into locked/discretion/deferred buckets, binding for downstream phases |
| Deviation | Departure from plan during impl agent execution, categorized by 4-rule framework (auto-fix vs escalate) |
| Plan validation | Pre-execution verification that task graph achieves spec requirements and has correct dependency structure |
| Spec anchor | Requirement identifier (FR-xxx, SC-xxx, US.acceptance) that tasks must map to for traceability |
| Wave gate | Checkpoint after wave completion verifying tests passed, reviews complete, no critical findings |
| Research synthesis | Combining outputs from parallel research agents into unified brainstorm artifact |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-02-11 | Initial draft from brainstorm | specify-agent |
