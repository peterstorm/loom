# PR Remediation Round 6 — 2026-09-04 (PR #41, review over `30e06e1`)

- **Branch:** `feat/structural-spec-index` (worktree `/home/peterstorm/dev/claude-plugins/loom-structural-spec-index`, head `30e06e1`)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260904T172138Z-17621` (7 reviewers captured, 3 refutation verifiers — reproduction / intent / blast-radius — all upheld; canonical `result.json` digest `0dbf2418…`)
- **Reviewed scope (frozen):** `engine/src/parsers/parse-spec.ts`, `engine/src/parsers/index.ts`, the three test suites, `references/spec-template.md`, `commands/specify.md`, `CONTEXT.md`, 6 plan records (phase 1 + remediation rounds 1–5)
- **Result:** 2 surviving criticals (both the same hole, upheld 3–0), 0 refuted, 22 advisories (20 distinct — comment-analyzer-6/-7 are extractor duplicates of -1/-3) — deduplicated into 1 critical fix and 18 accepted advisories.

## Surviving critical findings (mandatory)

### Fix 1 — Exactly-`###`-prefixed structural IDs inside User Scenarios vanish silently (code-reviewer-1, type-design-analyzer-1 — same hole, independently verified)

`engine/src/parsers/parse-spec.ts:266` — in `acceptanceScenarioLines`, the `/^###\s+/u` block-terminator branch `continue`s **before** the STRUCTURAL_ID fail-closed check. `sections()` splits only on `^##\s+` (three hashes never truncate the body), so a `###`-prefixed structural ID stays inside the User Scenarios collected range and the document-wide net skips it. Verified by execution (three probes):

