# PR Remediation — 2026-08-20

## Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.raf-20260820T062749Z-01a01dda`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/run.raf-20260820T062749Z-01a01dda/result.json`
- **Result digest:** `ebc635df0b6283668e9a25f4f5fe2b513c47c5a8415238f49b94a6e5d95b66ea`
- **Reviewed head:** `0e3d0e3b4dc5604b8fe45be196eebb0cfe85f09e`
- **Merge base:** `eda64237336193dac66843323b4c69dd4bafcd32`
- **Exact frozen scope:** the canonical 474-path array at `result.json#/scope`; no path outside that immutable array is review authority. New support paths planned below are remediation-only and must be registered explicitly.
- **Planned support paths outside frozen scope:** `.claude/plans/2026-08-20-pr-remediation.md`, `engine/src/handlers/helpers/validation-result.ts`.

## Surviving critical Findings — mandatory

1. **`silent-failure-hunter-1` — unreadable Guarded Skill Machine binding can disarm the gate**
   - Files: `engine/src/machine/ledger.ts`, `engine/src/handlers/pre-tool-use/enforce-phase-tools.ts`, covering tests.
   - Fix: make binding classification return absent only for `ENOENT`; propagate contextual non-absence filesystem failures. Remove `existsSync` prechecks from binding refresh so `EACCES`/`ELOOP`/`ENOTDIR`/`EIO` reach the fail-closed handler boundary. Add an `ELOOP` gate regression proving an unreadable binding blocks rather than passing through.

2. **`silent-failure-hunter-2` — unreadable session task-graph authority can retarget to the local State File**
   - Files: `engine/src/state-manager.ts`, `engine/tests/state-manager.test.ts`.
   - Fix: read the session pointer directly; treat only `ENOENT` as absent; throw on an unreadable pointer; use fail-closed existence for the pointed graph and local graph so unreadable authority is returned/surfaced rather than replaced. Preserve the explicitly documented dangling-pointer fallback. Add pointer and pointed-graph `ELOOP` regressions.

3. **`comment-analyzer-1` — Pi correlator comment names the wrong lifecycle action**
   - File: `pi/extension.ts`.
   - Fix: document that `recordPiSpawnCorrelators` records spawn-side correlators before dispatch, not that it captures a finished result.

4. **`comment-analyzer-2` — Claude capture comment denies durable rejection writes**
   - File: `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`.
   - Fix: document the actual typed decision boundary: accepted captures write transcript evidence, while reservation-bound refusals may durably record rejection markers/events.

5. **`comment-analyzer-3` — transcript resolver comment overclaims universal use**
   - File: `engine/src/utils/agent-transcript-path.ts`.
   - Fix: narrow the comment to legacy/status/phase handlers; request-bound Claude capture intentionally consumes the supplied transcript path directly.

## Advisory dispositions

### Accepted

1. **`code-reviewer-1` — accepted.** The `DomainResult` contract is real and the read-back throw violates it. Catch an unreadable `EEXIST` target and return a typed failure; add a symlink-loop regression through `registerProgram`.
2. **`silent-failure-hunter-3` — accepted.** Artifact discovery must distinguish absence from unreadability. Make filesystem discovery return null only on `ENOENT`, propagate other errors to the handler diagnostic boundary, and add unreadable-path regressions.
3. **`pr-test-analyzer-1` — accepted.** Directly exercise remediation branch-node input schemas with malformed staged-set and decision envelopes so permissive `z.unknown()` regressions fail.
4. **`pr-test-analyzer-2` — accepted.** Drive `taskExecutionDecision` with a previous wave blocked solely by `spec_check.critical_count` and assert the operator-facing cause.
5. **`type-design-analyzer-1` — accepted.** Replace the mutable `Map` subclass with a read-only proxy over an encapsulated native `Map`; preserve `instanceof Map`, structural equality, iteration, and `{}` serialization while making `Map.prototype.set.call(view, ...)` fail. Pin the escape hatch in the property suite.
6. **`comment-analyzer-4` — accepted.** Clarify that Claude capture examines only the final non-empty JSONL line and accepts it only when it is a single-text-block assistant message.
7. **`architecture-tech-lead-1` — accepted.** ADR-0005 explicitly directs genuinely shared computations downward. Move generic Refutation Panel request/retry/capture helpers from the standalone driver into `programs/helpers.ts`; both program drivers import the leaf seam.
8. **`architecture-tech-lead-2` — accepted.** Break the runtime cycle by extracting `ValidationResult`, `ok`, and `fail` into `validation-result.ts`; both validators depend downward on the leaf module and tests import the owning module.
9. **`code-simplifier-1` — accepted.** Replace the nested occupied-artifact ternary with an ordered helper/guard decision without changing error text or ordering.
10. **`code-simplifier-2` — accepted.** Extract explicit completion failure message cases without changing output bytes.
11. **`code-simplifier-3` — accepted.** Centralize attempt-to-roster-authority lookup and reuse it in accepted/rejected transitions.
12. **`code-simplifier-4` — accepted.** Extract the duplicated `enterAggregation` test setup into one parameterized test helper.

