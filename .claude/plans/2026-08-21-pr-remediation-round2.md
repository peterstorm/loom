# PR Remediation — 2026-08-21 (Round 2)

## Authority

- Branch: `feat/architecture-panel-mode-plan`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/raf-20260821T051345Z-01a022bd`
- Canonical result: `.claude/reviews/review-and-fix-runs/raf-20260821T051345Z-01a022bd/result.json`
- Result digest: `9ffe652221850558da97b6c6a6a376d3d96c64605a4fa389f421c393471e53ef`
- Exact frozen scope: the 494-path `result.json.scope` array, by reference to the immutable canonical result above. No path outside that array is remediation scope unless explicitly listed under Support Paths.

## Support Paths

- `.claude/plans/2026-08-21-pr-remediation-round2.md` — this required remediation plan.
- `engine/src/core/shell-command.ts` — new neutral pure module required by accepted advisory `architecture-tech-lead-1`.
- `engine/src/linter/programmatic/no-io-in-pure-modules.ts` — registers the new pure `shell-command.ts` module in the purity linter's default module list so the FC/IS invariant guards it.

## Surviving Critical Findings — Mandatory

### `code-reviewer-1` — Missing Pi results never terminalize their reserved capture attempt

- Location: `pi/extension.ts:1497`
- Panel outcome: upheld by reproduction, intent, and blast-radius lenses.
- Fix:
  1. Resolve each missing run result through its reserved result index and expected Agent role.
  2. Persist the attempt rejection through `RunDirHandle.rejectCapture` and append the idempotent `request-capture-rejected` event.
  3. Return and surface any correlation, tombstone, or event-persistence failure as a Pi processing error instead of logging and continuing silently.
  4. Add an integration regression that starts a registered Standalone Review Run, returns an empty Pi result batch, resumes the run, and proves the next issued request is semantic attempt 2 rather than attempt 1.

## Advisory Dispositions

### Accepted

1. `silent-failure-hunter-1` — `render-pi-agent.ts` masks authoritative skill-path access errors.
   - Reason: sound fail-closed boundary issue with a small complete fix.
   - Fix: probe each candidate with an error-preserving filesystem operation; continue only on `ENOENT`, and test an inaccessible higher-priority skill candidate cannot fall through.

2. `silent-failure-hunter-2` — `report-discovery.ts` reports explicit artifact access failures as absence.
   - Reason: sound operator-diagnostic issue on a trust-bearing artifact path; complete fix is local.
   - Fix: inspect explicit report paths once, classify only `ENOENT` as missing, and retain concrete diagnostics for other filesystem failures with regression coverage.

3. `type-design-analyzer-1` — `WaveReviewEpochAuthority` loses parser-proven brands.
   - Reason: sound parse-don’t-validate violation; the parser already produces the stronger values.
   - Fix: carry `OrchestrationRunId` and `ArtifactDigest` in the persisted authority type.

4. `type-design-analyzer-2` — `PreparedBatch` represents impossible empty/partial outcomes.
   - Reason: sound illegal-state issue at a private orchestration join interface.
   - Fix: model prepared output as an exact four-part tuple and blocked output as a non-empty reason tuple; make the Zod boundary enforce the same invariants and add refusal tests.

5. `architecture-tech-lead-1` — shell command parsing lives under the Guarded Skill Machine evidence module and is imported by core policy.
   - Reason: sound dependency-direction/locality issue; the parser seam has multiple real consumers and can be moved without changing behavior.
   - Fix: move shared command segmentation/comment/env-prefix/fd-dup parsing into neutral pure `core/shell-command.ts`; preserve the existing evidence-module exports for compatibility while switching core and Pi consumers to the owning module.

6. `architecture-tech-lead-2` — template-substitution core defaults to filesystem I/O.
   - Reason: sound FC/IS violation and practical to fix across both harness shells.
   - Fix: require pre-gathered graph existence as data in the core decision; Claude and Pi shells perform the fail-closed filesystem probe explicitly.

7. `code-simplifier-1` — two SubagentStop handlers duplicate Agent namespace stripping.
   - Reason: sound reuse-before-rewrite cleanup using an established helper.
   - Fix: use `stripNamespace` in both handlers.

8. `code-simplifier-2` — task waves are derived twice during task-graph population.
   - Reason: sound local duplication with risk of drift and no interface cost.
   - Fix: derive the sorted unique wave list once and reuse it for gate construction and the completion diagnostic.

### Dismissed

1. `comment-analyzer-1` — claimed `binding-liveness.test.ts` does not exist.
   - Reason: contradicted by repository evidence. `engine/tests/machine/binding-liveness.test.ts` exists; the comment accurately names the sibling test, and the result’s frozen diff scope is not a repository file-existence inventory.

2. `comment-analyzer-2` — claimed `cli-fail-polarity.test.ts` does not exist.
   - Reason: contradicted by repository evidence. `engine/tests/e2e/cli-fail-polarity.test.ts` exists and pins the CLI polarity described by the comment; no comment change is warranted.

### Deferred

None.

## Refuted Critical Finding Audit

None. `result.json.refuted_critical_findings` is empty.

## Validation

Run from `engine/` unless noted:

1. Focused tests after each move:
   - `bunx vitest run tests/pi-extension-review-events.test.ts --testTimeout=15000`
   - `bunx vitest run tests/utils/render-pi-agent.test.ts tests/machine/report-discovery.test.ts --testTimeout=15000`
   - `bunx vitest run tests/state-manager-load-guards.test.ts tests/orchestration/fugue-operation-dags.test.ts --testTimeout=15000`
   - `bunx vitest run tests/machine/extract-evidence.test.ts tests/core/guard-state-file-walkers.test.ts tests/handlers/pre-tool-use/guard-state-file.test.ts --testTimeout=15000`
   - `bunx vitest run tests/handlers/pre-tool-use/validate-template-substitution.test.ts tests/handlers/store-reviewer-findings.test.ts tests/handlers/store-spec-check-findings.test.ts tests/handlers/populate-task-graph.test.ts --testTimeout=15000`
2. `npm run typecheck`
3. `npm test`
4. Repository root: `git diff --check`

Validation must be green before registered remediation may install the verified index.
