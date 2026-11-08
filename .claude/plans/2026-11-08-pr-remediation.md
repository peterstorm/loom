# Post-merge review remediation — G2 skeletons (PR #151)

- **Branch:** `fix/g2-review-advisories` (from `main` @ `0e8df9a5`, the #151 merge)
- **Reviewed scope:** the full #151 merge diff (`381d7c93..0e8df9a5`, 159 files), split into eight
  registered standalone review runs of ≤ 200 KB each to respect the reviewer read budget:
  `.claude/reviews/review-and-fix-runs/g2-post-merge-s{1..8}-20261107` (review clone with
  `origin/main` pinned to the pre-merge commit so the engine diffed exactly #151).

## Critical findings

- **Surviving criticals:** none in any of the eight runs. Defect family: `not-required`.
- **Refuted (audited, not fixed):** s3 `silent-failure-hunter-1`, `engine/src/core/skeleton/conformance.ts`:
  "judgeFile matches bindings by exact path, so a `./src/a.ts` file_list entry skips signature conformance."
  The panel refuted it 2–1 (blast-radius and reproduction lenses): `file_list` paths are canonical by
  construction (`parseReviewPath` rejects `.`/`..`/empty segments and backslashes at population and at
  every State File load), so the precondition is unreachable. The intent-lens verifier upheld it.
  The same comparison was still hardened as accepted advisory s3 `type-design-analyzer-1` (`samePlanPath`).

## Advisory dispositions (DECLARED, published through P5)

88 advisories: 67 accepted, 16 deferred, 5 dismissed. Each record is published, initial revision:

| Slice | Policy run | Disposition digest |
|---|---|---|
| s1 | g2-post-merge-policy-s1-20261108 | 2524f91f2410756dce0d3a38968bd1899bd5b3d6867fb92db49ded1ee8fefc53 |
| s2 | g2-post-merge-policy-s2-20261108 | ff0fa78a1c55cd83012b78b52864bb2b003aac4d9c9a1dcdac1aa6785ea0b7b5 |
| s3 | g2-post-merge-policy-s3-20261108 | 37d03f466c1a14e4623e1a3c560cd0bf3460d318c78b205308060a4bded66be6 |
| s4 | g2-post-merge-policy-s4-20261108 | 055747d2a54293b0536cc5197e7d1f0d5f847a6ec3d7c88cf236a86fa4444b7c |
| s5 | g2-post-merge-policy-s5-20261108 | 8fbf98dc33ae22eaddb3b94fc6cd804f98ddb660bcb416fcf253ea78851548c7 |
| s6 | g2-post-merge-policy-s6-20261108 | 280085b45e768e2bd1bc057f5cbcae12203f0d8dc667ae0edb32af0985c46782 |
| s7 | g2-post-merge-policy-s7-20261108 | 881a95030676697664a10e9a3c66b9b351e7f41bda84d20a582969154b58cced |
| s8 | g2-post-merge-policy-s8-20261108 | ba51f4497957aedc27bde001717aab4ab5e50136f7e755bf25b6a6fdb0ea20d8 |

### Deferred (16) and dismissed (5)

- Deferred: lint-rule generation from the seam constant (s1); typed receipt side-field for contract
  violations and RevisedContract collapse (s2); plan-label grammar unification (s3); SkeletonTarget
  compile-time mint (s4, s6); unified stage-two observation seam (s4); moving G2 wire parsers into
  core/skeleton (s4); single outcome owner for recorded vs projected outcomes (s5); java-surface
  module-shape pins (s6); splitting the skeleton-repo fixture (s7).
- Dismissed: ContractConformance re-parse at the evidence seam (deliberate fail-closed guard);
  FR-010 property merge (loses requirement traceability); NFR-002 timing bound (the spec's own criterion).

## Accepted fixes (by area)

- **Settlement core:** one required `EngineSkeletonObservation` (`NO_ENGINE_SKELETONS`) replaces the two
  optional coupled inputs; `observeEngineSkeletons` built on `readRepositoryLeafNoFollow`;
  exhaustive ts-pattern `proofFailureKind`; required stage-two blocker for `classifyImplementationWindow`;
  skeleton report resolved once in loom-status; new infrastructure-failure tests for settlement and reconcile.
- **Brief:** required `frozenSignatures`; owed scope narrowed once; corrected FROZEN_SIGNATURES_LEAD;
  `contractStubAuthor` decides stub ownership once from the graph (also used by `stubbedContracts`);
  stamped graph with no plan file renders a visible "Export bindings unchecked" note; retry-gate tests.
- **Skeleton core:** stale list derived from flagged records; revision outcome lines owned by
  `renderSkeletonRevisionLines`; `samePlanPath` in `judgeFile`; parse problems carried into conformance
  remedies; one Java keyword owner (characterization-pinned); `planCandidateRefresh`/`planRecordRefresh`;
  one `ABSENT`; ts-pattern `renderResolutionProblem`; shared `describeCause`; `DomainResult` stamp;
  one `NO_EXPORT_BINDINGS` and `bindingTaskView`; pure `stopCheckDecision` with stub note at one join
  point; Pi `reportContractStubs` test.
- **Tests:** shared observed-evidence, binding-builder, registration, State File and write-race fixtures;
  duplicate writer test folded into the matrix (four unique rows moved); root-safe unreadable path;
  no `as Identifier` casts; precedence example rows; renamed fixture exports.
- **Docs:** FR-028 → FR-021/AS-028; plan as-built record; spec status; ADR-0042/0043 third seam;
  ADR-0048 status surface; ADR-0049 imported-member union limit; ADR-0051/0052/0056/0057/0058/0059/0060
  corrections; operations.md spawn wording; INV-1 rule descriptions cite ADR-0053.

## Validation

- `npm run verify` at the repository root (frozen installs at root and `engine/`).
- Registered remediation: `helper orchestration start remediation` from one source run with
  `defectFamily: {"kind": "not-required"}` and every out-of-scope changed path in `supportPaths`.
