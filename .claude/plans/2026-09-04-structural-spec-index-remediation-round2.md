# Structural Spec Index — review remediation, round 2

Date: 2026-09-04
Branch: `feat/structural-spec-index`
Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260904T110733Z-608307`
Review result: `done` — 6 surviving criticals (all upheld 3–0), 0 refuted, 18 advisories.

## Surviving critical findings (mandatory, deduplicated into 3 fixes)

### A. Silent drop outside acceptance blocks (`silent-failure-hunter-1`, `type-design-analyzer-1`)

`acceptanceScenarioLines` gates on `!inAcceptanceBlock` before the
`STRUCTURAL_ID` fail-closed check, so recognizable AS-NNN lines in the User
Scenarios section outside any `**Acceptance Scenarios:**` block (bulleted or
bullet-less) vanish with `ok: true` — the same silent-drop class the prior
panel upheld 3–0.

**Fix**: collect in-block bullets first; error on any structural-ID line that
is not a collected bullet, in or out of block, with document-absolute line
numbers; regression tests for bulleted and bullet-less out-of-block variants.

### B. The canonical template fails its own parser (`architecture-tech-lead-1`)

`parseEntries` treats `---` horizontal rules in FR/OOS bodies as malformed
entry bullets, so every spec copied from `references/spec-template.md` fails
`parseSpec` (verified: `ok: false`, malformed-entry diagnostics at fenced
lines 61 and 102).

**Fix**: shared CommonMark thematic-break predicate (`---`, `***`, `___`) used
by both `parseEntries` (furniture) and `acceptanceScenarioLines` (furniture +
block terminator), so the rule lives in one place.

### C. The remediation record claims a fix that was never implemented
(`comment-analyzer-1`, `architecture-tech-lead-2`, `code-simplifier-1`)

The round-1 plan lists `architecture-tech-lead-1` as an accepted complete
in-scope fix, but `spec-template-contract.test.ts` never imports or calls
`parseSpec` — the record and the artifact were born disagreeing in commit
`59bed1f`.

**Fix**: implement the executable contract test for real (extract the fenced
template, run it through `parseSpec`, assert `ok: true` and the canonical
entry IDs) and append an honest correction note to the round-1 plan record.

## Advisory dispositions

Accepted (16) — sound claims with complete in-scope fixes:

- `pr-test-analyzer-2` ok:true ⇒ unique IDs + 64-hex hashes property → added.
- `pr-test-analyzer-3` same-character fence-closing rule unpinned → test added.
- `pr-test-analyzer-5` glossary empty-cell error path → test added.
- `pr-test-analyzer-6` case-insensitive glossary dedup → test added.
- `pr-test-analyzer-4` outside-block window untested → covered by fix A tests.
- `type-design-analyzer-2` `parseGlossary` skips non-table structural lines →
  structural-ID check applied to non-table glossary lines.
- `comment-analyzer-2` `duplicates()` JSDoc ambiguous → reworded (first
  duplicate occurrence order).
- `comment-analyzer-3` `parseGlossary` comment understates the skip set →
  reworded.
- `comment-analyzer-4` specify.md grep comment inverted → reworded with correct
  grep exit semantics (1 = zero markers, 2 = no spec dirs).
- `comment-analyzer-5` reserved-term claim over-broad → qualified to data rows.
- `comment-analyzer-6` withoutFences JSDoc invites assuming full CommonMark
  compliance → one sentence noting detection accepts any leading whitespace.
- `code-simplifier-2` SectionName/REQUIRED_SECTIONS two representations →
  union derived from the array.
- `code-simplifier-3` inAcceptanceBlock/foundBlock illegal state → one phase
  state machine (incorporated into fix A's rewrite).
- `code-simplifier-4` four call sites repeat the missing-section fallback →
  one `sectionLines()` helper; all entry families take `SourceLine[]`.
- `code-reviewer-1`, `type-design-analyzer-3`, `pr-test-analyzer-1` receipt
  completeness → resolved by fix C (the executable contract test now exists).

Dismissed (1):

- `code-simplifier-5` parseSpec tail guard+cast — the cast-free head/tail
  destructure honors the loaded "avoid type assertions" rule; the non-empty
  tuple invariant is satisfied without a cast.

Deferred: typed error payloads / discriminated error union, opaque
`SpecEntry`/contentHash correlation — unchanged from round 1, for the
spec-check-consumer deepen phase.

## Refuted-finding audit

No critical was refuted. All six surviving criticals were upheld 3–0 across
the reproduction, intent, and test-coverage lenses.

## Validation

Focused parser/property/contract suites, typecheck + unused gates, full-tier
lint, authoritative unit and smoke suites, `git diff --check`.
