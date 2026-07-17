# PR Remediation Plan (round 5)

**Date:** 2026-07-17
**Branch:** feat/architecture-panel-mode-plan
**Findings:** 0 critical, 8 advisory (after dedup, 6 reviewers) → user selected "Tight 5 + type refactor"

## Context

Fifth remediation round. All six review agents again returned **0 critical**, with a clean
typecheck, 1619→1627 passing tests, and 9/9 smoke assertions. Remaining findings were
advisory. User scope: the five tight/safe fixes **plus** the type-system refactor that
round 4 had deferred as Tier C (express panel/phase disjointness structurally).

No-action findings (acknowledged in-code / inherent to the markdown-runbook orchestration):
unbranded string IDs, the judge→finalizer & lens-label prose contracts, and the import-time
disjointness assertion.

## Fixes applied

### Fix 1: Smoke test — spurious PASS after a dispatch crash
- **Source:** silent-failure-hunter
- **File:** scripts/smoke-panel-mode.sh (steps 3 and 5)
- **Issue:** Step 3 ran `bad` on a non-zero dispatch exit, then fell through to the
  "phase unchanged" assertion, which fires `ok` (green ✓) because a crash leaves the phase
  at `architecture` for the wrong reason. Spurious PASS next to the FAIL (run still exited
  non-zero, so not defeated — but misleading when triaging).
- **Fix:** Gate the phase assertion on `[ "$src" = "0" ]` — only assert the transition when
  dispatch ran clean. Applied symmetrically to step 5.

### Fix 2: Test the third `phaseLookupKeys` probe (`name + "-agent"`)
- **Source:** pr-test-analyzer
- **File:** engine/tests/panel-config.test.ts
- **Issue:** `phaseLookupKeys` returns `[bare, name, name + "-agent"]`; tests covered the
  bare and exact keys but not the doubly-suffixed one (`arch-designer-agent-agent`), which
  `detectPhase`'s third probe can hit.
- **Fix:** Added a synthetic-overlap case asserting the guard flags a phase agent stored
  under `arch-designer-agent-agent`.

### Fix 3: Make the frozen map's read-only-ness a compile-time guarantee
- **Source:** type-design-analyzer
- **File:** engine/src/config.ts (PHASE_AGENT_MAP annotation)
- **Issue:** `Object.freeze`d at runtime but typed `Record<string, Phase>` (mutable), so
  `PHASE_AGENT_MAP[x] = ...` still type-checked — the freeze's read-only narrowing was
  discarded.
- **Fix:** Annotated `Readonly<Record<string, Phase>>`. Kept the string index signature
  (not `as const`, which would break `detectPhase`'s computed `PHASE_AGENT_MAP[agent]`
  lookups). Now mutation is both a compile-time error and a runtime throw.

### Fix 4: Guard the `{judge_verdicts}` brace hazard
- **Source:** code-reviewer, architecture-agent
- **File:** commands/loom.md (Step 5), commands/templates/phase-arch-judge.md
- **Issue:** Judge-LLM verdict prose (`fatal_flaw`/`strongest_idea`) inlined into
  `{judge_verdicts}` could contain a literal brace-wrapped word, which
  validate-template-substitution reads as an unsubstituted placeholder — fail-closed-blocking
  the finalize spawn *after* N+K agents already ran.
- **Fix:** loom.md Step 5 now instructs the orchestrator to strip `{`/`}` from the JSON
  string values before inlining (primary mitigation at the actor that inlines). The judge
  template additionally instructs judges not to use brace characters in prose fields
  (defense-in-depth). Both worded to contain no `{identifier}` token themselves (verified by
  the template audit).

### Fix 5: Tie panel-agent phase classification to a shared constant
- **Source:** type-design-analyzer
- **File:** engine/src/config.ts (new `ARCH_PANEL_PHASE`), engine/src/core/validate-phase-order.ts:54
- **Issue:** `detectPhase` hard-coded the bare literal `"architecture"` for panel agents,
  decoupled from `ARCH_PANEL_AGENTS` — silent drift risk if panel scope ever changed.
- **Fix:** Introduced `ARCH_PANEL_PHASE`, co-located with the panel agents; `detectPhase`
  routes panel agents via the constant.

### Fix 6 (type refactor, formerly Tier C): Single role-tagged agent registry
- **Source:** type-design-analyzer (recommendation #1)
- **File:** engine/src/config.ts
- **Issue:** Panel/phase disjointness was two independent `string` collections + a runtime
  predicate; the illegal "same name in both" state was representable and only detected.
- **Fix:** Introduced `ARCHITECTURE_AGENTS` (`as const satisfies Record<string, AgentRole>`)
  as the single source of truth mapping each agent to a `{ role, phase }`. `PHASE_AGENT_MAP`
  and `ARCH_PANEL_AGENTS` are now DERIVED views (filter by role). A name is one object key
  with one role, so the SAME name can never be both phase and panel — the exact-key overlap
  is now structurally impossible.
- **Deliberately kept:** the runtime `panelPhaseOverlap`/`assertPanelPhaseDisjoint` guard.
  The single-source map does NOT rule out *suffix-variant* collisions (a phase agent
  `arch-designer` vs a panel `arch-designer-agent`, or a doubly-suffixed `-agent-agent`),
  which are distinct keys `detectPhase`'s probes still hit. Comments updated to state that
  the guard now covers exactly the suffix-variant cases.

## Validation

```bash
cd engine && bunx tsc --noEmit      # clean
cd engine && bun run test           # 1627 pass, 0 fail
./scripts/smoke-panel-mode.sh       # 9/9 PASS
```

## Still deferred (no-action)

- Branded `AgentId` newtype — defensible tradeoff, acknowledged in-code (Bun transpile-only
  mode; the load-time throw is the real boundary).
- Judge→finalizer JSON contract and lens-label coupling are unvalidated — inherent to the
  prose-orchestrated (markdown-runbook) design; compensating controls exist (template audit,
  finalizer reads the JSON).
