# PR Remediation Plan — Round 21 (cross-repo: loom + fugue)

**Date:** 2026-07-11
**Loom branch:** feat/deterministic-core-phase-c
**Fugue branch:** feat/deterministic-core-phase-b
**Reviewers (×12):** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead — per repo.

Findings deduped against rounds 1–20. Standing deferred items (structural-scanner relocation to core/, bare-CWD glob, multi-hop `cd`, SpecCheck ADT, checkbox regex; fugue: truncation-policy extraction, turn() retriability, runCompose reification, io rethrow, Temperature branding, gauntlet, TEMPLATE_OPEN property) NOT re-reported.

## LOOM — Critical Fixes

### L1: Colonless default `${x-w}`/`${x=w}` set-but-empty channel (VERIFIED end-to-end)
- **Source:** code-reviewer, silent-failure-hunter (converged; verified against bash semantics).
- **File:** engine/src/core/shell-normalize.ts (`classifyBraceBody` + `normalizeShellSpan`), engine/src/core/guard-state-file.ts (`referencesPattern`).
- **Issue:** Round-20 (L1) revealed the default WORD for the modifier forms, closing the unset→word concealment. But the COLONLESS forms `${x-w}`/`${x=w}` have a SECOND bash output the colon forms lack: when the var is SET-BUT-EMPTY they expand to EMPTY. So a decoy word (`.claude/stat${x-X}e`) reveals the harmless `.claude/statXe` in the word view yet reassembles to `.claude/state` when x is set-empty — the word-reveal base conceals it. `rm .claude/stat${x-X}e/active_task_grap${x-X}h.json` → guard ALLOWs on the round-20 view; bash with `x=''` deletes real state. Ledger forge via `${x-X}s` identical. The colon forms (`:-`/`:=`) substitute on unset AND null, so `w` is their ONLY output — not affected.
- **Fix:** `ParamExpansion.word` carries a `colonless` flag (op `-`/`=` vs `:-`/`:=`). `normalizeShellSpan` gains a `colonlessDefaultsEmpty` matching-view option that collapses colonless default words to EMPTY (their set-empty output) while colon forms keep revealing their word. `referencesPattern` now tests FOUR reveal-monotonic bases, deduped: substitutions LITERAL vs EMPTY × colonless defaults REVEALED vs EMPTY. Common case (no substitutions, no colonless defaults) collapses to a single base. Reveal-monotonic (emptying a span only joins surrounding literals); guard/evidence twin stay point-wise identical on the primary view (the empty view is an ADDITIONAL guard base, not a redirect-word behavior).

### L2: Unify the twin substitution scanners; fix double-quoted-apostrophe regression (VERIFIED end-to-end)
- **Source:** architecture-tech-lead (twin-scanner divergence, the class recurring rounds 15–18), code-reviewer (round-20 regression on `"it's"`).
- **File:** engine/src/core/guard-state-file.ts (`blankSubstitutions` + `flattenSubstitutions`).
- **Issue (divergence):** `blankSubstitutions` (matching view) and `flattenSubstitutions` (recursive judging) were two independent quote-aware traversals that had to agree on quoting and the opener set — the exact "twin scanners diverged" bug class remediated repeatedly in rounds 15–18. **Issue (regression):** both tracked quote state as a lone `singleQuote` boolean, so a `'` inside double quotes (`"it's"`) flipped into single-quote mode and suppressed EVERY substitution after it. `echo "it's fine" && rm .claude/stat$(:)e/…` and the backtick variant then waved a fragmented guarded write through (round-20 regression introduced with the round-20 L2 substitution defense).
- **Fix:** Extract ONE quote-aware traversal `scanSubstitutions(text, onBody)` returning `{bodies, rebuilt, unclosed}`; `blankSubstitutions` maps bodies to `""`, `flattenSubstitutions` maps them to placeholders — they can no longer diverge on quoting or opener set. Quote state is `'"' | "'" | null`: a `'` opens a single-quoted region ONLY when unquoted; inside `"…"` it is a literal apostrophe. `$(…)`/backticks stay LIVE inside double quotes (bash performs them); `<(…)`/`>(…)` are substitutions only when UNQUOTED. Unclosed opener → `unclosed: true`; matching view blanks-to-end (maximal reveal), flatten returns null (fail closed).
  - **Correction applied while resuming:** the initial round-21 edit still opened single-quote mode on a `'` inside `"…"` (`if (c === "'") { quote = "'" }` unguarded) — the regression was NOT actually closed; the backtick channel `echo "don't" && rm .claude/stat` `` `:` `` `e/…` still ALLOWed. Guarded the opener with `quote === null`. Re-verified both `$(…)` and backtick channels now block.

## LOOM — Test Fixes (mandatory, per The Standard)
- Guard block/allow rows for the colonless set-but-empty channel (`${x-X}`/`${x=X}` block; `${x:-X}`/`${x:=X}` allow — precision) incl. redirect-target and ledger-forge variants.
- Guard block rows for the double-quoted-apostrophe regression across `$(…)` AND backtick, a body-hidden write after a double-quoted apostrophe (flatten still engages), and precision allows (genuine apostrophe; real single-quoted region still suppresses).
- shell-normalize unit test for `colonlessDefaultsEmpty` (colonless→empty, colon forms reveal word, flag additive vs default view).

## FUGUE — Advisory Fixes
- **F1 (cohesion):** pure `stampGenerated` stranded in the imperative shell — relocate to the functional core so the integrity stamp is a pure, unit-testable transform, boundary only does IO.
- **F2 (single-sourcing):** `@fugue-body` token literal-duplicated without derivation — derive both `-start`/`-end` strings from the single-sourced `FUGUE_BODY_MARKER` (mirrors the round-20 F1 NO_TEMPLATE_OPEN single-source), so the token can never drift between emission and probe.
- **F3 (policy duplication):** `classifyLlmError` / `httpFailureToError` duplicate retriability/status policy — single-source the classification so the two paths cannot diverge on which statuses are retriable or how `httpStatus` is carried.

## Validation
```bash
# loom
cd engine && bunx tsc --noEmit && bun test
# fugue
cd packages/framework && bunx tsc --noEmit && bun test
```
