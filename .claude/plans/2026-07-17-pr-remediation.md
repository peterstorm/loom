# PR Remediation Plan (round 4)

**Date:** 2026-07-17
**Branch:** feat/architecture-panel-mode-plan
**Findings:** 0 critical, 15 advisory (6 reviewers) → fixing Tier A + B (8 items) per user scope

## Context

Fourth remediation round. All six review agents returned **0 critical** findings and
confirmed a clean typecheck, 1619 passing tests, and 9/9 smoke assertions. Remaining
findings are advisory refinements. User selected Tier A (mechanical) + Tier B
(test-hardening); Tier C (large type-system refactors + panel skill-validation) deferred.

An empirical check while planning surfaced a **latent comment inaccuracy**: the doc
comment for `findResidualPlaceholders` claimed `${foo{bar}}` "leaves `{bar}` and blocks
loudly". Actual behavior: it strips to a lone `}` and *allows*. The real residual-leak
case is adjacent `${done}{leftover}`. The pinning test (Fix 6) codifies the true behavior
and the comment is corrected.

## Tier A — mechanical fixes

### Fix 1: jq availability guard in smoke test
- **Source:** silent-failure-hunter
- **File:** scripts/smoke-panel-mode.sh:29
- **Issue:** `phase_now()` needs `jq`, but only `bun` is checked at startup. A missing
  `jq` surfaces as a misleading `FATAL: could not read current_phase` rather than a clear
  missing-tool error.
- **Fix:** Add `command -v jq` guard alongside the bun check.

### Fix 2: Broaden residual-placeholder identifier class
- **Source:** silent-failure-hunter
- **File:** engine/src/core/validate-template-substitution.ts:29
- **Issue:** `\{[a-zA-Z_][a-zA-Z0-9_]*\}` silently passes hyphen/dot placeholders
  (`{spec-dir}`, `{plan.file}`). No live defect today, but a future template could bypass
  the guard as a silent pass — the exact class this guard prevents.
- **Fix:** Widen to `[a-zA-Z_][a-zA-Z0-9_.-]*`; rewrite the doc comment to describe the
  real nesting behavior accurately.

### Fix 3: Correct module-load guard comment
- **Source:** comment-analyzer
- **File:** engine/src/config.ts:76-78
- **Issue:** "This runs on every handler import" — module init runs once per process, not
  per import.
- **Fix:** Reword to "runs once at first config import (transitively pulled in by every
  handler)."

### Fix 4: Remove scratch reasoning from a test
- **Source:** pr-test-analyzer
- **File:** engine/tests/handlers/pre-tool-use/validate-template-substitution.test.ts:56-66
- **Issue:** ~10 lines of stream-of-consciousness exploration left in a test body.
- **Fix:** Trim to a one-line rationale.

## Tier B — test-hardening

### Fix 5: Assert the module-load guard actually throws
- **Source:** pr-test-analyzer, type-design-analyzer
- **File:** engine/src/config.ts:79-88 → extract `assertPanelPhaseDisjoint()`; test in
  engine/tests/panel-config.test.ts
- **Issue:** Tests only assert `panelPhaseOverlap()` return values; the `throw` branch has
  zero coverage. A regression removing the throw would leave every test green.
- **Fix:** Extract the guard into an exported `assertPanelPhaseDisjoint()`, call it at
  module scope, and add tests asserting it throws on synthetic overlap and not on the real
  config.

### Fix 6: Pin the nested-brace behavior
- **Source:** pr-test-analyzer
- **File:** engine/tests/handlers/pre-tool-use/validate-template-substitution.test.ts
- **Issue:** The documented `${foo{bar}}` case had no test — and the doc claim was wrong.
- **Fix:** Add tests: `${foo{bar}}` → allow (true behavior), `${done}{leftover}` → block
  (adjacent residual), `{spec-dir}`/`{plan.file}` → block (Fix 2's broadening).

### Fix 7: Drive the real handler for panel passthrough
- **Source:** pr-test-analyzer
- **File:** engine/tests/handlers/subagent-stop/advance-phase.test.ts
- **Issue:** Panel-passthrough tests assert the precondition (map-miss), not the handler's
  behavior.
- **Fix:** Invoke the real `handler` default export on bare + namespaced panel-agent
  SubagentStop stdin and assert passthrough (short-circuits before state access). Full
  advance-vs-no-advance remains covered by the smoke test — noted, since import-time path
  freezing makes a same-process full-state handler test fragile.

### Fix 8: Tighten lensCount() to lens slugs
- **Source:** architecture-agent
- **File:** engine/tests/panel-config.test.ts:17-27
- **Issue:** Counts all `## ` H2 headings; a future `## Notes`/`## Selection` heading in
  panel-lenses.md would silently inflate the designer cap above the real lens count.
- **Fix:** Match only lens-slug headings `^## [a-z][a-z0-9-]*$`.

## Deferred (Tier C — not in scope this round)

- Express panel/phase disjointness as a compile-time type assertion; introduce an
  `AgentName` newtype; model `detectPhase` as a discriminated union carrying panel-ness
  (type-design-analyzer, 4 items). *Reason: substantial core-engine refactor; current
  runtime+load-time+test enforcement is deliberate and defended in-code (Bun transpile-only
  mode).*
- Panel agents bypass `validate-agent-skill`; interviewer has no engine-side questionnaire
  enforcement (architecture-agent, 2 items). *Reason: compensating controls exist
  (frontmatter `skills:` preload + template audit test); design-level change.*

## Validation Commands
```bash
cd engine && bunx tsc --noEmit
cd engine && bun run test
./scripts/smoke-panel-mode.sh
```
