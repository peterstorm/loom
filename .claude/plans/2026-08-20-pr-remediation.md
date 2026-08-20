# PR Remediation — 2026-08-20

## Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Reviewed head:** `f467150657b0d05b412eedbf7e5eb4b93cda86f7`
- **Standalone Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260820T153850Z-5379411f`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/review-20260820T153850Z-5379411f/result.json`
- **Result digest:** `34a999b823f506f06ce9c60e271f66f24ef819dc2fe901bd11eedb240ab885ea`
- **Exact frozen scope:** the canonical 481-path array at `result.json#/scope`; it is not reconstructed by hand.
- **Support paths outside frozen scope:** `engine/src/core/git-sha.ts`.

## Surviving critical Findings — mandatory

1. **`code-reviewer-1` — concurrent Pi resource publication reuses a consumed stage**
   - Serialize readiness, quarantine, and publication for each content-addressed root with the existing cross-process lock protocol, including a synchronous shell adapter for this synchronous materialization API.
   - Recheck readiness under the lock before rendering/publishing and retain atomic rename publication.
   - Keep and strengthen the concurrent first-publication/corrupt-repair regression.

2. **`silent-failure-hunter-1` — post-install checkpoint failure is misreported as an uncommitted remediation block**
   - Derive and validate the terminal lifecycle state before installing the index.
   - After installation, isolate checkpoint persistence from the broad pre-install catch; return an explicit failure stating that the verified index was installed and include its receipt if checkpoint recording fails.
   - Add a focused fake-port regression for the post-install checkpoint boundary.

3. **`type-design-analyzer-1` — Wave Review Task authority leaves proof evidence unparsed**
   - Parse non-null `proof` through `parseTaskProof` and non-null `testResult` through `parseTaskTestResult` at the Context Packet boundary.
   - Store the parsed `TaskProof | null` and `TaskTestResult | null` types in `WaveReviewTaskAuthority`; reject malformed evidence as corrupt.
   - Add malformed-proof and malformed-test-result regressions while retaining valid absent evidence.

4. **`comment-analyzer-1` — artifact-write-scope makes a false module-level no-I/O claim**
   - Correct the contract comment to distinguish pure decision behavior from `config.ts` import-time runtime discovery. Do not claim module-level purity while that dependency exists.

