# PR Remediation Plan — Round 7

**Date:** 2026-07-18
**Branch:** feat/architecture-panel-mode-plan
**Findings:** 0 critical, 8 advisory (6 selected for this round: B, C, D, E, F, G)

Round 7 review (6 agents) found **zero critical issues**. Selected the six low-risk,
high-value advisories. Deferred by user decision: **A** (AgentRole refactor removing
the intentional "derived phase" design) and **H** (advance-phase state-path injection).

## Advisory Fixes

### Fix B: Freeze the ARCH_PANEL_AGENTS backing set
- **Source:** type-design-analyzer
- **File:** engine/src/config.ts:74
- **Issue:** `ARCH_PANEL_AGENTS` is typed `ReadonlySet` but the backing `Set` is not
  hardened, unlike the `Object.freeze`d `PHASE_AGENT_MAP` — a runtime
  `(ARCH_PANEL_AGENTS as Set).add(...)` is not blocked. `Object.freeze` alone does
  NOT stop Set mutation (element storage lives in an internal slot), so the real
  fix shadows the mutators.
- **Fix:** Add a `frozenSet` helper that shadows `add`/`delete`/`clear` to throw and
  freezes the instance; construct `ARCH_PANEL_AGENTS` through it.

### Fix C: PANEL_JUDGES_DEFAULT typed source of truth
- **Source:** architecture-tech-lead
- **File:** engine/src/config.ts (new const), commands/loom.md:213
- **Issue:** K=3 judges lives only as prose in loom.md — asymmetric vs the typed
  `PANEL_DESIGNERS_DEFAULT`. No test guard.
- **Fix:** Export `PANEL_JUDGES_DEFAULT = 3`; reference it from loom.md; add a
  panel-config test pinning it.

### Fix D: PANEL_LENS_COUNT constant + clampPanelDesigners pure fn
- **Source:** architecture-tech-lead
- **File:** engine/src/config.ts (new const + fn), commands/loom.md:44,232-234
- **Issue:** The `--panel=N` clamp-to-lens-count (cap 5) exists only as prose; no
  runtime constant or pure function, so it can't be property-tested.
- **Fix:** Export `PANEL_LENS_COUNT = 5` and pure `clampPanelDesigners(n)`; reference
  from loom.md; add unit + fast-check property tests; assert the constant matches
  the lens headings in panel-lenses.md.

### Fix E: Exercise the non-suffixed branch of phaseLookupKeys
- **Source:** pr-test-analyzer
- **File:** engine/tests/panel-config.test.ts:83-110
- **Issue:** De-suffixed collision tests only use `-agent`-suffixed names; the
  `else` branch of `phaseLookupKeys` (bare === panelAgent) is unexercised.
- **Fix:** Add a synthetic bare panel name test.

### Fix F: Pin panel-agent transition behavior in plan-alignment / init
- **Source:** pr-test-analyzer
- **File:** engine/tests/handlers/validate-phase-order.test.ts
- **Issue:** No test asserts panel-agent behavior when current_phase is
  plan-alignment (allowed via loop-back) or init (artifact-gated).
- **Fix:** Add two assertions.

### Fix G: Smoke test payload build under pipefail
- **Source:** silent-failure-hunter
- **File:** scripts/smoke-panel-mode.sh:101-119
- **Issue:** run_gate/run_stop capture the last-failing pipeline stage; a jq
  payload-build failure would be misattributed to the CLI as a block/crash verdict.
- **Fix:** Build the JSON payload into a variable first, assert jq succeeded (fatal
  on failure), then pipe.

## Validation Commands
```bash
cd engine && bun run typecheck
cd engine && bun test
./scripts/smoke-panel-mode.sh
```

## Deferred (by user decision)
- **Historical note:** The decisions below record the Round 7 design state. Later remediation replaced the genuinely-derived `ARCH_PANEL_PHASE` design with the current hardcoded `"architecture"` policy, so this is not a claim about current code.
- **A** — AgentRole illegal-state refactor: conflicted at that time with the intentional
  "genuinely derived" ARCH_PANEL_PHASE design built over prior rounds and verified
  accurate by comment-analyzer. It was treated as a design trade-off in that round.
- **H** — advance-phase state-path injection to bring the e2e no-advance contract
  in-process: broader boundary change; smoke test covers it out-of-process today.
