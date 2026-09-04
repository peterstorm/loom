# Structural Spec Index — review remediation, round 4

Date: 2026-09-04
Branch: `feat/structural-spec-index`
Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260904T144932Z-108374`
Review result: `done` — 7 surviving criticals (all upheld 3–0 across the reproduction,
intent, and test-coverage lenses), 0 refuted, 17 advisories.
Prior run `review-20260904T140530Z-100487` was abandoned (superseded by this run's
registration) after its refutation panel deadlocked on the loom engine gap — filed as
https://github.com/peterstorm/loom/issues/42 (terminally-rejected slots never advance;
the resume path re-emits attempt-1 forever). This run completed cleanly after the two
`no-final-payload` reviewer slots advanced to attempt 2 via the roster's resume path.

## Surviving critical findings (mandatory, deduplicated into 2 fixes)

### 1. Backtick-fence info-string openers are treated as fences (6 reviewers, 3–0)

`withoutFences` opens a fence on any 3+-backtick line regardless of its info string
(`engine/src/parsers/parse-spec.ts:104-105`). CommonMark §4.5: info strings for
backtick code blocks may not contain backticks — a line like ```` ``` `snippet` ````
is paragraph text, not a fence. The parser opens a fence there, blanks the enclosed
well-formed structural bullet, and returns `ok: true` — the exact silent-drop class
upheld 3–0 in rounds 1–3. Verified by execution on the frozen probe document
(`engine/tests/parsers/zz-probe.test.ts`): `ok: true` with only FR-001; FR-002 vanished.
The scope's own probe documents the edge and pins nothing (assertion-free leftover).

**Fix**: in `withoutFences`, a backtick marker line whose info string contains a
backtick is paragraph text — never a fence opener or closer (the closer branch already
requires marker-only). Under the fix the probe document fails closed with an
unterminated code fence and FR-002 is real content. Pin with a regression test
authored red against the buggy source; delete the untracked probe file; update the
JSDoc to state the true rule.

### 2. Blanket 4+-space blanking drops lazy-continuation structural IDs (upheld 3–0)

`withoutFences` blanks every 4+-space-indented line outside a fence as "indented code
furniture" (`engine/src/parsers/parse-spec.ts:99`). CommonMark: an indented code block
cannot interrupt a paragraph — a 4+-space-indented line directly after a non-blank line
is a lazy continuation, i.e. real content. A `- FR-001: …` bullet followed directly by
`    - FR-002: …` parses `ok: true` with FR-002 silently dropped; the same blanking
defeats the document-wide net's "never vanish" claim for indented preamble bullets.
Verified by execution.

**Fix**: blank a 4+-space-indented line only when it constitutes true indented code —
the previous line is blank, a fence line, or the start of the document; lazy
continuations flow through to the fail-closed nets. Scope the JSDoc and net doc to the
true rule (genuine indented-code furniture may contain ID-shaped text that is never
spec text). Regression tests for the lazy-continuation variant (collected) and the
true-indented-code variant (inert).

## Advisory dispositions

Accepted — sound claims with complete in-scope fixes:

- `zz-probe.test.ts` assertion-free probe (6 reviewers) → deleted; the case it probes
  is pinned by the round-4 regression test in `parse-spec.test.ts`.
- `STRUCTURAL_ID`/`RESERVED_FAMILY_ID` byte-identical duplication (4 reviewers) → one
  pattern constant derived once, both nets reference it; drift is prevented
  structurally by the binding — the alias is module-private, so no suite
  assertion pins the equality, and none is needed.
- `STRUCTURAL_ID` JSDoc omits the ordered-list prefix (comment-analyzer) → merged JSDoc
  states the full accepted prefix set.
- specify.md "Exactly one spec must exist" overstates the at-least-one `ls` check
  (comment-analyzer) → reworded to "At least one spec must exist before counting".
- specify.md grep `|| true` masks exit 2 (silent-failure-hunter) → mask only the
  zero-marker exit; exit 2 aborts with grep's stderr visible.
- `THEMATIC_BREAK` comment trim dependency (comment-analyzer) → noted in the comment.
- code-simplifier distill moves → acceptanceScenarioLines block state as a
  discriminated union; empty-block diagnostic stated once; `lineAt` helper in
  `sections()`; `lower()` helper in `parseGlossary`.

Deferred (unchanged): typed error payloads / discriminated error union; opaque
`SpecEntry`/contentHash correlation; barrel type exports — for the spec-check-consumer
deepen phase.

## Validation

Focused parser/property/contract suites, typecheck + unused gates, full-tier lint on
changed files, authoritative unit and smoke suites, `git diff --check`.
