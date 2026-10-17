# PR #100 remediation, round 1: the I6 era ADT

- **Branch:** `refactor/i6-era-sum-type` → `main` (PR #100)
- **Date:** 2026-10-17
- **Workflow:** `/loom:review-and-fix 100`
- **Scope:** the whole PR diff, one slice of 10 files and about 28 k units.
- **Review run:** `rf-20261017-pr100-r1`. Runs root: `.claude/reviews/review-and-fix-runs`.
- **Reviewers:** 7. All 7 were admitted.
- **Retry:** the comment-analyzer's first payload was refused as not conforming to the v2 schema (`"basis": null` on advisories). Its second attempt was admitted. The first attempt's points are covered by the admitted comment-analyzer-1 fix: the overclaimed "only reader" wording, and the legacy freezer's deliberately wider type.

## Criticals

No critical survived and none was refuted. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (5: 3 accepted, 2 dismissed)

Policy run `rf-20261017-pr100-r1-policy` was published before any edit. Disposition digest: `e35fe3cf2d8c09d9a2abc9c8bba142fa3f3fcf454f187d0669705c645e4d9ec7`. Provenance: `DECLARED`, initial revision.

| Finding | Decision | Reason |
|---|---|---|
| comment-analyzer-1 | accepted | Wording narrowed everywhere it overclaimed: frozenRedThenGreenEra is the one reader outside the freezer that parses and digests the field (verification-manifest.ts); "every freezer" becomes "every post-feature freezer", with legacyDefaultVerificationManifest named as deliberately wider; the lint rule now "refuses these inline forms", not every form. |
| architecture-tech-lead-1 | accepted | The two named bypasses are closed: the INV-6 pattern now also refuses destructuring of testFiles and bracket access, with table-test pins; no production false positives. Making the field type-opaque outside the owners would change FrozenVerificationManifest for the parser, state-file-wire and every test fixture, so the docs now call the regex a backstop rather than claim the type owns it. |
| code-simplifier-1 | dismissed | Letting the per-arm builders return the narrowed type directly needs a conditional return type TypeScript cannot check without an `as` cast, which the reviewer itself makes the condition and the rules forbid; the one spread-and-refreeze keeps the narrowing compiler-checked. |
| code-simplifier-2 | dismissed | The not-owed era is the shared frozen constant PRE_I6_ERA, so only the owed arm allocates; deriving RedThenGreenEra from the union's kind is the single source the reviewer endorses, and the reviewer judges the current form acceptable. |
| code-simplifier-3 | accepted | testFilesOf is inlined at its one call site, and the compile-time Equal pins say the typecheck is the real check. |

## Accepted fixes (as implemented)

- **Wording.** The doc comment in `proof-obligations.ts`, the ADR-0025 amendment and the lint rule description no longer overclaim:
  - `frozenRedThenGreenEra` is described as the one production reader outside `verification-manifest.ts`, which parses, freezes and digests the field;
  - "every freezer" now reads "every post-feature freezer", and `legacyDefaultVerificationManifest` is named as deliberately wider;
  - the lint rule is described as a backstop.
- **INV-6 rule.** The rule now also refuses destructuring of the field (`{ testFiles } = …`) and bracket access (`["testFiles"]`). The Claude and Pi copies are byte-identical, the table test pins both forms, and the pattern matches no production code.
- **Era matrix test.** `testFilesOf` is inlined at its one call site, and a comment says the compile-time `Equal` pins are the real check.

## Dismissed

- **code-simplifier-1.** The narrowing would need an unchecked `as` cast.
- **code-simplifier-2.** The not-owed arm is a shared constant, and the reviewer itself judged the current form acceptable.

## Remediation registration

A schema-v2 remediation sourced on `rf-20261017-pr100-r1`, with `defectFamily: {"kind":"not-required"}`. `supportPaths` holds this plan.

## Validation

`npm run verify` (root), run from the repository root.
