# PR Remediation Plan — Round 8

**Date:** 2026-07-18
**Branch:** feat/architecture-panel-mode-plan
**Findings:** 0 critical, 9 advisory (all six reviewers found zero critical)

Six review agents (code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-agent) all reported
CRITICAL_COUNT: 0. Remediating the actionable drift seams (A–E) per user
selection; F–I are design trade-offs the reviewers explicitly did not recommend
changing.

## Critical Fixes

None.

## Advisory Fixes (selected: A–E)

### Fix A: architecture-agent.md description omits panel-finalize exception
- **Source:** comment-analyzer
- **File:** agents/architecture-agent.md:3
- **Issue:** Frontmatter `description` says "Runs a full interview" unconditionally,
  but in `--panel` finalize mode the agent skips the interview. Description-vs-behavior drift.
- **Fix:** Append a brief qualifier noting the panel-finalize exception.

### Fix B: frozenSet runtime-mutation throw untested
- **Source:** pr-test-analyzer
- **File:** engine/src/config.ts:72-81 (frozenSet) / engine/tests/panel-config.test.ts
- **Issue:** No test asserts `ARCH_PANEL_AGENTS.add(...)` throws — the defensive
  immutability guard is unverified.
- **Fix:** Add a test asserting `.add`/`.delete`/`.clear` throw.

### Fix C: Object.isFrozen(PHASE_AGENT_MAP) not asserted
- **Source:** pr-test-analyzer
- **File:** engine/src/config.ts:58 (PHASE_AGENT_MAP) / engine/tests/panel-config.test.ts
- **Issue:** The freeze is relied on in doc comments but not pinned by a test; a
  refactor dropping `Object.freeze` would go unnoticed.
- **Fix:** Add `expect(Object.isFrozen(PHASE_AGENT_MAP)).toBe(true)`.

### Fix D: loom.md literal counts not pinned to config constants
- **Source:** architecture-agent
- **File:** commands/loom.md:44,213,232 / engine/tests/panel-config.test.ts
- **Issue:** Lens cap "(5)" and counts "currently 3" are hardcoded prose literals;
  panel-config.test.ts pins the constants against panel-lenses.md but nothing pins
  the loom.md literals against the constants → silent stale drift.
- **Fix:** Add a test that regex-extracts the loom.md literals and asserts each equals
  the corresponding config constant (fails loudly if prose reworded or count drifts).

### Fix E: digest-label prose↔prose contract untested
- **Source:** architecture-agent
- **File:** agents/arch-interviewer-agent.md (producer) ↔ commands/loom.md Step 2 (consumer)
- **Issue:** Lens/judge selection regex-reads four exact labels the interviewer writes
  (`**Primary axis:**`, `**Testability bar:**`, `**Sensitive boundaries:**`,
  `**Codebase maturity:**`) with no shared source and no test; a rename on either side
  silently degrades selection to the fallback with no failure signal.
- **Fix:** Add a test asserting all four labels appear in BOTH markdown files.

## Deferred (not selected — design trade-offs)

- **F** derivePanelPhase throw branch not test-reachable — minor refactor to already-correct code.
- **G** clampPanelDesigners enforced only in prose/tests — inherent to loom's engine-gates/LLM-spawns design.
- **H** AgentRole union variants structurally identical — reviewer said "flag only if payloads diverge."
- **I** test-only exports widen public surface — cosmetic.

## Validation Commands
```bash
cd engine && bunx tsc --noEmit
cd engine && bun test 2>&1 | tail -30
bash scripts/smoke-panel-mode.sh
```