5. **`comment-analyzer-2` — pi-write-grant-plan makes the same false no-I/O claim**
   - Apply the same precise contract correction; retain the existing graph-activity input seam and behavior.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-2` — active roster access errors collapse into absence.** Remove `existsSync`; `statSync` directly, classify only `ENOENT` as absence, and preserve actionable diagnostics for every other error. Add an `ELOOP` regression.
2. **`silent-failure-hunter-3` — SubagentStart task-graph access errors skip the pointer.** Use the existing fail-closed path probe so inaccessible graph state remains active enough to record the pointer; add coverage.
3. **`silent-failure-hunter-4` — Pi spawn task-graph access errors skip the pointer.** Reuse Pi's fail-closed probe instead of `existsSync`; preserve rollback semantics and add coverage where practical.
4. **`silent-failure-hunter-5` — inaccessible linter config silently becomes `EMPTY_CONFIG`.** Read directly, map only `ENOENT` to absence, and throw a path-qualified error otherwise.
5. **`silent-failure-hunter-6` — active-roster cleanup access errors return before the lock.** Remove the preflight and classify `ENOENT` inside the locked operation; log other failures.
6. **`silent-failure-hunter-7` — machine-binding cleanup access errors return before the lock.** Remove the preflight and rely on the locked fail-closed classifier; preserve existing diagnostics.
7. **`pr-test-analyzer-1` — no inaccessible linter-config regression.** Add a root-reliable symlink-loop test proving full-tier configuration does not silently disable policy.
8. **`code-simplifier-1` — nested review-status ternary.** Replace it with ordered assignments/branches preserving the three outcomes.
9. **`code-simplifier-2` — three Pi spawn-mode booleans are reinterpreted by a nested ternary.** Parse the exclusive mode into one local discriminated value before reading entries.
10. **`code-simplifier-3` — exact Git SHA grammar is duplicated.** Introduce one pure `isExactGitSha` predicate and reuse it across the reviewed production parsers while preserving caller-specific diagnostics.

### Deferred

1. **`architecture-tech-lead-1` — split all pure Agent policy from runtime config.** The claim is sound, but a complete fix must remove runtime defaults from all seven `core -> config` imports (including the 1,800-line guarded-state command analyzer), redesign shell injection points, and settle the resulting public-surface ownership. A partial extraction would leave the Finding true; doing the complete interface migration inside this correctness remediation would materially enlarge the authority and regression surface. The two false purity comments are corrected now, and the structural deepening is deferred as a dedicated architecture change rather than represented as complete.

### Dismissed

- None.

## Refuted critical Finding audit

- `result.json.refuted_critical_findings` is empty; no critical Finding is omitted or fixed as refuted.
- All five critical Findings survived the registered threshold of two refutation lenses.
- `type-design-analyzer-1` was refuted by the intent lens because StateManager parses persisted Task evidence before publication, but reproduction and security upheld it: the Context Packet parser itself still accepted arbitrary evidence. The canonical panel therefore retained it, and this remediation treats it as mandatory.

## Planned changed files

- `.claude/plans/2026-08-20-pr-remediation.md`
- `engine/src/core/artifact-write-scope.ts`
- `engine/src/core/findings.ts`
- `engine/src/core/git-sha.ts` (support path)
- `engine/src/core/model-profiles.ts`
- `engine/src/core/pi-write-grant-plan.ts`
- `engine/src/core/review-packet.ts`
- `engine/src/handlers/helpers/programs/remediation.ts`
- `engine/src/handlers/helpers/programs/wave-gate.ts`
- `engine/src/handlers/helpers/reconcile-implementation-proof.ts`
- `engine/src/handlers/pre-tool-use/block-direct-edits.ts`
- `engine/src/handlers/subagent-start/mark-subagent-active.ts`
- `engine/src/linter/programmatic/config.ts`
- `engine/src/machine/ledger.ts`
- `engine/src/state-manager.ts`
- `engine/src/utils/git.ts`
- `engine/src/utils/lock.ts`
- `engine/tests/handlers/helpers/programs/remediation-audit-message.test.ts`
- `engine/tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts`
- `engine/tests/handlers/pre-tool-use/block-direct-edits.test.ts`
- `engine/tests/linter/programmatic/config.test.ts`
- `engine/tests/machine/ledger.test.ts`
- `engine/tests/pi-resources.test.ts`
- `engine/tests/utils/lock.test.ts`
- `pi/extension.ts`
- `pi/resources.ts`

## Validation

Focused gates after coherent moves:

```bash
cd engine
npm run test:unit -- --run tests/pi-resources.test.ts tests/utils/lock.test.ts
npm run test:unit -- --run tests/handlers/helpers/programs/remediation-audit-message.test.ts tests/handlers/remediated-branches.test.ts
npm run test:unit -- --run tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts
npm run test:unit -- --run tests/handlers/pre-tool-use/block-direct-edits.test.ts tests/handlers/subagent-start/mark-subagent-active-roster.test.ts tests/machine/ledger.test.ts
npm run test:unit -- --run tests/linter/programmatic/config.test.ts
npm run test:unit -- --run tests/core/findings.test.ts tests/core/model-profiles.test.ts tests/core/review-packet.test.ts tests/state-manager.test.ts tests/utils/git.test.ts
```

Final gates:

```bash
cd engine
npm run typecheck
npm run test:unit
npm test
```

After the green implementation, run `distill` in apply mode against the changed code, one behavior-preserving move at a time. Then start registered remediation with `supportPaths: ["engine/src/core/git-sha.ts"]`, resume to `done`, use only the engine-installed verified index, commit, and push without force.
