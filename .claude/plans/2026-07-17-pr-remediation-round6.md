# PR Remediation Plan — Round 6

**Date:** 2026-07-17
**Branch:** feat/architecture-panel-mode-plan
**Findings:** 1 critical, 5 advisory (3 actionable)

## Review Summary

| Agent | Critical | Advisory |
|-------|----------|----------|
| code-reviewer | 0 | 0 |
| silent-failure-hunter | 0 | 1 |
| pr-test-analyzer | 0 | 2 |
| type-design-analyzer | 1 | 2 |
| comment-analyzer | 0 | 0 |
| architecture-tech-lead | 0 | 0 |

## Critical Fixes

### Fix 1: `ARCH_PANEL_PHASE` claimed to be derived but was a hardcoded literal
- **Historical note:** This finding describes the Round 6 code. Later remediation removed the panel variant's `phase` field; it is not a description of the current `AgentRole` shape.
- **Source:** type-design-analyzer
- **File:** engine/src/config.ts:80-86 at the reviewed revision
- **Issue at the reviewed revision:** The doc comment said `ARCH_PANEL_PHASE` was "Derived from the panel
  agents' shared `phase` in ARCHITECTURE_AGENTS so the set and the phase it maps
  to cannot drift," but it is `export const ARCH_PANEL_PHASE: Phase = "architecture"`
  — a hardcoded literal. The `phase` field on the `panel` variant of `AgentRole`
  (config.ts:27) is dead data read by nothing. If a future panel agent is added
  with a different `phase`, or the panel entries' phase is changed, the literal
  will not follow and `detectPhase` will classify panel agents into a phase that
  disagrees with their declared entry — the exact drift the comment promises is
  impossible.
- **Fix:** Genuinely derive `ARCH_PANEL_PHASE` from the panel entries: collect the
  distinct `phase` values of every `role: "panel"` entry, assert exactly one
  (throw at load otherwise), and export that. Makes the comment true and gives the
  `phase` field a purpose.

## Advisory Fixes (actionable)

### Fix 2: Test-injection params widen public surface with mutable Record
- **Source:** type-design-analyzer
- **File:** engine/src/config.ts:112, 123
- **Issue:** `panelPhaseOverlap` and `assertPanelPhaseDisjoint` accept
  `phaseMap: Record<string, Phase>` (mutable) purely for test injection,
  inconsistent with `PHASE_AGENT_MAP`'s `Readonly<Record<string, Phase>>` posture.
- **Fix:** Narrow the parameter type to `Readonly<Record<string, Phase>>`.

### Fix 3: Judge-JSON round-trip through the substitution gate is untested
- **Source:** pr-test-analyzer
- **File:** engine/tests/panel-templates.test.ts
- **Issue:** The judge emits free-text JSON values inlined into `{judge_verdicts}`
  in the finalize prompt. A brace-word in a judge free-text value (e.g. an LLM
  writing `use the {simplicity} lens`) would spuriously block the finalize spawn
  at runtime via `findResidualPlaceholders` — an untested path.
- **Fix:** Add a test that substitutes a realistic judge-JSON blob (including a
  brace-containing free-text value) into the finalize template and asserts the
  documented outcome, pinning the behavior.

### Fix 4: Smoke test JSON payloads lack escaping
- **Source:** silent-failure-hunter
- **File:** scripts/smoke-panel-mode.sh (run_gate/run_stop)
- **Issue:** `agent`/`prompt` args are interpolated into a JSON payload via
  `printf '%s'` with no JSON-escaping. Safe for all current ASCII call sites, but
  a future prompt containing `"` or `\` would produce malformed JSON that
  `validate-phase-order` fail-closes on (exit 2), which allow-case assertions
  would misread as a block.
- **Fix:** Build the JSON payloads with `jq` (already a script dependency) so
  arguments are escaped correctly.

## Advisory — Not Actionable (documented, no change)

- **Disjointness only partially structural** (type-design): the suffix-variant
  collision is runtime-only, not type-expressed. Already honestly acknowledged in
  the code comments; a full type-level encoding is more machinery than warranted.
- **`substitute()` replaces all occurrences** (pr-test): the "no residual
  placeholders" guarantee assumes the LLM orchestrator substitutes every repeated
  occurrence. This is a boundary a unit test cannot cross (the orchestrator is an
  LLM following prose), not a test defect.

## Validation Commands
```bash
cd engine && bun run typecheck
cd engine && bun test
bash scripts/smoke-panel-mode.sh
```
