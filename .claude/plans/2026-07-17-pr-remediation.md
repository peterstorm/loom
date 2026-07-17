# PR Remediation Plan

**Date:** 2026-07-17
**Branch:** feat/architecture-panel-mode-plan
**Findings:** 1 critical, 5 advisory (1 deferred)

Six review agents ran over the architecture-panel-mode branch (19 files, 1400 insertions).
code-reviewer reported clean. The one critical was flagged independently by two agents
(type-design as CRITICAL, architecture as advisory) — high-confidence convergence.

## Critical Fixes

### Fix 1: Enforce the panel/phase disjointness invariant at runtime
- **Source:** type-design-analyzer (CRITICAL), architecture-agent (advisory — converged)
- **File:** engine/src/config.ts:36
- **Issue:** The load-bearing safety property of the whole feature —
  `ARCH_PANEL_AGENTS ∩ keys(PHASE_AGENT_MAP) = ∅` — is enforced ONLY by the vitest
  suite. A future edit that puts a panel agent into `PHASE_AGENT_MAP` compiles and runs;
  its `SubagentStop` would then fire `resolveTransition` and the date-prefix plan fallback
  could advance the phase mid-panel (the exact hazard the feature exists to prevent).
  A CI-only guard is a trap, not an impossibility.
- **Fix:** Add an exported pure predicate `panelPhaseOverlap()` returning the intersection,
  and a module-load-time guard that throws if it is non-empty. Converts a CI-only failure
  into a load-time impossibility (runs on every handler import). Add a unit test that the
  predicate detects a synthetic overlap (proving the guard is live, not tautological).

## Advisory Fixes

### Fix 2: Split two statements sharing one line at the panel-critical lookup
- **Source:** type-design-analyzer
- **File:** engine/src/core/validate-phase-order.ts:48
- **Fix:** Put each `if` on its own line. Pure readability on the exact lookup the panel
  invariant depends on.

### Fix 3: De-duplicate residual-placeholder detection
- **Source:** pr-test-analyzer
- **File:** engine/src/core/validate-template-substitution.ts, engine/tests/panel-templates.test.ts:63
- **Issue:** The test re-implements the gate's residual-placeholder regex + false-positive
  set. If the real gate's regex changes, the test's "mirrors validate-template-substitution
  exactly" claim silently becomes false.
- **Fix:** Export `findResidualPlaceholders(prompt)` from the core module; consume it in
  both `validateTemplateSubstitution` and the test. Behavior-preserving (same regex/set).

### Fix 4: Stop the smoke script masking crashes as PASS
- **Source:** silent-failure-hunter (x3)
- **File:** scripts/smoke-panel-mode.sh:71,82,114
- **Issue:** `run_gate` discards stderr and asserts only the numeric exit code, so a
  fail-closed crash (exit 2) is indistinguishable from a correct BLOCK; `run_stop` swallows
  every dispatch failure via `|| true`; `phase_now` greps raw JSON, coupling the test to an
  incidental serialization format.
- **Fix:** Assert the block message content (grep `Invalid phase transition`) on the
  block-expecting case; capture and check the dispatch exit code in `run_stop`; parse phase
  with `jq -r .current_phase`.

### Fix 5: Clamp / document the `--panel=N` lens cap
- **Source:** architecture-agent + comment-analyzer (converged)
- **File:** commands/loom.md (Phase 3), references/panel-lenses.md
- **Issue:** Only five lenses exist; `--panel=N` with N>5 has no defined lens assignment,
  and the effective cap is documented nowhere.
- **Fix:** Note in the orchestration prose that N is capped at the number of distinct lenses
  (5), and add one line to panel-lenses.md.

### Fix 6: Documentation consistency
- **Source:** comment-analyzer
- **File:** .claude/plans/2026-07-16-architecture-panel-mode.md, commands/loom.md:44
- **Fix:** Switch plan-doc prose `candidate-{lens}.md` → `candidate-<lens>.md` (its own
  authoring rule mandates angle brackets); soften `loom.md:44` "currently 3" to rely on the
  `PANEL_DESIGNERS_DEFAULT` symbol reference (drift point).

## Deferred

### Introduce an `AgentRole` discriminated-union ADT
- **Source:** type-design-analyzer (advisory)
- **Reason:** A genuine design improvement (centralize the scattered `.has()`/map-probe
  agent classification behind one `classifyAgent(): AgentRole` so "in both maps" becomes
  structurally impossible), but a cross-cutting refactor touching ~5 handler files. It is a
  design change, not a bug, and Fix 1's runtime guard closes the actual safety gap this
  branch introduces. Out of scope for minimal PR remediation.
- **Recommendation:** Track as a follow-up architecture task (`/loom:deepen`).

## Validation Commands
```bash
cd engine && bun test 2>&1 | tail -20
./scripts/smoke-panel-mode.sh
```
