# Slice 2 Wave Completion Suite — Re-review Remediation

## Authority

- Branch: `feat/deterministic-wave-completion-suite`
- Reviewed HEAD: `bf9e0176ad4d66507b2afd81c5a36595eecd362d`
- Review run: `review-20260824T181954Z-deterministic-wave-suite-rereview-retry`
- Result digest: `ce4e2fb10145cca2f441b26f0d9e057f0b4156a71e50f4814d16ef72b5333e8a`
- Surviving criticals: 0
- Refuted criticals: 0

## Exact frozen scope

`.claude/plans/2026-08-23-deterministic-task-execution.md`, `CONTEXT.md`, `artifacts/tests/test-validate-task-graph.sh`, `commands/loom.md`, `commands/templates/phase-decompose.md`, `docs/deterministic-implementation.md`, `docs/workflows.md`, `engine/src/config.ts`, `engine/src/core/completion-suite.ts`, `engine/src/core/verification-manifest.ts`, `engine/src/core/wave-gate-machine.ts`, `engine/src/handlers/helpers/complete-wave-gate.ts`, `engine/src/handlers/helpers/orchestration.ts`, `engine/src/handlers/helpers/populate-task-graph.ts`, `engine/src/handlers/helpers/programs/wave-gate.ts`, `engine/src/handlers/helpers/validate-task-graph.ts`, `engine/src/handlers/helpers/wave-completion-suite.ts`, `engine/src/orchestration/completion-check-runner.ts`, `engine/src/orchestration/run-directory-handle.ts`, `engine/src/state-manager.ts`, `engine/src/types.ts`, `engine/src/utils/workspace-digest.ts`, `engine/tests/core/completion-suite.property.test.ts`, `engine/tests/core/verification-manifest.property.test.ts`, `engine/tests/core/wave-completion-readiness.test.ts`, `engine/tests/fixtures/completion-process.mjs`, `engine/tests/handlers/complete-wave-gate.test.ts`, `engine/tests/handlers/helpers/orchestration.test.ts`, `engine/tests/handlers/helpers/programs/wave-gate-completion-suite.integration.test.ts`, `engine/tests/handlers/helpers/wave-completion-suite.test.ts`, `engine/tests/handlers/populate-task-graph.test.ts`, `engine/tests/handlers/pre-tool-use/guard-state-file.test.ts`, `engine/tests/handlers/validate-task-graph.test.ts`, `engine/tests/orchestration/completion-check-runner.integration.test.ts`, `engine/tests/orchestration/publication-faults.test.ts`, `engine/tests/orchestration/run-directory-artifact-read.test.ts`, `engine/tests/runtime-resource-portability.test.ts`, `engine/tests/state-manager-load-guards.test.ts`, `engine/tests/utils/workspace-digest.test.ts`.

This plan is the only anticipated support path outside that scope.

## Advisory dispositions

### Accepted

1. `silent-failure-hunter-1`: counter reads in `wave-completion-suite.test.ts` must return zero only for `ENOENT`; every other filesystem error must fail with path and cause.
2. `silent-failure-hunter-2`: apply the same fail-closed counter rule to the Wave Gate completion integration sentinel.
3. `pr-test-analyzer-1`: deterministically exercise workspace list and file drift using a controlled Git executable that changes the second observation epoch; assert no digest is minted.
4. `pr-test-analyzer-2`: deterministically mutate protected state during stale receipt clearing and receipt installation; assert a state diagnostic and no stale authority installation.
5. `type-design-analyzer-1`: brand `ObservedWorkspaceEntry.path` as parser-proven `ReviewPath`, carry the brand from Git output parsing, and require parsed entries at the pure digest interface.
6. `comment-analyzer-1`: state precisely that identity parsing proves direct-child/existing-directory shape and `openDirectoryNoFollow` supplies no-symlink authority.
7. `architecture-tech-lead-1`: define a narrow `RunCompletionCheck` function port and let the Wave suite receive production or fake adapters; preserve real-process integration tests.
8. `architecture-tech-lead-2`: define a core-owned `CompletionSignal` union from the parser allowlist and translate Node child-process signals in the runner adapter.
9. `code-simplifier-2`: replace the structural `CompletionCheckRunnerResult | ReportSnapshot | null` probe/cast with an exhaustive private `not-required | snapshot | failure` ADT.

### Dismissed

1. `code-simplifier-1`: do not extract a parameterized generic parser kernel across completion-suite and verification-manifest. Each module has a distinct domain error kind, fallback diagnostic, and exact-path vocabulary. A shared helper parameterized by those semantics would be a shallow abstraction whose interface approaches the duplicated implementation and would couple two authority parsers. Keep parser ownership local.

### Deferred

None.

## Implementation constraints

- Preserve exact packet and persisted-state wire schemas.
- Preserve compatibility with legacy TaskGraphs.
- Do not weaken workspace double-observation, lock/CAS authority, process-group containment, or immutable Run Directory publication.
- Use fake function adapters only at real I/O seams; no mocking framework.
- Keep production defaults at the shell boundary and all new domain values immutable.
- Distill in apply mode after green focused tests, one move at a time.

## Validation

1. Focused Vitest for completion core, manifest, runner, workspace digest, Wave suite, and Wave Gate completion integration.
2. `npm run typecheck` including unused checks.
3. Full-tier lint for every changed production TypeScript file.
4. Bounded full Vitest suite.
5. All smoke gates via `npm run test:smoke`.
6. `git diff --check`.
7. Registered remediation with this plan as the only expected support path, followed by exact verified-index installation, commit, and push.

## Validation result

- Focused completion/Wave suite: **7 files, 204/204 passed**.
- Bounded full suite: **215 files, 5,331 passed, 1 intentional skip**.
- Panel smoke: **22/22**; review-panel smoke: **19/19**; standalone review, orchestration façade, Pi resources, and TaskGraph **23/23** all passed.
- Typecheck, unused checks, full-tier lint for all five changed production files, and `git diff --check` passed.
- An initial focused invocation inherited the active parent Pi runtime and was correctly blocked by runtime-skew guards before candidate behavior ran; the required standalone environment rerun passed 204/204.
