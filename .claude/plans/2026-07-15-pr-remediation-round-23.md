# PR Remediation Plan — Round 23

**Date:** 2026-07-15
**Branch:** feat/deterministic-core-phase-c
**Findings:** 0 critical, 1 advisory (loom-side; the round's critical was cross-repo in fugue)

Round 23 of the sustained cross-repo remediation (`this repo and fugue pr`). Six
parallel review agents ran across both repos (code-reviewer, silent-failure-hunter,
type-design-analyzer × loom + fugue), focused on the recently-touched
security-critical core.

The loom bash-parsing guard (`guard-state-file.ts` / `shell-normalize.ts` /
`shell-ansi-c.ts`) was empirically stress-tested against ~50 adversarial vectors
by the code-reviewer and found **clean — no new bypasses** (reveal-monotonicity
holds across all four normalization bases; the round-22 nested-colonless fix
verified at depth). The only actionable loom finding was a type-expression
weakness in the shell lexer.

## Advisory Fixes (applied)

### Fix 1: Dedup the two lockstep colonless-empty call sites
- **Source:** type-design-analyzer
- **File:** `engine/src/core/shell-normalize.ts:252,277`
- **Issue:** The rule "a colonless default under `colonlessEmpty` contributes
  empty" was expressed by an identical `!(colonlessEmpty && pe.colonless)` guard
  duplicated at two `normalizeShellSpan` call sites (unquoted + double-quoted
  `$`). Two sites that must stay in lockstep — the "twin scanners diverge" class
  this module's own header warns about, reintroduced at finer grain.
- **Fix:** Extracted `revealWordUnlessColonlessEmpty(text, pe, colonlessEmpty)`
  (typed on `Extract<ParamExpansion, {kind:"word"}>`) as the single source of
  truth; both call sites now delegate. No behavior change.

## Considered — deliberately not fixed

- **`wordStart <= end - 1` unenforced (type-design advisory):** the ordering is
  **structurally guaranteed by construction today** — `wordStart = bodyStart +
  nameLen + op.length ≤ close = end - 1` because the matched operator lies fully
  within the brace body. An overshoot is unreachable; adding a throwing assertion
  into the security-critical guard is higher risk than value.
- **Shared `QuoteState` type across scanners (type-design advisory):** the
  differing alphabets (backtick-as-quote in `hasOutputRedirect`, not in
  `scanSubstitutions`) are **intentional and correct** per bash substitution
  semantics; the code-reviewer independently verified each per-function union is
  coherent. Unifying risks the guard.
- **`SubstitutionScan` discriminated union (type-design advisory):** refactor
  churn in battle-tested security code; low value.
- **Eager/lazy `TASK_GRAPH_PATH` split (silent-failure advisory):** documented
  fail-safe contract (`config.ts:273`); not a vulnerability.

## Validation

```bash
cd engine && bunx tsc --noEmit          # ✅ clean
bun test                                 # ✅ 1583 pass, 0 fail
```
