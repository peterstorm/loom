# PR Remediation Plan — Round 26

**Date:** 2026-07-16
**Branches:** loom `feat/deterministic-core-phase-c`, fugue `feat/deterministic-core-phase-b`
**Findings:** 1 critical (loom), 0 advisory

## Review Summary

Cross-repo review, 6 parallel agents (3 loom, 3 fugue). Prior rounds 22–25 read to
exclude resolved findings.

- **fugue** (code-reviewer, silent-failure-hunter, type-design-analyzer): 0/0.
  The prior CRITICAL retriability gap is verified fixed — `retriabilityOf` is an
  exhaustive `match(...).exhaustive()` over all 27 `FrameworkError` kinds; a probe
  variant injected into the union produces 4 compile errors, so a new kind cannot
  be added without an explicit retriability decision.
- **loom** (silent-failure-hunter, type-design-analyzer): 0/0. Fail-closed
  boundary and exit-code polarity hold; type design exemplary.
- **loom** (code-reviewer): **1 CRITICAL** — new bash-substitution bypass class.

## Critical Fixes

### Fix 1: Nonempty-output command substitution completing a guarded literal bypasses the guard
- **Source:** loom:code-reviewer (confidence 90, verified vs real bash)
- **File:** `engine/src/core/guard-state-file.ts` (`blankSubstitutions` / `referencesPattern`)
- **Issue:** The guard models a `$(…)` / backtick / `<(…)` substitution as producing
  only two outputs — EMPTY (`blankSubstitutions`: `.claude/stat$(:)e` → `.claude/state`)
  or ITSELF-LITERAL (`collapseQuotes`: `$(printf e)` kept verbatim). Bash has a third
  behavior: a substitution whose output is a nonempty fragment that COMPLETES a guarded
  literal. `rm -rf .claude/stat$(printf e)` resolves to `.claude/state` (verified with
  `ls -d` on a real tree) and deletes the guarded state dir, but:
  - empty view drops the `e` → `.claude/stat` (no match)
  - literal view keeps `$(printf e)` inline → no `.claude/state`

  So `guardStateFileDecision` returns **allow**. Also allowed: the backtick form,
  `${x:-$(printf e)}` (nested default), and `${PWD:+$(printf e)}` (alternate form).
  Same recurring class as rounds 20/21/22/24/25 — the mirror of the round-20
  `$(:)`→empty fragmentation fix.
- **Fix:** Add a third, strictly-additive substitution base view —
  `wildcardSubstitutions`, replacing each substitution with a glob `*` (the
  fail-closed model of "arbitrary, statically-unknowable output"). The existing
  per-segment glob / guarded-dir intersection test in `referencesPattern` then
  fires: `.claude/stat*` fnmatches the `.claude/state` dir; `.claude/*` reaches it
  too. Fed through `collapseVariants` so the wildcard is revealed inside nested
  default/alternate words (`${x:-*}`, `${PWD:+*}`). Reuses the shared
  `scanSubstitutions` (quote-aware, opener set) so it cannot diverge from the empty
  view. Reveal-monotonic and additive — tested alongside the empty and literal
  bases, never instead of them.

## Validation Commands
```bash
cd engine && bun run typecheck && bun test tests/handlers/pre-tool-use/guard-state-file.test.ts tests/core/shell-normalize.test.ts
```
