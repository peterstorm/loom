# PR Remediation Plan — Round 19

**Date:** 2026-07-11
**Branch:** feat/deterministic-core-phase-c
**Findings:** 2 critical, 16 advisory (deduped against rounds 16–18)
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead

## Critical Fixes

### Fix 1: Parameter-expansion guard bypass — `$x`/`${x}` not modeled (VERIFIED end-to-end)
- **Source:** silent-failure-hunter (verified: pure decision + real bash delete + real hook EXIT=0)
- **File:** engine/src/core/shell-normalize.ts, engine/src/core/guard-state-file.ts
- **Issue:** `normalizeShellSpan` decoded quotes/backslash/ANSI-C/locale but passed a bare `$x`/`${x}` through as a literal `$`/`{`/`}` run. Fragmenting BOTH the guarded dir and filename with an unset→empty expansion (`rm .claude/stat${x}e/active_task_grap${x}h.json`) produced a view matching neither `.claude/state` nor `active_task_graph`, so the front gate short-circuited to ALLOW — real state deletion + subagent-ledger forgery.
- **Fix:** Added `paramExpansionEnd` + deletion of unquoted/double-quoted `$name`/`${…}` (to unset→empty, the only bash-accurate view) in `normalizeShellSpan` — single-sourced so guard and evidence twin stay point-wise identical. `$'…'`/`$"…"`/`$(…)` unaffected; single-quoted `$x` stays literal. Updated `collapseQuotes` reveal-monotonicity docblock. Pinned: guard block/allow rows, shell-normalize unit + parity rows.

### Fix 2 (design): @fugue-integrity stamp contradicts "implement the placeholders" (VERIFIED, cross-repo)
- **Source:** fugue code-reviewer + silent-failure-hunter (both verified by execution); loom comment-analyzer (PostToolUse claim)
- **Files:** fugue authored-codegen.ts, new.ts; loom fugue-generated-integrity.ts, references/executable-models.md, README.md
- **Issue:** The whole-body hash + "DO NOT EDIT" banner forbade the placeholder node bodies the scaffold's own nextSteps/README instruct implementing; every loom implementation wave was blocked, and "regenerate from AuthoredDag" destroyed the work. Separately, loom's rule docblock claimed PostToolUse edit-time detection — programmatic rules run only at the wave-gate tier.
- **Fix:** **Structural-region hashing.** Fugue emits `@fugue-body-start/end` markers around fetch/transform/source placeholder bodies; `structuralProjection` collapses each region so the hash covers only machine-owned STRUCTURE (imports/schemas/ids/wiring/registration). `stampGenerated` + loom's rule both hash the projection — implementing bodies leaves the hash intact; hand-rewiring structure is flagged. Verified end-to-end against real generated output (fresh=pass, body-implemented=pass, structure-rewired=flagged). Banner/nextSteps/docblocks/executable-models/README corrected (wave-gate tier, not PostToolUse). Also closed fail-open holes: malformed/corrupted marker → fail closed; non-comment content prepended above the banner → fail closed.

## Advisory Fixes (all applied)

1. validate-model-bindings.ts drift check: raw `content.includes(n)` → quoted-JSON-token match against serialized `dag.nodes` (fixes `fetch` ⊂ `fetch-order` false-pass); collision regression row.
2. shell-normalize.ts `NormalizeOptions` boolean product → discriminated `mode: "matching-view" | "redirect-word"` union (illegal configs unrepresentable); both call sites + tests updated.
3. shell-normalize.ts `WORD_BOUNDARY` now includes `|`/`;` + contract note; redirect-word boundary rows.
4. Test pins for untested guard branches: brace-SEQUENCE (`{a..c}`) block/allow rows, `?`-glob-into-guarded-dir block row (each mutation-verified).
5. loom.md:501: `mark-tests-passed` moved to sanctioned read-only list; whitelisted-helpers vs out-of-scope helpers split (validate-task-graph/validate-lint-rules not in WHITELISTED_HELPERS).
6. config.ts: orphaned "State file patterns" docblock moved above `stateFilePatterns`.
7. shell-normalize.ts / guard-state-file.ts: corrected backtick rationale (reveal-monotonic, not "flattened before"); double-quoted `\c` over-normalization caveat.
8. Added subagent-dir-sync.test.ts: 5 hook scripts' `LOOM_SUBAGENT_DIR:-` default == config.ts default (fail-open guard against drift).
9. shell-ansi-c.ts `decodeAnsiC`: NUL now TRUNCATES the rest of its own ANSI-C body (bash-accurate), fixing the evidence-twin under-mint; docblock + guard/evidence NUL rows updated.
10. README.md + executable-models.md: shipped programmatic-rules list now includes fugue-generated-integrity (wave-gate tier).

## Deferred (unchanged standing items)
- Shared shell tokenizer (rounds 15–19): normalization is now fully single-sourced (round 19 mode union); structural scanners (`splitCommandSegmentsWithOps`, `classifyFdDupWord`) still live in machine/extract-evidence and are imported UP by core/guard-state-file. Relocating them to core/ is the remaining half.
- Bare-CWD-filename glob residual; multi-hop `cd` laundering (both need cwd tracking); SpecCheck verdict/count ADT cluster; complete-wave-gate checkbox regex extraction.

## Validation
```bash
cd engine && bunx tsc --noEmit && bun test   # 1563 pass / 0 fail, tsc clean
```
