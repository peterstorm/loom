# Loom Pre-Implementation Flow Review

**Date:** 2026-02-06
**Scope:** Phases 0-4 (brainstorm → specify → clarify → architecture → decompose)
**Verdict:** Infrastructure solid, tighten inter-phase contracts

---

## What's Excellent

1. **WHAT/HOW separation is clean.** Brainstorm + specify + clarify handle *what to build*, architecture handles *how to build it*. Specify skill hard constraint ("NO tech stack mentions, NO API designs") prevents premature implementation decisions.

2. **Hook enforcement is production-grade.** `validate-phase-order.sh` maps agent types to phases, validates transitions via state machine (`init:brainstorm`, `brainstorm:specify`, etc.), AND checks artifact existence on disk. Catches unrecognized agent types during orchestration to prevent bypass.

3. **Spec template quality.** RFC 2119 MUST/SHOULD/MAY, Given/When/Then acceptance scenarios, measurable success criteria, explicit Out of Scope — anti-patterns section showing good vs bad examples especially useful for agent guidance.

4. **Clarify phase is smart.** Auto-triggered at >3 markers, auto-skipped at ≤3, scans for *implicit* ambiguities (vague adjectives, unbounded lists, passive voice), limits to 5 questions/session, separates technical uncertainties (routed to arch-lead) from business uncertainties.

5. **Decompose "impl includes tests" rule.** Prevents common deadlock where separate test-task depends on impl-task in same wave.

---

## Issues

### 1. Brainstorming skill conflicts with loom context

`brainstorming` SKILL.md says: "Write the validated design to `docs/plans/`" and "Use `/loom` for structured multi-phase implementation". When called FROM loom, agent shouldn't write design docs (architecture's job) or suggest `/loom` (already running). Agent.md partially overrides ("Do NOT write code. Do NOT create specifications.") but doesn't address doc writing or `/loom` suggestion.

**Fix:** Add loom-context override in `phase-brainstorm.md`:
```
IMPORTANT: You are running INSIDE /loom. Do NOT write design docs, do NOT suggest /loom, do NOT commit anything. Your output feeds into the specify phase.
```

### 2. Brainstorm → Specify handoff is weakest link

Every other inter-phase handoff passes file paths (artifacts on disk):
- Specify → Clarify: `{spec_file_path}` ✅
- Clarify → Architecture: `{spec_file_path}` ✅
- Architecture → Decompose: `{spec_file_path}` + `{plan_file_path}` ✅

Brainstorm → specify passes `{brainstorm_output}` — raw free-form text. Fragile.

**Fix:** Define structured output format for brainstorm:
```markdown
## BRAINSTORM SUMMARY
**Building:** [1-2 sentences]
**Approach:** [selected approach name]
**Constraints:** [bullet list]
**Out of scope:** [what was explicitly rejected]
```

### 3. Architecture skill is review-oriented, not design-oriented

`architecture-tech-lead` process starts with: "Identify Testability Barriers", "Locate side effects", "Find business logic coupled to infrastructure". Output format uses review language: "Issue: What makes this hard to test?", "Refactoring Recommendations".

For loom (especially greenfield features), need concrete implementation plan — file structure, data flow, component boundaries, API contracts. Skill CAN do this (description mentions "design a feature") but ordering/emphasis calibrated for code review, not design-from-spec.

**Fix:** `phase-architecture.md` template should override process with loom-specific instructions:
```markdown
**CONTEXT: Designing from spec, not reviewing existing code.**

Output MUST include:
- File structure (what files to create/modify)
- Component boundaries and responsibilities
- Data flow between components
- Key architectural decisions with rationale
- Implementation phases (ordered by dependency)
```

### 4. No user approval gate between brainstorm and specify

Phase 4 (Decompose) has explicit user approval (4c: "Proceed with this plan?"). Phases 0→1→2→3 auto-flow. `advance-phase.sh` advances state automatically when agents complete.

Brainstorm selects fundamental approach — if wrong, all downstream work wasted. One confirmation between brainstorm and specify could save significant rework.

**Fix:** Add checkpoint in SKILL.md Phase 0:
```
After brainstorm completes, present summary to user:
"Approach: [X]. Proceed to specification?"
```

### 5. Clarify threshold hardcoded in 4+ places

Number `3` in: SKILL.md (lines 49, 117-118, 124), specify SKILL.md (line 88), validate-phase-order.sh (line 117), advance-phase.sh (line 50).

**Fix:** Comment convention `# CLARIFY_THRESHOLD=3` at top of each file, or store in state file.

### 6. Architecture plan has no defined structure for decompose consumption

Decompose needs implementation phases, file lists, task assignments from plan. Architecture template says only "Key architectural decisions with rationale" — no concrete structure.

Compare: decompose template has precise JSON schema. Architecture output should be structured enough for decompose extraction.

**Fix:** Define expected plan sections:
```markdown
Plan MUST contain:
## File Structure
## Implementation Phases (ordered)
## Architectural Decisions
## Component Boundaries
```

---

## Summary

| Area | Verdict |
|------|---------|
| Phase flow design | ✅ Excellent |
| Hook enforcement | ✅ Production-grade |
| Spec template | ✅ Excellent |
| Clarify heuristic | ✅ Smart |
| Brainstorm ↔ loom context | ⚠️ Conflicting instructions |
| Brainstorm → specify handoff | ⚠️ Free-form, fragile |
| Architecture skill orientation | ⚠️ Review-focused, not design-focused |
| User confirmation gates | ⚠️ Missing between brainstorm/specify |
| Architecture → decompose contract | ⚠️ Plan structure undefined |
| Clarify threshold DRY | 💡 Minor nit |

**Theme:** Tighten contracts between phases — structured outputs, loom-context overrides, one more user checkpoint. Fixes are all template-level; underlying infrastructure (hooks, state machine, agents) is solid.