- `### AS-999:` after a collected acceptance block → `ok: true`, scenarios `[AS-001]` — AS-999 gone.
- `### AS-999:` in the narrative region before the block → `ok: true`, silently vanishes.
- `### FR-001:` (duplicate family) inside User Scenarios → `ok: true`, vanishes without dedup seeing it.
- Contrast: `##` is caught (document-wide net — the body truncates onto the section boundary), `####` is caught (STRUCTURAL_ID — `/^###\s+/u` doesn't match four hashes). The hole is exactly `###`.

**Concrete fix (one-owner move, preserves block-termination semantics):** in the `###`/thematic-break branch, fail closed on a `###`-prefixed structural ID before the terminator behavior — check `STRUCTURAL_ID.test(raw)` when `/^###\s+/u` matched, pushing the same diagnostics as the existing check (`state.kind === "inside"` → `must be a "- ID: content" bullet`, else the `under an **Acceptance Scenarios:** block` variant), keeping the block-termination semantics. Legitimate `### US1: [P1] …` headings are unaffected (family must be fr|as|oos immediately followed by digits and a colon); thematic breaks never match STRUCTURAL_ID so their behavior is unchanged.

**Pin with regression tests authored red:** `### AS-999:` after a collected block (ok:true today), `### AS-999:` in the narrative region (the ID vanishes without a structural-ID diagnostic), `### FR-001:` duplicate family (ok:true today).

## Advisory dispositions

| # | Advisory | Disposition | Reason |
|---|----------|-------------|--------|
| code-reviewer-2 | `***`-prefixed structural IDs evade the net | **accepted** | Sound, verified by execution; extend the prefix alternation `\*\*` → `\*{1,3}` (bold-italic/thematic-break-with-content form) + red `*** AS-999:` regression test |
| code-reviewer-3 | Round-5 Fix 1's demanded acceptance-block and OOS stray-variant coverage not delivered | **accepted** | Sound; folded into Fix 1 — the exactly-`###` acceptance-block and OOS pins discriminate the critical hole rather than pass against it |
| silent-failure-hunter-1 | Colon-less variant (`FR-002 content without a colon`) vanishes | **accepted** | Document the boundary honestly: scope the JSDoc promise to the enumerated colon-bearing syntax, document the colon as the deliberate prose-disambiguation boundary (colon-less ID-shaped lines are plausible prose — "FR-002 and FR-003 are related"), pin the vanishing as intentional with a regression test (the hunter's own defensible option; widening would fail-close plausible prose) |
| silent-failure-hunter-2 | Dot-separator (`FR.002:`) and in-family-space (`F R-002:`) variants vanish | **accepted** | Widen the separator `[\s-]*` → `[\s.-]*` (catches the one-character dot typo — safe direction; prose without a colon stays legal) + document the family-contiguity boundary (`F R-002:` is prose — the family token must be contiguous) + pin both variants |
| pr-test-analyzer-1 | No lone-CR line-ending test | **accepted** | Verified correct by execution; small in-scope pin |
| pr-test-analyzer-2 | No tab-indented fence-marker-at-4+-columns test | **accepted** | Verified correct by execution; small in-scope pin |
| pr-test-analyzer-3 | No mixed space-plus-tab leading-indentation twin test | **accepted** | Verified correct by execution; small in-scope pin |
| type-design-analyzer-2 | Glossary contentHash preimage asymmetry | **deferred** | Round-4/5 documented deferral for the spec-check-consumer deepen phase; interface change beyond this PR's boundary |
| type-design-analyzer-3 | Family-agnostic SpecEntry (cross-collection mixing) | **deferred** | Interface change (family-branded IDs) — for the spec-check-consumer deepen phase with the other public-interface work |
| type-design-analyzer-4 | Stringly-typed error payloads | **deferred** | Documented round-1/4/5 deferral — for the spec-check-consumer deepen phase |
| comment-analyzer-1 | JSDoc "optional space before the colon" vs `\s*:` | **accepted** | Reword to "zero or more whitespace before the colon" |
| comment-analyzer-2 | JSDoc promise broader than the net (nested bullets, spaced ordered markers) | **accepted** | Scope the promise to the enumerated syntax — the meta-fix that stops unbounded near-miss chasing |
| comment-analyzer-3 | THEMATIC_BREAK JSDoc "spaces" vs `\s*` tabs | **accepted** | Reword to "whitespace" |
| comment-analyzer-4 | parseEntries inline comment enumerates only "bare, bold, or ordered-list" | **accepted** | Drop the enumeration — the JSDoc above owns the full accepted prefix set |
| comment-analyzer-5 | Glossary comment lists only thematic breaks; blank lines also skipped | **accepted** | Reword to "Thematic breaks and blank lines are furniture." |
| comment-analyzer-6 | Duplicate of comment-analyzer-1 (extractor duplicate) | **accepted** | Subsumed by the comment-analyzer-1 fix |
| comment-analyzer-7 | Duplicate of comment-analyzer-3 (extractor duplicate) | **accepted** | Subsumed by the comment-analyzer-3 fix |
| architecture-tech-lead-1 | Non-ID bullets outside an acceptance block vanish (three treatments of one shape) | **accepted** | Document the asymmetry at the seam (`acceptanceScenarioLines` JSDoc: outside-block non-ID bullets pass as narrative furniture; FR/OOS are entry-only so any bullet errors) + pin with a regression test |
| code-simplifier-1 | Misplaced-reserved-family-ID test exists twice byte-for-byte | **accepted** | Delete the standalone `it`, keep the `it.each` row (identical markdown, same diagnostic) — distill move |
| code-simplifier-2 | RESERVED_FAMILY_ID alias is a pass-through with one caller | **accepted** | Delete the alias, reference `STRUCTURAL_ID` directly at the document-wide net, keep the call-site comment; anti-drift binding unchanged (one constant, both nets reference it directly); add a one-line round-7 note to the round-4 record. Note: round-5's simplifier left the alias alone as deliberate — round-6's deletion test (one caller, complexity vanishes) cuts in favor; the disagreement is recorded here |
| code-simplifier-3 | Collection guard re-derives isCollectedBullet by hand | **accepted** | `if (!isCollectedBullet(raw)) continue;` is behavior-identical (the De Morgan negation of the guard, with `line = raw.trim()`) — the collection rule stated once — distill move |
| code-simplifier-4 | 'two-digit bare' (FR-02:) and 'two-digit hyphenated' (FR-12:) rows exercise the same equivalence class | **accepted** | Merge to one row: keep `FR-12:` (round-3 named it), relabel honestly ("two-digit ID"), delete the `FR-02:` row — same fail-closed path, labels promised a distinction the regexes do not have |

**Dismissed:** none.

## Refuted-finding audit

None — the refutation panel (reproduction / intent / blast-radius) upheld both criticals 3–0; `refuted_critical_findings` is empty.

## Accepted advisory fixes (concrete)

1. **Fix 1 fold-in:** exactly-`###` acceptance-block pin (`### AS-999:` after a collected block), narrative-region pin, duplicate-family pin, and an OOS `### AS-999:` pin — red-authored against the current source.
2. **`***` prefix:** prefix alternation `\*\*` → `\*{1,3}` + red `*** AS-999:` regression test.
3. **JSDoc/comment alignment:** "zero or more whitespace before the colon"; scope the near-miss promise to the enumerated syntax; THEMATIC_BREAK "whitespace"; drop the parseEntries inline enumeration; glossary comment "Thematic breaks and blank lines are furniture."
4. **Boundary documentation:** colon requirement (JSDoc + CONTEXT.md Spec Index entry) and family-contiguity boundary documented as deliberate, with pinned intentional-vanishing regression tests (`FR-002 content without a colon`, `FR.002:`, `F R-002:`) — plus the `[\s.-]*` widening for the dot typo.
5. **New test pins (verified correct by execution):** lone-CR line endings; tab-indented fence marker at 4+ columns; mixed space-plus-tab leading indentation.
6. **Seam documentation:** `acceptanceScenarioLines` JSDoc states the outside-block bullet asymmetry; pinned.
7. **Distill moves:** delete the byte-for-byte duplicate standalone misplaced-reserved-family-ID test; delete the RESERVED_FAMILY_ID alias (direct reference + round-4 record note); `!isCollectedBullet(raw)` collection guard; merge the two-digit near-miss rows to one honest row.

## Support paths (not in reviewed scope)

- `.claude/plans/2026-09-04-pr-remediation-round6.md` (this plan)

## Validation commands

```bash
cd engine
env -u PI_CODING_AGENT vitest run tests/parsers/parse-spec.test.ts tests/parsers/parse-spec.property.test.ts tests/spec-template-contract.test.ts --testTimeout=15000
npm run typecheck
env -u PI_CODING_AGENT vitest run --testTimeout=15000 --maxWorkers=4   # authoritative unit suite
bun scripts/lint-project.ts engine/src/parsers/parse-spec.ts engine/tests/parsers/parse-spec.test.ts
git diff --check
```

Regression tests are authored red first (watched fail against `30e06e1`), then fixed green. Stop without staging or committing if validation cannot pass.
