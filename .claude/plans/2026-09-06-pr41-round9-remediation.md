# PR 41 Round-9 Remediation Plan

**Branch:** main (PR 41 merged at b50c59c; the changes live on main)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-06-pr41-round9b`
**Frozen scope:** CONTEXT.md, commands/specify.md, engine/src/parsers/index.ts, engine/src/parsers/parse-spec.ts, engine/tests/parsers/parse-spec.property.test.ts, engine/tests/parsers/parse-spec.test.ts, engine/tests/spec-template-contract.test.ts, references/spec-template.md
**Review outcome:** 3 surviving criticals, 16 advisories, 0 refuted. Superseded run 2026-09-06-pr41-round9 (intent-lens verifier mis-copied the finding_id on both attempts → the panel terminalized; the attempt-2 doom-loop fix held: the run blocked loudly instead of re-issuing the spawn).

## Surviving criticals (mandatory)

- **C1 — parseSpec is quadratic in document size** (`engine/src/parsers/parse-spec.ts:303`): `lineAt` re-sliced and re-split the whole document per required-section heading (isolated 10.4 s vs 23.5 ms on identical 766 KB documents). **Fix (landed):** one incremental line-counting pass over the document in heading order — each byte visited once — plus a sorted-range cursor for the document-wide net's membership test (O(1) amortized instead of O(ranges) per line).
- **C2 — the ok:true property tests are vacuous** (`engine/tests/parsers/parse-spec.property.test.ts:36`; mutation-verified: mutating either mint to derive the hash from non-canonical content passes all 104 tests; `fc.string()` reached ok:true 0/20000 samples). **Fix (landed):** a structured valid-spec arbitrary (`validSpecArbitrary`) producing all four sections with whitespace/punctuation noise, so the ok:true-gated property tests actually exercise the success shape; plus the direct hash-distinctness witness for the glossary pair.
- **C3 — specify.md's stale command claim** (`commands/specify.md:228`): the Handoff section instructed `/architecture-tech-lead`, which does not exist (it is a skill). **Fix (landed):** the Handoff now gives the skill invocation this file's own description and Position in flow already give.

## Advisory dispositions

- **A1 (dead barrel re-exports)** — **deferred**: the spec-check consumer (issue #11 phase 3, PR 43 in flight) is the planned consumer of the parse-spec surface; trimming now is churn the consumer supersedes. Revisit when PR 43 lands.
- **A2 (- - marker-run pin)** — accepted: two new tests pin the CONTEXT.md-documented form (section body + acceptance block) with the exact typed error; it takes a distinct code path (entry-not-canonical) from its documented siblings.
- **A3 (trailing-section endLine +1 unpinned)** — accepted: one example test parses a legal spec whose final line is an ID-shaped entry in the document's last section.
- **A4 (glossary hash not injective)** — accepted: the mint now hashes the lossless serialization `JSON.stringify([term, definition])` (the ambiguous join `${term}: ${definition}` mapped `a: b|c` and `a|b: c` to one digest); the property witness is updated and a direct distinctness example added.
- **A5 (specContentHash JSDoc)** — accepted: the canonicalization-before-hashing contract is now stated at the export.
- **A6 (parseSpec JSDoc)** — accepted: the totality/fail-closed contract is now stated at the export.
- **A7 (parseEntries comment ambiguity)** — accepted: the comment now anchors the `STRUCTURAL_ID` JSDoc by name.
- **A8 (duplicate-glossary-term casing)** — accepted: the `SpecParseError` arm now documents that `term` is the en-US-lowercased form.
- **A9 (glossaryEntry JSDoc)** — accepted: the hash derivation (the lossless pair serialization) is now stated at the mint.
- **A10 (specify.md "If count > 3")** — accepted: the combination rule (sum of the per-file counts) is now explicit.
- **A11/A12 (contract-test glossary smoke assertions undocumented)** — accepted: both tests now document the placeholder-glossary-row mechanism they pin.
- **A13 (NonEmpty dead export)** — accepted: the local alias is module-private (the export keyword removed); the `.d.ts` still emits the referenced alias.
- **A14 (NonEmpty redefinition)** — dismissed: converging on the orchestration shared kernel would couple a leaf parser to the orchestration-contract layer (the parser is deliberately self-contained — no cross-boundary imports); the local alias is module-private after A13, and the two structural synonyms' divergence is caught at every use site by the type system.
- **A15 (NonEmpty minting round-trip triplicated)** — accepted: one named `nonEmpty` mint owns the destructure-and-respread construction invariant once.
- **A16 (two near-miss it.each tables)** — accepted: merged into one 17-row matrix (the two load-bearing comments preserved); the case list is the documentation.

## Refuted-finding audit

`refuted_critical_findings` is empty: 0 refuted. The round-9a attempt's findings are recorded in the abandoned run's evidence (superseded by this run).

## Validation commands

- `cd engine && npm run typecheck` — clean
- `cd engine && env -u PI_CODING_AGENT npm run test:unit` — 6166 passed | 1 skipped
- `cd engine && env -u PI_CODING_AGENT npm run test:smoke` — 23/23
- Scoped: `env -u PI_CODING_AGENT bunx vitest run tests/parsers/ tests/spec-template-contract.test.ts --testTimeout=20000` — 201 passed

## Remediation run

A fresh remediation Run Directory under `.claude/reviews/review-and-fix-runs`, `sourceRun` `2026-09-06-pr41-round9b`, with this plan file named in `supportPaths` (it is outside the frozen review scope).
