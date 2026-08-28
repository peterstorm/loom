# PR Remediation Round 20

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T181913Z-deterministic-task-completion-oracle-post-remediation-24`
- Source result digest: `e6b0431cdfab37216f25ebae0031fdee535697636e9b3cb330eb205631ee1c24`
- Exact frozen scope: the 64-path `.scope` array in the source `result.json`; canonical compact-array digest `9fa1764f8673959811059b612489a46c6e1aaf475b869adf17bae63f05d57936`.

## Mandatory fixes
1. Reconcile `wave_gates` whenever Claude replaces current spec-check evidence with `EVIDENCE_CAPTURE_FAILED`.
2. Reconcile `wave_gates` in both Pi spec-check capture/parse failure transitions.
3. Reconcile `wave_gates` when a missing reserved Pi spec-check result replaces prior evidence in the atomic missing-result settlement.
4. Apply the same derived-state invariant at the manual `store-spec-check` helper discovered while auditing every spec-check writer; register its production/test paths as remediation support paths because they are outside the frozen review scope.
5. Balance nested TypeScript generic angle brackets before classifying a TSX `<...>` prefix as generic-arrow syntax; retain following tests/assertions.
6. Move the Claude capture JSDoc to `captureClaudeResult` and document `resolveClaudeRequestAuthority` as authority lookup only.
7. Correct Pi correlator documentation: a missing correlator is rejected for a request-bound result, while unrelated unbound legacy results remain outside that authority path.

## Advisory dispositions
### Accepted
- `comment-analyzer-3`: correct the nearby TSX helper comments while modifying the nested-generic classifier.
- `type-design-analyzer-1`: make rejected Wave completion readiness carry non-empty `failureKinds` and `checkIds`, matching the derivation invariant.

### Deferred
- `architecture-tech-lead-2`: extracting Wave Gate façade decisions from the shell is a module-interface refactor independent of this correctness remediation.
- `architecture-tech-lead-3`: extracting a pure TaskGraph codec from `StateManager` changes a central persistence seam and warrants a dedicated architecture slice.
- `architecture-tech-lead-4`: relocating shared Pi/Claude settlement helpers changes cross-harness module ownership and warrants a dedicated architecture slice.
- `code-simplifier-1`: converting the complete cross-language lexical scanner to a mode ADT is sound, but is a broad parser refactor; this round limits parser change to balanced generic recognition with focused regressions.
- `code-simplifier-2`: consolidating Pi review settlement branches is unrelated to the surviving defects and risks changing concurrency diagnostics.
- `code-simplifier-3`: replacing the missing-result manager/flag pair with a load-result ADT is sound but changes several absent/unreadable shell branches; preserve those proven behaviors in this focused round.

## Refuted-finding audit
- `architecture-tech-lead-1` is not changed. Request-bound Claude capture runs before TaskGraph lookup, so standalone evidence is preserved; later TaskGraph requirements govern only legacy category settlement.

## Validation
1. Focused TSX, Claude spec-check, Pi spec-check, missing-reservation, and Wave readiness tests.
2. Typecheck and unused checks.
3. Full bounded Vitest suite.
4. Smoke suite with inherited Pi runtime variables unset.
5. Changed-production lint and `git diff --check`.
6. Registered remediation, exact verified-index installation, commit/push, then a fresh canonical standalone review/refutation.
