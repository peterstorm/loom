# Structural Spec Index — review remediation

Date: 2026-09-04
Branch: `feat/structural-spec-index`
Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260904T095630Z-539668`
Review result: `done` — 2 surviving criticals (both upheld 3–0), 0 refuted, 26 advisories.

## Surviving critical findings (mandatory)

### 1. `withoutFences` truncates fence markers to 3 characters (`code-reviewer-1`)

`engine/src/parsers/parse-spec.ts` — the fence regex captures only the first 3
characters of a marker, so a CommonMark fence of 4+ backticks containing a
3-backtick fence closes the outer early and the enclosed example mints real
structural entries (`FR-999` minted with `ok: true`).

**Fix**: capture the full marker (`` `{3,}|~{3,} ``) and close only on an
equal-or-longer marker of the same character; regression tests for the 4-backtick
nested fence and tilde fences.

### 2. `parseSpec` silently drops recognizable ID-bearing lines (`type-design-analyzer-1`)

`engine/src/parsers/parse-spec.ts` — `parseEntries` skips every line not
starting with `-`, so `FR-002: ...` or `* FR-002: ...` vanish silently with
`ok: true`; the same class applies to acceptance-block lines via
`acceptanceScenarioLines`.

**Fix**: error on any line matching the canonical ID syntax without a `- `
bullet, in both `parseEntries` (FR/OOS bodies) and `acceptanceScenarioLines`
(within acceptance blocks); fail-closed tests for both variants.

## Advisory dispositions

Accepted (23) — sound claims with complete in-scope fixes:

- `silent-failure-hunter-1` line numbers never document-absolute → thread
  document-line offsets through `sections()` into all three entry families.
- `silent-failure-hunter-2` only first duplicate named → report every duplicate
  via a shared `duplicates()` helper (merges `code-simplifier-5`).
- `silent-failure-hunter-3` glossary header heuristic silently drops data rows →
  skip only the canonical header shape; error on reserved-term data rows.
- `silent-failure-hunter-4` `grep -c` exit-code footgun in `commands/specify.md`
  → explicit `|| true` with stated semantics.
- `pr-test-analyzer-1..10` additive coverage → multi-block scenarios, glossary
  immutability/hash assertions, empty-collection paths, no-Acceptance-block path,
  duplicate-section path, glossary cell-count errors, tilde fences, barrel export
  test, ok:true ⇒ unique IDs + 64-hex hashes property, duplicate AS/OOS IDs.
- `type-design-analyzer-2` incomplete freeze assertions → same fix as
  pr-test-analyzer-2.
- `comment-analyzer-1` specify skill omits Appendix: Glossary from Key sections
  and Quality Checks → doc fix.
- `comment-analyzer-2` `withoutFences` JSDoc omits the unterminated flag → doc
  comment update (also documents the CommonMark closing rule).
- `architecture-tech-lead-1` contract test never executes the template →
  executable contract test running the fenced template through `parseSpec`.
- `code-simplifier-1..5` behavior-preserving distill → delete the `frozen()`
  pass-through, drop the removable type assertion and dead destructuring
  defaults, unify case normalization, extract the duplicate scan.

Deferred (3) — public-interface redesign belongs to dedicated deepen work in a
later issue #11 phase, when the first programmatic consumer (spec-check
authority) lands:

- `type-design-analyzer-1` (advisory) typed error payloads / discriminated error
  union — changes the parser's public error surface; the non-empty-tuple
  invariant stays per the plan mandate.
- `architecture-tech-lead-2` (advisory) discriminated error union — same fix,
  same deferral.
- `type-design-analyzer-3` (advisory) opaque `SpecEntry` / contentHash
  correlation — public-surface redesign; the plan deliberately returns hashes
  for cache publication.

Dismissed: none.

## Refuted-finding audit

No critical was refuted. The comment-analyzer's rejected attempt-1 findings set
(dropped at admission because `findings[0].file` named the context packet
outside the frozen scope) is audited here: its first claim concerned review
infrastructure outside the reviewed scope and is not fixed; its remaining
claims were re-emitted in attempt 2 and dispositioned above.

## Validation

Focused parser/property/contract suites, typecheck + unused gates, full-tier
lint, authoritative unit and smoke suites, `git diff --check`.
