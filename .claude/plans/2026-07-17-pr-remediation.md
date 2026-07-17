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

---

# Round 2 — post-remediation re-review

**Findings:** 1 critical, 6 advisory fixed (0 deferred)

Six review agents re-ran over the branch (21 files, 1557 insertions). code-reviewer reported
clean again. The single critical came from silent-failure-hunter and was verified by tracing
`advance-phase.ts` — a genuine, precise defect in the new smoke test.

## Critical Fixes

### Fix R2-1: Make the panel-mode smoke test hermetic
- **Source:** silent-failure-hunter (CRITICAL)
- **File:** scripts/smoke-panel-mode.sh (run_gate/run_stop; steps 3 & 5)
- **Issue:** The script exported an absolute `LOOM_STATE_PATH` under `$TMP` but never `cd`ed
  into it. `advance-phase.ts` resolves its plan fallbacks against **cwd-relative** paths
  (`.claude/plans/${slug}.md`, `readdirSync(".claude/plans")`), so those reads hit the loom
  repo's real plans dir, not the fixture. Step 3's date-prefix "trap" was therefore inert, and
  its pass/fail was coupled to how many `2026-07-17-*` files happen to exist in the repo — a
  false-assurance test guarding the exact transition logic it exists to protect.
- **Fix:** Run both CLI invocations with cwd = `$TMP` (`( cd "$TMP" && bun … )`) so relative
  fallbacks resolve inside the fixture. Step 5 now leaves `plan_file` null to genuinely exercise
  the slug-derive fallback. All 7 assertions still pass, now hermetically.

## Advisory Fixes

### Fix R2-2: Exercise the real placeholder detector in the substitution test
- **Source:** pr-test-analyzer
- **File:** engine/tests/handlers/pre-tool-use/validate-template-substitution.test.ts:12
- **Fix:** Import and delegate to the real `findResidualPlaceholders` instead of an inline
  copy, realizing the anti-drift goal of the earlier extraction. ~15 property/edge tests now
  cover the shipped function.

### Fix R2-3: Make the panel/phase disjointness invariant permanent in the type system
- **Source:** type-design-analyzer
- **File:** engine/src/config.ts:36
- **Fix:** Type `ARCH_PANEL_AGENTS` as `ReadonlySet<string>` so a post-import `.add`/`.delete`
  that could re-break the load-checked invariant no longer typechecks.

### Fix R2-4: Correct the PANEL_DESIGNERS_DEFAULT docstring
- **Source:** comment-analyzer, architecture-agent (converged)
- **File:** engine/src/config.ts:67
- **Fix:** Reword to state the engine never spawns designers — the orchestrator reads the
  constant as the `--panel=N` default — removing the false implication of engine-side spawning.

### Fix R2-5: Fix the panel cost figure in the README
- **Source:** comment-analyzer
- **File:** README.md:191
- **Fix:** `N + K` → `N + K + 1` (the interviewer run was omitted); note the finalize run
  replaces the standard architecture-agent and nets zero.

### Fix R2-6: Rename the misleading default-spec_dir test + add a genuine null case
- **Source:** pr-test-analyzer
- **File:** engine/tests/handlers/validate-phase-order.test.ts:242
- **Fix:** The test named "…when spec_dir is null" actually passed `/nonexistent/specs`.
  Renamed to describe reality, and added a separate hermetic `spec_dir: null` test (chdir into
  an isolated dir) that exercises the real `?? ".claude/specs"` fallback.

### Fix R2-7: Wire the smoke test into an npm script
- **Source:** silent-failure-hunter
- **File:** engine/package.json
- **Fix:** Added `test:smoke` so the end-to-end guard is discoverable and runnable, not a
  hand-remembered script.

## Validation (Round 2)
- Typecheck: ✅ `bunx tsc --noEmit` clean
- Unit tests: ✅ 1617 pass, 0 fail
- Smoke test: ✅ 7/7 assertions pass (now hermetic)
