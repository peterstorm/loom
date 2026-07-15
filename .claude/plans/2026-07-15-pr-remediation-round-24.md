# PR Remediation Plan — Round 24

**Date:** 2026-07-15
**Branch:** feat/deterministic-core-phase-c (loom) + feat/deterministic-core-phase-b (fugue)
**Findings:** 1 critical, 5 advisory (4 pre-existing/mitigated)

## Review agents

6 parallel agents (code-reviewer ×2, silent-failure-hunter, type-design-analyzer,
architecture-tech-lead cross-repo, pr-test-analyzer). All security-critical core
and recently-churned files read in full. Test suites green: loom 1583 pass,
fugue 162 target pass.

## Critical Fixes

### Fix 1: Alternate-form parameter expansion `${x:+w}` / `${x+w}` bypasses the state-file guard (fail-OPEN)
- **Source:** loom:code-reviewer (deterministic security core)
- **Files:** `engine/src/core/shell-normalize.ts` (classifier + reveal), `engine/src/core/guard-state-file.ts` (referencesPattern bases)
- **Issue:** `classifyBraceBody` classified `${x:+w}` / `${x+w}` as `{kind:"empty"}`,
  modeling only the unset output. Bash yields the WORD `w` when the var is set
  (`:+` set-non-null, `+` set). An attacker carries a guarded literal in `w` using
  any always-set var: `rm -rf ${PWD:+.claude/state/active_task_graph.json}`. The
  guard deletes the span → `rm -rf ` → no guarded literal → **ALLOW**, while bash
  deletes the real state file. Verified against real bash. Exact mirror of the
  round-20 default-word concealment, for the operator family never added to
  `DEFAULT_WORD_OPS`.
- **Fix:** Model alternate forms as `kind:"word"` with `form:"alternate"`. Primary
  (unset) view stays empty — identical to prior behavior, no regression to
  existing bases. Add an `alternateFormsReveal` matching-view flag that reveals
  `w` (the set-state output), threaded recursively through nested reveals. The
  guard's `referencesPattern` tests the alternate-reveal base alongside the
  existing colonless-empty base (cross-product, deduped: 4 collapse variants ×
  substitutions literal/empty). `:?`/`?` error forms stay empty (their word is a
  stderr message, never substituted). Redirect-word evidence mode is unchanged —
  it models the unset view, and alternate-unset IS empty, so it stays consistent.

## Advisory Fixes

### Fix 2: No `.gitattributes` LF-pin on fugue generated `dag.ts`
- **Source:** architecture-tech-lead (cross-repo integrity)
- **File:** fugue repo root (`.gitattributes`)
- **Issue:** Both repos hash raw UTF-8 with no EOL normalization. Fugue ships no
  `.gitattributes`, so a Windows checkout / editor CRLF rewrite of a pristine
  generated file fails the integrity hash. Fail-CLOSED (false tamper flag, never
  a bypass) but erodes trust in the wave gate.
- **Fix:** Add `.gitattributes` pinning generated DAG artifacts + templates to
  `text eol=lf`, making the LF-canonical hash contract explicit.

### Fix 3: `INTEGRITY_RE` unanchored — "banner is topmost" only implicitly enforced
- **Source:** architecture-tech-lead
- **File:** `engine/tests/linter/programmatic/fugue-generated-integrity.test.ts` (golden vector)
- **Issue:** Loom's `INTEGRITY_RE` (`/m`, first-match) relies on the real banner
  sorting first; enforced today by the comment-only-prelude guard but the argument
  is non-local. No regression pin.
- **Fix:** Add a golden test case where the body legitimately contains a
  `// @fugue-integrity sha256:<64hex>` comment line, asserting the top banner still
  governs — locks "first-match = real banner" into the shared vector. Test-only.

### Deferred (pre-existing design, boundary-mitigated — not introduced this branch)

- **loom `HookResult` admits empty-message block/error** — non-emptiness enforced
  at the CLI exit boundary + smart constructors (defense-in-depth); ~15 sites use
  raw literals. Documented deliberate design. Not a regression. Left as-is.
- **fugue `PartialTokenUsage` unbranded** — no non-negative/integer invariant on
  `{tokensIn,tokensOut}`. Pre-existing; producers feed non-negatives. Left as-is.
- **fugue `cli/identifiers.ts` no dedicated test file** — 388 lines covered
  transitively via authored/new/compose tests + a name-accounting drift guard. No
  correctness gap. Left as-is.

## Validation Commands
```bash
cd engine && bun run typecheck && bun test
cd /home/peterstorm/dev/agentic/fugue/packages/framework && bun test
```