### Deferred

1. **`architecture-tech-lead-3` — deferred.** The claim is sound and ADR-0006 explicitly records façade adoption as follow-up, but moving the 1,800-line Wave Gate commit path onto LC-1 projection changes lifecycle authority and effect dispatch across a safety-critical transaction. It is not a bounded remediation alongside fail-closed filesystem fixes. It needs a dedicated plan with projection-equivalence tests and staged commit-path migration; no partial rewrite will be attempted here.

### Dismissed

- None.

## Refuted critical Finding audit

- `result.json.refuted_critical_findings` is empty. No critical Finding was refuted, and none will be omitted from remediation.
- Panel audit: five critical Findings survived. `silent-failure-hunter-2` was refuted by the `intent` lens because dangling-pointer fallback is documented, but upheld by `reproduction` and `security`; the threshold therefore retained it. The fix preserves dangling `ENOENT` fallback while eliminating fallback on unreadable authority.

## Planned changed files

- `.claude/plans/2026-08-20-pr-remediation.md`
- `engine/src/machine/ledger.ts`
- `engine/src/state-manager.ts`
- `pi/extension.ts`
- `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`
- `engine/src/utils/agent-transcript-path.ts`
- `engine/src/orchestration/run-directory-handle.ts`
- `engine/src/handlers/subagent-stop/advance-phase.ts`
- `engine/src/utils/find-file.ts`
- `engine/src/core/orchestration-contract/roster.ts`
- `engine/src/handlers/helpers/programs/helpers.ts`
- `engine/src/handlers/helpers/programs/standalone.ts`
- `engine/src/handlers/helpers/programs/wave-gate.ts`
- `engine/src/handlers/helpers/validation-result.ts`
- `engine/src/handlers/helpers/validate-model-bindings.ts`
- `engine/src/handlers/helpers/validate-task-graph.ts`
- `engine/src/handlers/helpers/complete-wave-gate.ts`
- `engine/src/core/standalone-review-machine.ts`
- `engine/tests/handlers/pre-tool-use/enforce-phase-tools-fail-closed.test.ts`
- `engine/tests/state-manager.test.ts`
- `engine/tests/orchestration/publication-faults.test.ts`
- `engine/tests/handlers/subagent-stop/advance-phase.test.ts`
- `engine/tests/utils/find-file.test.ts`
- `engine/tests/orchestration/fugue-operation-dags.test.ts`
- `engine/tests/handlers/pre-tool-use/validate-task-execution.test.ts`
- `engine/tests/core/orchestration-contract.property.test.ts`
- `engine/tests/handlers/validate-task-graph.test.ts`
- `engine/tests/handlers/validate-task-graph.property.test.ts`
- `engine/tests/core/standalone-review.test.ts`

## Validation

Baseline and focused iteration:

```bash
cd engine
npm run test:unit -- --run \
  tests/handlers/pre-tool-use/enforce-phase-tools-fail-closed.test.ts \
  tests/state-manager.test.ts \
  tests/orchestration/publication-faults.test.ts \
  tests/handlers/subagent-stop/advance-phase.test.ts \
  tests/utils/find-file.test.ts \
  tests/orchestration/fugue-operation-dags.test.ts \
  tests/handlers/pre-tool-use/validate-task-execution.test.ts \
  tests/core/orchestration-contract.property.test.ts \
  tests/handlers/validate-task-graph.test.ts \
  tests/handlers/validate-task-graph.property.test.ts \
  tests/core/standalone-review.test.ts
```

Final gates:

```bash
cd engine
npm run typecheck
npm run test:unit
npm test
```

After implementation reaches a green baseline, run `distill` in apply mode one move at a time, rerunning covering tests after each simplification. Then start registered remediation with both support paths, resume to `done`, use the engine-installed verified index, commit, and push without force.
