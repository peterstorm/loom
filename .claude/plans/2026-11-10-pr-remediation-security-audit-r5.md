# PR remediation — PR #156, review campaign 5 (2026-11-10)

- **Branch:** `feat/security-audit-program` (PR #156 → `main`), HEAD `db0dea6c`; `origin/main` (`b8cecd04`) is already merged.
- **Scope:** the whole branch diff against `main` (473 files, ~2.79 MB of diff), reviewed as fifteen
  path-ordered `--files` slices (≤ 205 KB each) because the frozen diff exceeds one reviewer's
  read budget: `.claude/reviews/review-and-fix-runs/run.rf5-s01` … `run.rf5-s15`.
- **Counts (canonical `result.json`):** 0 critical emitted, 0 surviving, 0 refuted, 206 advisory
  (s01 19, s02 12, s03 13, s04 19, s05 13, s06 17, s07 15, s08 14, s09 6, s10 11, s11 13, s12 11,
  s13 15, s14 12, s15 16).
- **Retries:** s05 architecture-tech-lead (attempt 1 refused by admission); s13 code-reviewer,
  silent-failure-hunter and pr-test-analyzer (read coverage incomplete). All attempt 2s admitted.

## Surviving criticals

None. Remediation uses `defectFamily: {"kind": "not-required"}`.

## Refuted criticals

None.

## Advisory dispositions — published (P5, `revision: initial`, provenance DECLARED)

Policy runs `run.rf5-s01-policy` … `run.rf5-s15-policy`. 187 accepted, 17 deferred, 2 dismissed.
Each record carries the per-advisory reason; deferrals and dismissals:

- s01 architecture-tech-lead-3 — **deferred**: Moving the pure evidence and type leaves out of engine/src/machine into core is a package relocation across both bounded contexts; the reviewer notes it is larger than this PR and not a defect. The purity closure test keeps the machine shells unreachable from core meanwhile.
- s01 code-simplifier-5 — **dismissed**: The ADR-0001..0010 index entries were retitled to match each ADR's own heading line exactly (verified against docs/adr/ADR-0001..0010 first lines), so the change corrects drift rather than adding churn.
- s04 type-design-analyzer-1 — **deferred**: CoverageUnit mirrors the vendored coverage-ledger wire shape that the upstream validators read (engine/tests/fixtures/security/upstream); a status-discriminated union is a wire-model redesign already deferred in campaign 4. validateLedger still re-proves every invariant on each transition.
- s04 architecture-tech-lead-2 — **deferred**: Same wire-model redesign as the CoverageUnit union (deferred in campaign 4): the flat record is the vendored ledger shape, and every transition re-runs the whole-ledger validation, so no illegal state escapes.
- s04 architecture-tech-lead-3 — **deferred**: Splitting security-coverage.ts into ledger core plus wire parsers is a pure module reorganisation already deferred in campaign 4; behaviour is unchanged and it belongs with the CoverageUnit redesign.
- s05 architecture-tech-lead-2 — **deferred**: A single span-walker shared by the heredoc layer and shell-quoting changes the shell grammar seam used by the guard, the hook and the subagent-authority fence; walker-divergence tests pin today's agreement. The two in-file duplications (code-simplifier-1, -2) are fixed now.
- s06 architecture-tech-lead-1 — **deferred**: Unifying the shell-segment and interpreter-code helper-grammar recognisers is part of the subagent-authority module split (architecture-tech-lead-2); the file documents that the data path, not this fence, carries authority.
- s06 architecture-tech-lead-2 — **deferred**: Splitting subagent-authority.ts into a line-parsing core and two judgments is a module restructure of a security fence that needs its own review; behaviour is correct and fully tested today.
- s06 code-simplifier-7 — **deferred**: Same subagent-authority.ts split as architecture-tech-lead-2; the reviewer itself routes it to a deepen session.
- s07 architecture-tech-lead-1 — **deferred**: A tagged AuditRefusal union requires every security core to change its error type; describeAuditRefusal still renders an actionable message for every shape today.
- s07 architecture-tech-lead-2 — **deferred**: A RunDirectory port with an in-memory fake reshapes all eleven security-audit operations; the cores are already pure and the commit ordering is documented and tested against the real filesystem.
- s08 architecture-tech-lead-1 — **deferred**: One path-scope module for boundary, purity, switch-totality, exclusions and drift reorganises the whole linter scoping layer; the duplicate projectRelative naming (code-simplifier-4) is fixed now.
- s08 architecture-tech-lead-2 — **deferred**: A shared code-projection lexer for no-io-in-pure-modules and switch-totality is a linter restructure; the concrete fail-open it exposes (template-literal //, silent-failure-hunter-1) is fixed now.
- s08 architecture-tech-lead-3 — **deferred**: Extracting the directory-lock protocol out of no-follow-fs.ts is a large relocation of a security primitive with many callers; behaviour is unchanged and tested.
- s11 architecture-tech-lead-2 — **deferred**: Moving the Pi capture scenarios into their own suite behind a deliverViaPi helper is a test reorganisation with no coverage change; the scenarios pass and exercise the real Pi capture path.
- s11 architecture-tech-lead-3 — **deferred**: Driving machine-purity's closure audit from a data table of audited runtimes redesigns the audit; today a grant with no branch fails closed as an unaudited package.
- s13 architecture-tech-lead-1 — **deferred**: Enabling noUncheckedIndexedAccess repo-wide turns every indexed read into a compile obligation across the engine; that migration is its own change. The regex rule stays the enforcement meanwhile.
- s13 code-simplifier-2 — **dismissed**: The monotone property states the operator-facing contract (raising impact never rejects an accepted finding) as its own named invariant; the redundancy with the exhaustive ladder costs nothing and documents intent.
- s14 architecture-tech-lead-1 — **deferred**: A Loom-owned launch seam for the json-mode child requires replacing the external installed subagent launcher; the gap is documented (ADR-0067 note G) and flagged by unmarkedSubagentLaunchNotice.

## Implementation

Five file-disjoint implementers (core; security-audit core + shell + tests; non-security
handler/orchestration shell; linter/scripts/docs; Pi), then one integration pass. Accepted
findings per group are in the run directories' `result.json`; a fix that cannot be made
complete is reported, not silently skipped.

## Remediation

Registered remediation `run.rf5-remediation`, source `run.rf5-s01` (all fifteen sources carry
zero criticals), every changed path outside that slice's frozen scope named in `supportPaths`.

## Validation

`npm run verify` (root) and `bun scripts/lint-project.ts`.
