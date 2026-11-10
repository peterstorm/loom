# PR remediation — PR #156, review campaign 4 (2026-11-09)

- **Branch:** `feat/security-audit-program` (PR #156 → `main`), merged with `origin/main` (`b8cecd04`) first.
- **Scope:** the whole branch diff against `main` — 206 files, ~1.92 MB of diff — reviewed as ten
  `--files` slices (≤ 210 KB each, path-ordered) because the frozen diff exceeds one reviewer's
  read budget: `.claude/reviews/review-and-fix-runs/run.rf4-s01` … `run.rf4-s10`.
- **Counts (canonical `result.json`):** 0 critical emitted, 0 surviving, 0 refuted, 149 advisory
  (s01 9, s02 15, s03 25, s04 16, s05 13, s06 17, s07 11, s08 16, s09 17, s10 10).
- **Retries:** s01 code-reviewer (attempt 1 spent by a malformed spawn prompt — the parent's
  transcription error, the reviewer correctly refused to review without its task); s10
  code-reviewer and code-simplifier (read coverage incomplete), s10 type-design-analyzer (schema).
  All attempt 2s were admitted.

## Surviving criticals

None. Remediation uses `defectFamily: {"kind": "not-required"}`.

## Refuted criticals

None.

## Advisory dispositions — published (P5, `revision: initial`, provenance DECLARED)

Policy runs `run.rf4-s01-policy` … `run.rf4-s10-policy`. 142 accepted, 6 deferred, 1 dismissed.

Deferred (each with its recorded reason):
- s03 architecture-tech-lead-1 — split `security-coverage.ts` into ledger core + wire volume.
- s03 type-design-analyzer-2 — `CoverageUnit` as a status-discriminated union (vendored wire shape).
- s02 architecture-tech-lead-4 — per-effect-kind descriptor table in `orchestration-contract/effects.ts`.
- s06 architecture-tech-lead-2 — switch-totality on the TypeScript AST (its fail-open holes fixed now).
- s06 architecture-tech-lead-5 — table-driven Evidence kind model.
- s09 architecture-tech-lead-3 — hunter machine terminal phase on a program-owned fact.

Dismissed: s10 architecture-tech-lead-2 — the script↔engine receipt contract test already exists
(`security-sandbox.test.ts` runs the script and parses with `parseSandboxReceipt`).

## Implementation

Four file-disjoint agents (security core; shell grammar/linter/machine; handlers/orchestration/
stores; Pi/scripts/docs/tests) plus one integration pass for cross-owner follow-ups. Notable
behaviour changes recorded in ADR-0067's notes and `docs/security-audit.md`: receipt `loopbackUp`
fact; scope as a tree/diff union; one LocalCheck parser for wire and ledger; existing findings
pinned against consolidation displacement; Pi import gate runs the persisted proof only; Pi
unmarked-launch notice; switch-totality lexer (comments/strings, same-line default proofs);
SandboxRun minted only from a parsed same-segment invocation; `file` removed from read-only
commands; CI ubuntu leg runs the sandbox for real (`LOOM_REQUIRE_SANDBOX=1`).

## Remediation

Registered remediation `run.rf4-remediation`, source `run.rf4-s01` (all ten sources carry zero
criticals; one install covers the whole candidate), every changed path outside that slice's
frozen scope named in `supportPaths`.

## Validation

`npm run verify` (root): typecheck, 668 test files / 17,030 passed / 2 skipped, all six smokes;
`bun scripts/lint-project.ts`: 0 violations, no new baseline entries.
