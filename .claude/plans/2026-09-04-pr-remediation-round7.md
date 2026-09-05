# PR #41 Remediation Plan — Round 7

**Branch:** `feat/structural-spec-index` · **Baseline:** `87cea56` · **Review run:** `review-20260904T202844Z-52167`
**Found:** 24 findings from 7 reviewers — 7 surviving criticals (3 distinct holes), 0 refuted, 20 advisories (18 distinct; 2 extractor duplicates).

## Surviving criticals

### A. Record-vs-artifact: the round-6 record claims work that does not exist (SFH-2, CA-1, CA-2, CA-3, ATL-1 — one hole, five lenses, upheld 3–0)
The round-6 record claims (a) three pinned intentional-vanishing regression tests (`FR-002 content without a colon`, `FR.002:`, `F R-002:`) that were never authored, (b) an `acceptanceScenarioLines` JSDoc that does not exist (the asymmetry is an inline comment above `scenarios.push`), and (c) the `!isCollectedBullet(raw)` collection-guard distill that was not applied. The record and the artifact were born disagreeing — the exact class this feature has twice upheld 3–0.

**Fix:** author the three boundary pins (colon-less → `ok: true` with only the sibling entry; `F R-002:` → `ok: true`; `FR.002:` → `ok: false` via the widened `[\s.-]*` net — the record also misclassified it as an intentional vanishing), convert the asymmetry comment into a proper JSDoc on `acceptanceScenarioLines`, and append an honest correction note to the round-6 record. The `!isCollectedBullet` move is **not** re-applied: round 6 attempted it and reverted it because it broke TypeScript narrowing (`TS2339` — the helper returns `boolean`, not a type predicate, so `state.headerLine` no longer narrows); the correction note documents that, and the guard keeps the hand-derived De Morgan form.

### B. Spaced nested blockquote IDs vanish silently (TDA-1 critical + TDA-2 advisory), verified by execution in five placements
`> > FR-002: System MUST be recognized` returns `ok: true` with zero errors in the FR body, OOS body, acceptance block, narrative region, and non-required sections: `STRUCTURAL_ID`'s `>+` alternative matches only contiguous `>`-runs, and after its `\s*` the family faces the second `>`, while the empty-prefix alternative fails at the leading `>`. The same class covers nested bullets (`- -` errors via `parseEntries` while `* *` vanishes) and spaced ordered markers (`1. 2.`).

**Fix (total, one-owner):** unify the prefix into one marker-run class — `^\s*(?:(?:[#>*+-]|\d+[.)])\s*)*` — covering spaced nested blockquotes, nested bullets, bold asterisks (`***`), spaced ordered markers, and mixed runs (`> -`), strictly more total than the enumerated alternation (which it also simplifies: `\*{1,3}`, `[*+-]`, `>+`, `#+` collapse into the class). Update the JSDoc to enumerate the run forms. Red-authored regression pins: `> > FR-002:` (FR body), `> > AS-999:` (after a collected block), `* * FR-002:`, `1. 2. FR-002:`, `> - FR-002:`. The colon and contiguous-family prose boundary is intact (verified: colon-less and spaced-family forms still parse legal).

### C. The `[\s.-]*` dot-separator widening ships unpinned (SFH-1)
Round-6 accepted fix item 4 delivered the widening — the fail-closed fix for `FR.002:` — but none of the pins it demanded. A revert would silently reintroduce the `FR.002:` vanishing hole with `ok: true`.

**Fix:** author the red/green pin (`FR.002: System MUST be recognized` → `ok: false` today), with the counterfactual documented in the test comment.

## Advisory dispositions (20 — all accepted; 4 duplicates of one hole subsumed)

| Advisory | Disposition |
|---|---|
| SFH-3 / PTA-1 / CA-4 / ATL-2 — outside-block pass side unpinned (4 duplicates) | ACCEPT: one pass-side pin (narrative bullet outside a block → `ok: true`, not collected) |
| PTA-2 — `+`-bullet and close-paren `1)` prefix variants unpinned | ACCEPT: two rows in the section-body matrix |
| PTA-3 — bold-asterisk in-block stray unpinned | ACCEPT: one row in the acceptance-block matrix |
| PTA-4 — glossary furniture (thematic break between rows) unpinned | ACCEPT: one pin (furniture with a real row after it minting) |
| PTA-5 — tab-indented closer inside an open fence unpinned | ACCEPT: one pin (fence stays open → unterminated → fail closed) |
| PTA-6 — no suite reads CONTEXT.md | ACCEPT: one test reading CONTEXT.md and pinning the Spec Index entry's colon boundary |
| TDA-2 — nested-bullet marker asymmetry | ACCEPT: subsumed by Fix B's unified run class + pins |
| CA-5 — JSDoc under-covers depth-1 blockquote | ACCEPT: subsumed by Fix B's JSDoc reword ("one or more markers") |
| ATL-3 / CA-3 — distill-move claim | ACCEPT via the record correction note (narrowing) |
| code-simplifier-1 — `strayIdError` states its shared prefix twice | ACCEPT: single template with a conditional suffix (byte-identical output) |
| code-simplifier-2 — `nextHeadingLine` lies in the last-section branch | ACCEPT: rename to `endLine` (the load-bearing `+1` survives) |
| code-simplifier-3 — `expandLeadingTabs` reassigns its input | ACCEPT: leading-run match + fresh-string build (reviewer-verified byte-equivalent over 19,683 inputs) |
| code-simplifier-4 — dead `?? ""` on the fence info string | ACCEPT: drop the fallback (group 2 is mandatory) |
| code-simplifier-5 — dead undefined guard on the heading capture | ACCEPT: drop the guard (group 1 is mandatory; both forms typecheck) |
| code-simplifier-6 — dead true-branch in the contract test's fence extraction | ACCEPT: `.map((match) => match[1])` |
| code-simplifier-7 — same-equivalence-class near-miss rows | ACCEPT: one representative per class (spaced-separator trio, colon-space pair, digit-run pair) |
| code-simplifier-8 — two info-string-closer tests are one class | ACCEPT: merge into one `it.each` with two rows |

**Deferred (unchanged, respected by all seven reviewers — not re-emitted):** typed error payloads, family-branded `SpecEntry` IDs, hash↔content smart constructor, parser barrel type exports — documented deferrals for the spec-check-consumer deepen phase.

## Implementation order (red-green)

1. Author the five red regression pins (spaced nested blockquote ×2, nested bullet, spaced ordered markers, mixed marker run) — watch them fail against `87cea56`.
2. Fix `STRUCTURAL_ID` + JSDoc (Fix B); author the green boundary pins, pass-side pin, PTA-2/3/4/5/6 pins, and the CONTEXT.md binding test; apply the distill moves and equivalence-class merges; add the `acceptanceScenarioLines` JSDoc; append the round-6 record correction note and the CONTEXT.md family-contiguity note.
3. Validate: focused suites, `npm run typecheck` + unused gates (checked via exit codes, not `tail` chains), authoritative unit suite, full-tier lint on changed files, `git diff --check`.
4. Register the remediation with `supportPaths = [this plan]`, commit, push, update the PR body.

## Scope (frozen, from the review packet)

15 files: `engine/src/parsers/parse-spec.ts`, `engine/src/parsers/index.ts`, the three test suites, `references/spec-template.md`, `commands/specify.md`, `CONTEXT.md`, and the 7 plan records. Changed this round: `parse-spec.ts`, `parse-spec.test.ts`, `spec-template-contract.test.ts`, `CONTEXT.md`, the round-6 record, this plan.
