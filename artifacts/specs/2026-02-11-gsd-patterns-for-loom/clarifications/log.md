# Clarification Log

## 2026-02-11: Pre-Resolved Decisions Applied

All clarifications resolved via pre-provided user decisions. No interactive Q&A session needed.

### Decision 1: Plan Validation Implementation

**Question:** PreToolUse hook before execute vs helper called by orchestrator after decompose?
**Answer:** Helper function called by orchestrator after decompose
**Updated:** NFR-011
**Rationale:** Simpler integration, no new hook type needed. Orchestrator has natural checkpoint after decompose to validate before transitioning to execute.

### Decision 2: Deviation Rule 4 Enforcement

**Question:** Hook-based escalation when Rule 4 detected vs prompt-only guidance?
**Answer:** Prompt-only guidance in impl-agent-context.md template
**Updated:** US4 (acceptance scenario), FR-024
**Rationale:** Start lightweight with prompt-based rules. Can promote to hook enforcement later if agents consistently ignore guidance. Avoids premature enforcement complexity.

### Decision 3: Research Agent Synthesis

**Question:** Orchestrator merges outputs into brainstorm.md or agents write to shared directory?
**Answer:** Brainstorm agent spawns its own 3 research sub-tasks internally via Task tool. No separate files — agent reads Task results and synthesizes in-context before writing brainstorm.md.
**Updated:** FR-001, NFR-020
**Rationale:** Simplest orchestration — brainstorm agent owns the entire research+synthesis flow. No intermediate files, no file coordination. Nested agents (Task-in-Task) don't trigger loom hooks since they're utility agents inside a phase agent. Decision revised from original "file-based handoff" after discovering hook limitations during pre-execute phases.

### Decision 4: Archive Directory Structure

**Question:** Flat (.claude/archive/{slug}/) vs nested (.claude/archive/2026-02/{slug}/)?
**Answer:** Flat: .claude/archive/{slug}/ containing both spec/ subdirectory and plan.md
**Updated:** US5 (acceptance scenario), FR-030, FR-031
**Rationale:** Simpler navigation, slug already contains date prefix. No need for nested date hierarchy.

### Decision 5: Task Specificity Threshold

**Question:** Exact criteria for "vague" task description (word count threshold, keyword requirement, file target presence)?
**Answer:** Task description MUST contain action verb AND at least one file target
**Updated:** US3 (acceptance scenario), FR-016
**Rationale:** Structural check more robust than word count. Action verb ensures intent clarity ("update X", "add Y"). File target ensures concrete scope, not abstract goal.

### Decision 6: Vague Task Description Threshold

**Question:** Minimum description length or required structural elements?
**Answer:** Same as Decision 5 (merged duplicate question)
**Updated:** Open Questions section
**Rationale:** Questions 5 and 6 asked same thing with different wording. Unified into single structural requirement: action verb + file target.

---

## Coverage Summary

| Category | Status |
|----------|--------|
| Functional scope | Resolved |
| Data model | Resolved |
| UX flows | Resolved |
| Performance | Clear |
| Integration | Resolved |
| Edge cases | Clear |
| Constraints | Resolved |
| Terminology | Clear |
| Completion | Clear |

**Remaining markers:** 0
**Ready for architecture:** Yes
