# PR 131 remediation: G5b owner-map enforcement

Branch `feat/g5b-owner-enforcement`, reviewed head `5237ec91`. The frozen diff exceeded one reviewer's budget, so it was reviewed as five registered slices under `.claude/reviews/review-and-fix-runs` (the empty `review-fix-20261025-pr131` registration was never started).

| Slice | Review run | Emitted/admitted | After refutation | Policy run | Disposition digest |
|---|---|---|---|---|---|
| core | `pr131-s1-core-20261025` | 0 critical, 19 advisory | 0 surviving, 0 refuted | `pr131-policy-s1-core-20261025` | `c6fb3450` |
| suite | `pr131-s2-suite-20261025` | 0 critical, 14 advisory | 0 surviving, 0 refuted | `pr131-policy-s2-suite-20261025` | `00a88241` |
| surface | `pr131-s3-surface-20261025` | 0 critical, 9 advisory | 0 surviving, 0 refuted | `pr131-policy-s3-surface-20261025` | `0deb9220` |
| ADRs | `pr131-s4-adrs-20261025` | 0 critical, 4 advisory | 0 surviving, 0 refuted | `pr131-policy-s4-adrs-20261025` | `07c0b459` |
| docs/plan/wire | `pr131-s5-docs-plan-wire-20261025` | 0 critical, 10 advisory | 0 surviving, 0 refuted | `pr131-policy-s5-docs-plan-wire-20261025` | `c40a8022` |

No surviving or refuted critical findings, so every remediation start uses `defectFamily: {"kind":"not-required"}` and needs no Declared Repair Group. All dispositions below are `DECLARED` and published as initial P5 revisions; the exact reasons live in each policy run's `artifacts/disposition.json`.

## Advisory dispositions (56: 51 accepted, 3 dismissed, 2 deferred)

### Dismissed
- s1 `pr-test-analyzer-1`: status/owner-map renderers are unit-tested in `engine/tests/core/owner-map-packet.test.ts` and `engine/tests/core/owner-verification-status.test.ts` (other slice).
- s1 `pr-test-analyzer-2`: every `parseMutantCap` and `mutationPlanOf` refusal is asserted in `owner-verification-core.acceptance.test.ts` lines 291-313 (other slice).
- s3 `architecture-tech-lead-2`: settlement refuses writes outside a Task's declared files (`task-byte-scope-violation`), so modified paths are always within `file_list`.

### Deferred
- s2 `type-design-analyzer-1`: roster-parameterized persisted result type; the evaluator is the parse boundary that proves presence. Completion-suite record redesign beyond G5b.
- s4 `architecture-tech-lead-2`: deriving the owner check's exit from its observation would break the uniform check-result record shared with every check (lint precedent, ADR-0031).

### Accepted, grouped by implementation phase

**Phase 1 — core types and the owner seam (sequential, ripples to callers)**
- InvariantId brand shared by obligations, owed ids and verdicts (s2 type-2).
- Smart-constructor OwnerObligation enforcing cross-field relations, shared by plan grammar and wire parser (s5 type-2).
- Opaque OwnerScope built only by `obligations.ts` (s4 atl-1); `obligationsFromInvariants` + pure `verifyOwed` (s1 type-2, atl-1, cs-2).
- Exhaustive per-field `canonicalObligation` (s4 atl-3).
- One path-to-ScriptKind rule shared by both INV-1 seams; owner parse diagnostics become infrastructure failures (s1 cr-1, sfh-2, atl-4).
- Type-only edges tagged and ignored by coverage (s1 sfh-3, type-1, atl-3); `Edge` type (s1 cs-4).
- No-valid-mutants run blocks as owner infrastructure (s1 sfh-1); `tally`/`verified` return plan-drift instead of throwing (s1 type-3).
- Outcome idiom (s1 cs-5); delete tautology (s1 cs-1); frontier-equivalence property over aliases and fallbacks (s1 pr-3).

**Phase 2a — completion suite, runner and workspace**
- Observation parser moved to `core/owner-verification/parse.ts` (s2 atl-1); reserved check id constant replaces the cast (s2 cs-3).
- One core authorize-from-TaskGraph function (s2 atl-3); runner receives the authority (s5 atl-1, runner half).
- Pure runner logic relocated to core with injected read/jsonc (s2 atl-2).
- Owner-attempt path only for owner-infrastructure-only rejections, flattened branch (s2 atl-4, cs-2); shared message helper (s2 cs-1); restore keeps execute cause (s2 sfh-1).
- Tests: stamped-graph readiness (s2 pr-1), affected-ids filter (s2 pr-2), statusPaths records and two-obligation runner (s2 pr-3), wire roster-mismatch refusals (s5 pr-1); fixture helper dedupe (s2 cs-4).

**Phase 2b — status surface and acceptance hygiene**
- Status reports verdicts directly, one pure status value with remedies (s1 atl-2, cs-3; s3 atl-1); `LoomStatusDocument` requires `ownerVerification` (s5 type-1); ADR-0040 updated.
- Remedies negative rows (s3 pr-1); typed imports in the status acceptance test (s3 type-2, cs-1); `mutationOf` narrowing (s3 cs-2); shared obligation fixtures and paragraph matcher (s3 cs-3); `SiblingEntryPoint` import placement (s5 cs-2).

**Phase 2c — metric, linters, docs**
- `FamilySites` derives count (s3 type-1); hoist `plan_file` (s3 cs-4).
- INV-1 regex side-effect import in both byte-identical copies (s5 sfh-1); one seam constant with a rule-mirror test (s5 atl-2); drop redundant pure-module entry (s5 cs-1).
- INV-3 siblings reconciled with every caller in the plan, matrix test, `executable-models.md`, plan-alignment and `docs/architecture.md` (s5 type-3, cm-1, atl-1 docs half).
- ADR history anchored to #131 (s4 cm-1); ADR-0032/0033 reason-type wording; ADR-0034 updated for OwnerScope.

## Validation
- `bun engine/scripts/typecheck.ts`, targeted vitest per phase, full-tier lint (`helper lint` full), then root `npm run verify` (typecheck, full Vitest suite, six smokes).
- Registered remediation: one schema-v2 run against `pr131-s1-core-20261025` with `defectFamily: not-required`, every touched path outside that slice's frozen scope named in `supportPaths` (including this plan); the engine audits, stages and installs the verified index; then commit and push.
