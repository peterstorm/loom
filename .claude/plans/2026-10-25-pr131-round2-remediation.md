# PR 131 round-2 remediation: G5b owner-map enforcement

Branch `feat/g5b-owner-enforcement`, reviewed head `07fc107c` (after the round-1 remediation in `2026-10-25-pr131-remediation.md`). The frozen diff against `origin/main` (1.18 MB) exceeded one reviewer's budget, so it was reviewed as eight registered slices under `.claude/reviews/review-and-fix-runs`.

| Slice | Review run | Emitted/admitted | After refutation | Policy run | Disposition digest |
|---|---|---|---|---|---|
| core src | `pr131r2-s1-core-src-20261025` | 0 critical, 10 advisory | 0 surviving, 0 refuted | `pr131r2-policy-s1-core-src-20261025` | `4be2986b` |
| core tests | `pr131r2-s2-core-tests-20261025` | 0 critical, 7 advisory | 0 surviving, 0 refuted | `pr131r2-policy-s2-core-tests-20261025` | `b9179ff0` |
| runner | `pr131r2-s3-runner-20261025` | 0 critical, 11 advisory | 0 surviving, 0 refuted | `pr131r2-policy-s3-runner-20261025` | `5d463201` |
| suite | `pr131r2-s4-suite-20261025` | 0 critical, 15 advisory | 0 surviving, 0 refuted | `pr131r2-policy-s4-suite-20261025` | `f006462e` |
| metric/lint | `pr131r2-s5-metric-lint-20261025` | 0 critical, 9 advisory | 0 surviving, 0 refuted | `pr131r2-policy-s5-metric-lint-20261025` | `a2913f03` |
| surface | `pr131r2-s6-surface-20261025` | 0 critical, 8 advisory | 0 surviving, 0 refuted | `pr131r2-policy-s6-surface-20261025` | `6a580e1a` |
| ADRs | `pr131r2-s7-adrs-20261025` | 0 critical, 10 advisory | 0 surviving, 0 refuted | `pr131r2-policy-s7-adrs-20261025` | `b9fdb42d` |
| docs/plan | `pr131r2-s8-docs-plan-20261025` | 0 critical, 8 advisory | 0 surviving, 0 refuted | `pr131r2-policy-s8-docs-plan-20261025` | `c1eae1e0` |

No surviving or refuted critical findings: remediation uses `defectFamily: {"kind":"not-required"}` and needs no Declared Repair Group. All dispositions are `DECLARED`, published as initial P5 revisions; the exact reasons live in each policy run's `artifacts/disposition.json`.

## Advisory dispositions (78: 71 accepted, 5 deferred, 2 dismissed)

### Deferred
- s1 `architecture-tech-lead-2`: internally driven coverage reader changes the INV-1 seam and the frontier-equivalence property; deepen-session change.
- s4 `type-design-analyzer-2`: non-empty rejection union and owner observation inside the authorized result change the FR-004 byte-compatible persisted record (same family as round-1 s2 type-1).
- s6 `architecture-tech-lead-1`: stamp-primary brief rendering; plan blocks carry prose the stamp lacks, drift branch is a recorded ADR-0040 deviation and gated.
- s6 `architecture-tech-lead-3`: joining readiness and remedies through one value restructures the readiness fact / routeLoomStatus.
- s8 `architecture-tech-lead-4`: collapsing five selection functions into two duty entry points; reviewer scopes it to "if more callers appear".

### Dismissed
- s4 `architecture-tech-lead-4`: the required fourth parameter is the documented omission guard (ADR-0031), pinned by arity and ts-expect-error tests.
- s5 `architecture-tech-lead-3`: the regex loader cannot import code; the mirror test already fails closed on divergence.

### Accepted, by implementation group

**A — core owner-verification and its tests** (s1, s2, s7 atl-3 code, s7 atl-4 manifest)
- `typescript` becomes an engine runtime dependency pinned `^5.9` (phaseModifier always present) (s1 cr-1, sfh-1; s7 atl-4).
- Placeholder exemption reasons refused at parse time (s1 sfh-2); `parseInvariantId` boundary table test (s1 pr-1).
- One repository-path rule shared by coverage and tsconfig-paths (s1 atl-1, cs-1); `mutationPlan` total with no throw (s1 atl-3); `renderMutationVerdict` single renderer or deleted (s1 cs-2); parse.ts constructor rename (s1 cs-3).
- New infrastructure kind `alias-config-unresolvable` for an unresolvable tsconfig/alias graph (s7 atl-3).
- Tests: frozen plan fixtures for FR-021 (s2 pr-1, atl-1); shell parity rows to a handler test with a shared persisted-result builder (s2 atl-2); shared `digest`/`capOf`/`suiteResultOf` fixtures (s2 cs-1..4).

**B — runner, workspace, completion suite** (s3, s4 code)
- Timeout end-to-end test (s3 pr-1); overlay symlink/directory test (s3 pr-3); parsed checkId returned, alias removed (s3 pr-2, atl-3, cs-1).
- Runner input parsed so owed ids and obligations agree (s3 type-1); discriminated baseline/mutant workspace input (s3 type-2); pure ls-tree parse and fake-workspace runPlan test (s3 atl-1); per-obligation plan computed once (s3 atl-2); test helper dedupe (s3 cs-2, cs-3).
- Timed-out/signalled owner outcome and stale-slot replay tests (s4 pr-1); pure owner-observation decision (s4 atl-2); `publicationSlotOf` (s4 atl-3); SuiteContext carries wave/manifest (s4 cs-2); `unchangedWorkspace` returns drift or null (s4 cs-3); shared reserved-check envelope parser (s4 cs-4); `asNonEmpty` idiom (s4 cs-5).

**C — status surface, metric, lint tests** (s5 code, s6)
- Real shuffle in AS-032 (s5 pr-1); owner-map acceptance header (s5 cm-1); shell walks the core scanned root (s5 atl-1); matrix fixture dedupe (s5 cs-1); no nested ternaries (s5 cs-2); DEPS overlap (s5 cs-3).
- Remedy-less owner rejection explained (s6 sfh-1); OwnerObligation wire parser beside its constructor (s6 atl-2); typed status acceptance assertions (s6 atl-4, cs-3); brief single pass (s6 cs-1); one `invariantPlanBlock` fixture helper (s6 cs-2).

**D — documentation** (s4 ADR-0031, s5 ADR-0043, s7, s8)
- ADR-0031 signature and owed type; ADR-0043 five pure leaves; ADR-0034 caller count; ADR-0032/0039/0040 OwnerScope signatures; ADR-0035/operations remedy row for `alias-config-unresolvable`; ADR-0042 runtime dependency.
- Plan AD-4/T10/File Structure/Data Flow refreshed; CONTEXT.md type-only re-exports; docs/architecture.md module row and rethrow catcher; executable-models.md re-export-only closure.

## Validation
- `bun engine/scripts/typecheck.ts`, targeted vitest per group, full-tier lint, then root `npm run verify` (typecheck, full Vitest suite, six smokes).
- Registered remediation: one schema-v2 run against `pr131r2-s1-core-src-20261025` with `defectFamily: not-required`, every touched path outside that slice's frozen scope named in `supportPaths`; the engine audits, stages and installs the verified index; then commit and push.
