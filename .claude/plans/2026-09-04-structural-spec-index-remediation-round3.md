# Structural Spec Index — review remediation, round 3

Date: 2026-09-04
Branch: `feat/structural-spec-index`
Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260904T125130Z-691137`
Review result: `done` — 4 surviving criticals (all upheld 3–0), 0 refuted, 21 advisories.
Prior run `review-20260904T115614Z-683933` was abandoned (superseded by this run's
registration) after its refutation panel deadlocked on an engine gap.

## Surviving critical findings (mandatory, deduplicated into 2 fixes)

### 1. Fence handling diverges from CommonMark in both directions
(`silent-failure-hunter-1`, `silent-failure-hunter-2`, `comment-analyzer-1`)

`withoutFences` closes a fence on any equal-or-longer same-character marker
line — including lines carrying an info string (`​```yaml`) or trailing content,
which CommonMark classifies as fence **content** — so fenced examples can mint
structural entries with `ok: true` (verified: `OOS-009` minted). The same regex
accepts 4+-space-indented markers as fence toggles, so a well-formed structural
bullet between two indented markers is silently stripped (verified: `FR-002`
dropped).

**Fix**: align with CommonMark in both directions — openers accept a marker
plus optional info string at ≤3 spaces of indentation; closers are
marker-only lines (nothing but whitespace after), same character,
equal-or-longer. JSDoc updated to state the true rule; regression tests for
info-string-inside-fence, trailing-content closers, and indented markers.
Fix also covers 4+-space-indented lines as indented code furniture (literal
code, never spec text) — CommonMark classifies them outside fences.

**Honest correction (authored during red-green):** the two fence regression
tests were first authored against the ROUND-2 outcome (ok:false +
"unterminated code fence") — they passed against the buggy source and failed
against the fix, encoding the bug instead of pinning it. Corrected to assert
the CommonMark-fixed outcome (ok:true, fenced OOS-009 never mints, restored
Out of Scope parses); they now fail against the round-2 source and pass
against the fix. The indented-markers test pins the fixed outcome under both
mechanisms (round-2 fence toggles and indented-code furniture both blank the
bullet in that document), so it is a semantic pin, not a bug discriminator.

### 2. The structural-ID net misses `**`-prefixed and ordered-list lines
(`code-simplifier-1`)

`STRUCTURAL_ID` admits at most one optional bullet character, so `** FR-002:`
and `1. FR-002:` evade the fail-closed net and vanish silently with `ok: true`
while `* FR-002:` and bare `FR-002:` error.

**Fix**: widen the net to bold-asterisk and ordered-list bullet prefixes
(case-insensitive families, optional hyphen), with regression tests
across the entry families. Digit range widened 2–3 → 1–3 to honor the
accepted `type-design-analyzer-2` advisory (`FR-12:`, `AS-1:`), beyond the
2–3 digits named in this fix's original spec.

## Advisory dispositions

Accepted (21) — sound claims with complete in-scope fixes:

- `silent-failure-hunter-3` / `type-design-analyzer-1` empty second Acceptance
  block silently accepted → track block-empty state; error at block close when
  no bullets were collected.
- `silent-failure-hunter-4` / `type-design-analyzer-3` / `pr-test-analyzer-2`
  misplaced structural IDs in non-required sections vanish → document-wide
  fail-closed check scoped to the reserved families (`FR`/`AS`/`OOS`,
  case-insensitive), so `SC`/`NFR` template furniture stays legal.
- `silent-failure-hunter-5` / `comment-analyzer-3` specify.md grep masks exit 2
  and prints per-file counts → existence-check before counting, with the
  per-file semantics stated.
- `pr-test-analyzer-1` fence info-string closer → covered by critical fix 1.
- `pr-test-analyzer-3` glossary prose lines vanish → non-table,
  non-furniture glossary lines now fail closed.
- `pr-test-analyzer-4` property omits glossary → ok:true property extended to
  glossary uniqueness (case-insensitive) + 64-hex hashes.
- `pr-test-analyzer-5` CRLF/CR unasserted → CRLF fixture test added.
- `pr-test-analyzer-6` before-any-block branch untested → bare-ID-before-block
  test added (pins the "under an **Acceptance Scenarios:** block" message).
- `pr-test-analyzer-7` `***`/`___` thematic-break variants untested → tests
  added across the entry-furniture path (also pin that `***` is not a bold ID).
- `type-design-analyzer-2` bullet-less near-miss IDs (`FR-12:`, `AS-1:`) →
  covered by the widened net (critical fix 2) plus regression tests.
- `pr-test-analyzer-2`-class boundary documentation → the document-wide check
  makes the boundary complete rather than documented.
- `comment-analyzer-2` parseGlossary comment understates the case-insensitive
  header skip → reworded.
- `comment-analyzer-4` round-2 record "Accepted (16)" disagrees with its 17
  accepted ids → corrected to 17.
- `architecture-tech-lead-1` specify.md grammar examples unexecuted → the five
  section-grammar examples are assembled and executed through `parseSpec`
  under the contract test (ok:true with the expected IDs).
- `code-simplifier-2` sections() assert-before-validate → named type guard.
- `code-simplifier-3` collected condition written three times → named once.
- `code-simplifier-3` sourceLines has one caller → inlined. **Honest
  correction:** the document-wide reserved-family check gave `sourceLines` a
  second caller, so it was NOT inlined — it earns its keep (deletion test:
  deleting it would duplicate the map logic in two places).
- `code-simplifier-5` withoutFences mutates outer state in a `.map()` callback →
  for-loop accumulation matching the sibling phase machine.

Deferred (unchanged): typed error payloads / discriminated error union; opaque
`SpecEntry`/contentHash correlation — for the spec-check-consumer deepen phase.

## Refuted-finding audit

No critical was refuted. All four surviving criticals were upheld 3–0 across
the reproduction, intent, and blast-radius lenses.

## Validation

Focused parser/property/contract suites, typecheck + unused gates, full-tier
lint, authoritative unit and smoke suites, `git diff --check`.
