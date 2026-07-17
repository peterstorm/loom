# PR Remediation Plan (round 3)

**Date:** 2026-07-17
**Branch:** feat/architecture-panel-mode-plan
**Findings:** 1 critical, ~20 advisory (heavily overlapping across 6 agents)

Six review agents ran (code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-agent). Four of them rated
the panel-mode diff clean (0 critical); the silent-failure-hunter surfaced the
one real latent hole, and the type/architecture agents converged on the same
underlying invariant weakness. Findings deduplicated below.

## Critical Fixes

### Fix 1: Disjointness guard doesn't cover detectPhase's full lookup space
- **Source:** silent-failure-hunter (C1), reinforced by type-design-analyzer (A1)
- **File:** engine/src/config.ts:46-51 (guard) / engine/src/core/validate-phase-order.ts:48-54 (lookup)
- **Issue:** `detectPhase` probes `PHASE_AGENT_MAP` with BOTH `agent` and
  `agent + "-agent"`, so a bare panel invocation (`arch-designer`) is looked up
  as `arch-designer` too. The load-time guard `panelPhaseOverlap` only checks the
  exact stored suffixed key (`"arch-designer-agent" in phaseMap`). A future phase
  agent named `arch-designer` (de-suffixed) would silently capture the bare panel
  invocation via detectPhase's first probe — advancing the phase mid-panel, the
  exact bug the invariant exists to prevent — with the guard blind to it.
- **Fix:** Strengthen `panelPhaseOverlap` to check every key detectPhase could
  probe for a panel agent (`{bare, name, name+"-agent"}`) against phaseMap, so the
  invariant covers the same normalization the lookup uses. Additionally
  `Object.freeze(PHASE_AGENT_MAP)` so the load-time guard is a complete proof, not
  an initial-state snapshot (post-load mutation can no longer break the invariant).

## Advisory Fixes

### Fix 2: Prove the strengthened guard (de-suffixed collision test)
- **Source:** derived from Fix 1
- **File:** engine/tests/panel-config.test.ts
- **Fix:** Add a test feeding a synthetic `{ "arch-designer": ... }` phaseMap and
  assert the guard flags `arch-designer-agent` — proving the guard now covers the
  de-suffixed probe form, not just the exact key.

### Fix 3: Tie designer cap to the real lens count (kill magic number)
- **Source:** type-design-analyzer (A2/A3/A4)
- **File:** engine/tests/panel-config.test.ts
- **Issue:** `PANEL_DESIGNERS_DEFAULT`'s upper bound is asserted against a
  hard-coded `5`; the "cap at 5 lenses" rule is prose with no enforced link to the
  lens definitions. Adding a lens updates no code and fails no test.
- **Fix:** Derive the lens count from `references/panel-lenses.md` (the single
  source of truth) in the test and assert `PANEL_DESIGNERS_DEFAULT <= lensCount`.
  Avoids introducing a duplicate lens enum in the engine (which the engine never
  reads) while making the cap invariant enforced against the real source.

### Fix 4: Smoke test — block-test interviewer & judge in execute phase
- **Source:** pr-test-analyzer (A3)
- **File:** scripts/smoke-panel-mode.sh
- **Issue:** Only `arch-designer-agent` is block-tested at the composed
  validate-phase-order path; interviewer/judge gating is implicit-by-composition.
- **Fix:** Extend step 2 to assert all three panel roles BLOCK in execute phase
  with the transition message.

### Fix 5: Smoke test — stop swallowing chmod/read failures (false PASS guard)
- **Source:** silent-failure-hunter (A2, A3, A4)
- **File:** scripts/smoke-panel-mode.sh
- **Fix:** `phase_now` asserts a non-empty phase before comparing (a stale/empty
  read can no longer pass an assertion); `write_state` chmod split into an explicit
  `if` that fails loudly; assert no stray session pointer exists so the state
  resolution path the test relies on is the one exercised.

### Fix 6: loom.md hardcodes "N = 3 designers"
- **Source:** comment-analyzer (A1)
- **File:** commands/loom.md:213
- **Fix:** Reference `PANEL_DESIGNERS_DEFAULT` symbolically (as line 44 already
  does) instead of restating the literal `3`, so the default has one source.

### Fix 7: config.ts comment precision
- **Source:** comment-analyzer (A2, A3)
- **File:** engine/src/config.ts
- **Fix:** Broaden the file-header "Skills reference these values" to include
  orchestrator docs; point the ARCH_PANEL_AGENTS invariant comment at BOTH
  enforcement sites (module-load throw + test).

### Fix 8: Document the template-substitution nested-brace limitation
- **Source:** silent-failure-hunter (A5)
- **File:** engine/src/core/validate-template-substitution.ts
- **Fix:** Note the known `${foo{bar}}` nested-brace edge in a code comment so a
  future maintainer isn't misdirected by the block message.

## Deferred (documented, not fixed this round)

- **CI wiring for the smoke test** (pr-test A2): the repo has no `.github/workflows`
  at all. Adding CI infrastructure is a separate concern from review remediation
  and would need a bun-provisioning workflow. `test:smoke` remains a documented
  pre-merge gate (`bun run test:smoke`). Recommend a follow-up PR adding CI.
- **Composed `validatePhaseOrder()` vitest for panel agents** (pr-test A1): the
  function hard-gates on `existsSync(TASK_GRAPH_PATH)` resolved at module import,
  making it env-coupled; the established pattern covers it via the smoke test
  (now extended in Fix 4), not vitest. Not worth fighting module-init order.
- **Lens field-name contract test** (architecture A1): the `**Primary axis:**`
  coupling across three prose files is stable; a markdown-parsing guard would be
  brittle and higher-maintenance than the risk warrants.
- **Typed lens enum in engine** (type-design A2, alternate form): rejected in
  favor of Fix 3 — a duplicate engine tuple would create a SECOND source of truth
  for lenses that could itself drift from panel-lenses.md.

## Validation Commands
```bash
cd engine && bun run typecheck
cd engine && bun run test
bun run --cwd engine test:smoke   # or: bash scripts/smoke-panel-mode.sh
```
