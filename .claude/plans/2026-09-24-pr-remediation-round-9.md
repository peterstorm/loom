# PR Remediation — Round 9 (PR #59, grammar branch @ 09875cd8)

## Facts (DECLARED)

- **Branch**: `feat/grammar-constrained-decoding`, remediation head `09875cd8` (base `main` @ `3ff10118`, unchanged).
- **Review Run Directory**: `.claude/reviews/review-and-fix-runs/review-fix-20260924T145931Z-09875cd8` (standalone-review, 8 issued slots — 7 roles, pr-test-analyzer attempt 1 rejected by the machine for a non-single-JSON payload, attempt 2 captured clean; 8/8 captured, 0 rejected at close).
- **Canonical result**: `result.json` digest `eac01a0ab53d24ba921d82b8ae80b573376df4b40958c7a5231649c3205fec72` (76,912 bytes). **0 surviving criticals, 0 refuted criticals, 23 advisories.**
- **Policy publication (BEFORE implementation)**: run `policy-20260924T153146Z-r9`, artifact `artifacts/disposition.json` (schemaVersion 1, initial revision, 23 entries, provenance DECLARED), disposition digest `f28c742c26d0c0353715c0df4b13ae1a83c7d8299d00d92184013280692436f6`, receipt `effect:standalone-disposition:f28c742c26d0c0353715c0df4b13ae1a83c7d8299d00d92184013280692436f6`.
- **Disposition summary**: 22 accepted (19 unique defects; code-reviewer-1's baseline-arm defect independently found by 5 of 7 reviewers — pr-test-analyzer-1, type-design-analyzer-1, comment-analyzer-1, code-simplifier-1 folded into it) / **1 deferred** / 0 dismissed.
- **Deferred**: `type-design-analyzer-3` — re-keying the session write-grant maps by branded `PiSessionId` makes the deliberately-raw rejection keys unrepresentable (an unparseable/absent session id is exactly what `rejectedChildWriteGrantSessions` must hold); interface redesign of the rejection path, own task.
- **Refuted-finding audit**: none — no refutation panel was routed (0 criticals).
- **Defect-family accounting**: `{"kind":"not-required"}` (zero surviving criticals).
- **Validation**: registered `project:verify` (fresh `.loom/completion-reports/verify.junit.xml`), plus CI both legs.

## Accepted fixes (enumerated)

1. **code-reviewer-1** (+ folded duplicates pr-test-analyzer-1, type-design-analyzer-1, comment-analyzer-1, code-simplifier-1): `emission-ingestion.ts` selectCanonicalPayload baseline return — delete the vestigial `emissionRefusal: null`; add a runtime-shape pin (no own `emissionRefusal`, twin-arm equality).
2. **code-reviewer-2**: `probe.mjs` runPhase rejected-prompt path — return recordStart/argsStart bounds; persist `promptRejected` in the report (prompt/infrastructure vocabulary only, AD-2).
3. **code-reviewer-3**: `emission-tool.ts` EmissionParseFailureCode doc — added members are `unsupported-schema-version` (gateway+binding) and `invalid-schema` (verdict-args parser); `invalid-json` is the reused reviewer-protocol code.
4. **silent-failure-hunter-1**: `probe.mjs` phaseWindow — capture `argsEnd` at runPhase return; slice `[argsStart, argsEnd)`.
5. **silent-failure-hunter-2**: `pi/subagent-result.ts` writeTargetPathOf comment — nullish defers; only a non-nullish non-string wins and fails.
6. **silent-failure-hunter-3**: `qual-extension.ts` — stderr line naming a skipped kind/version before the `continue`.
7. **pr-test-analyzer-2**: cross-parser witness — an emission-admitted judge sample through `parseJudgeVerdict`, an admitted refutation sample through `parseRefutationVerdict`.
8. **pr-test-analyzer-3** (+ resolves **code-simplifier-2**): synthetic two-carrier roster test driving `assertPanelJudgeProfileUnique`'s throw; gives both exports a real consumer.
9. **pr-test-analyzer-4**: catch-branch announcement tests for both twins (mocked throwing `gitRepositoryRoot`, stderr-spy) + one mixed multi-target edits case.
10. **pr-test-analyzer-5**: writeTargetPathOf probe-order pins (non-string-first-then-string; null-first-then-string).
11. **pr-test-analyzer-6**: failed-review `changed:false` arm test (duplicate/stale failure evidence → processing error).
12. **type-design-analyzer-2**: `panel-contract.ts` — `aggregateVerdicts` criteriaInOrder: `readonly ArchitectureCriterion[]`; `parseJudgeVerdict` expectedCriterion: `ArchitectureCriterion`; call sites mint via `criterionOf`.
13. **architecture-tech-lead-1**: move catalog-derived agent-policy constants from `config.ts` into the pure `model-profiles.ts` leaf; config re-exports; the four core modules import the leaf; load-time disjointness assertions stay at config load.
14. **architecture-tech-lead-2**: published review-authority bridge contract in engine (key constant + receipt type + typed fail-closed lookup); pi and both test consumers import it.
15. **architecture-tech-lead-3**: `PANEL_ARTIFACT_WRITERS` typed against `LoomAgentName` (WAVE_REVIEW_AGENTS pattern).
16. **code-simplifier-3**: `EMISSION_SCHEMA_VERSIONS` module-local.
17. **code-simplifier-4**: arming test rewritten to assert the probe-to-decision mapping (probe ? block : allow).

## Support paths (not in the frozen review scope)

- This plan file: `.claude/plans/2026-09-24-pr-remediation-round-9.md`
- New engine bridge contract module (architecture-tech-lead-2), registered at remediation start.
