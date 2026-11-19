# PR #244 Remediation Plan — {builtAt}/{hot} false-positive curation

**Branch:** `fix/template-false-positives` (head `650e2fcf`)
**Review run:** `.claude/reviews/review-and-fix-runs/pr244-tfp-review-1795083320` (result digest `1217d9da5f36f2c3d54e1024880ed180a37410e95d2d87fccb75f16d291e7315`)
**Disposition publication:** `.claude/reviews/review-and-fix-runs/pr244-tfp-disposition-1795083855` (14 entries: 12 accepted / 2 deferred / 0 dismissed)
**Scope (frozen review scope):** `engine/src/core/validate-template-substitution.ts`, `engine/tests/handlers/pre-tool-use/validate-template-substitution.test.ts`, `docs/feature-guard-map.md`

## Surviving criticals

None (0 surviving / 0 refuted). Defect family: `not-required`.

## Accepted advisory fixes (this revision)

One coherent revision, three edits:

1. **Single-owner exemption knowledge** (TDA-3, ATL-1, CS-1, SFH-2): export `FALSE_POSITIVES` from the module; the property test derives its exclusion filter from the exported set (bare name ∩ generator grammar `/^[a-z][a-z0-9_]{3,15}$/`), deleting the hand-synced lowercase copy and its three dead entries (`id`, `hot` below the 4-char minimum; `builtat` a case-miss of the camelCase entry). Case-variant coverage is retained by construction: `{builtAt}`'s bare name is not grammar-producible, so generated lowercase near-misses stay in the property space and must block.
2. **Premise pin** (SFH-1, PTA-1, TDA-1): new test sweeping the /loom template corpus (`commands/**` recursive + the engine brief template source `engine/src/core/implementation-brief.ts`) asserting neither `{builtAt}` nor `{hot}` occurs in any template — a future adoption fails CI loudly instead of silently exempting an unsubstituted variable.
3. **Exact-token case pin** (PTA-2, TDA-4): assert `{builtat}` (lowercase) blocks — the exemption is exact-token, case-sensitive.
4. **Comment honesty** (CA-1, CS-2): reword the set's doc comment to classify separately — `{builtAt}` a rendered-output literal, `{hot}` a code-notation (set) literal; trim the `{builtAt}` test comment to the one fact title+module comment lack (population copies the prose into briefs) and give `{hot}` the same one-liner.
5. **Guard-map pointer** (TDA-5): the §guard-table row names the owning constant.

## Deferred (not implemented here)

- **TDA-2** (validated entry type at construction): construction-boundary redesign; per-entry allow-tests pin wellformedness today.
- **ATL-2** (context-anchored exemption matching): detector redesign; latent risk only, premise pinned by the corpus sweep.

## Refuted findings

None.

## Validation

- Scoped: `bunx vitest run engine/tests/handlers/pre-tool-use/validate-template-substitution.test.ts` (from `engine/`) must stay green with the new assertions.
- CI matrix judges the full verify.
- Registered remediation: `defectFamily: {kind:"not-required"}`; supportPaths carries this plan file.
