# PR Remediation Round 10 — direct evidence-handler authority

## Immutable review authority

- Source run: `review-20260828T091910Z-deterministic-task-completion-oracle-post-remediation-14`
- Reviewed revision: `e5412de1f88b8f22a98ff44bd776b3b4e5aa20da`
- Result digest: `596869894fedf5ae03058aeea4d9e4a7faa9faba5cac8b033c82b7aac3e1e6d1`
- Frozen scope: the 143 paths recorded in the source result.

## Mandatory remediation

1. A recognized review agent must return `kind: error` when its session TaskGraph authority throws or resolves to no manager; the diagnostic must name the reviewer and state that findings were not stored.
2. `spec-check-invoker` must return `kind: error` for both thrown and absent TaskGraph authority; it cannot persist `EVIDENCE_CAPTURE_FAILED` without the aggregate it belongs to, so successful passthrough is forbidden.
3. Close the identical nullable-authority passthrough in the direct implementation-status handler; recognized implementation evidence commands also require a TaskGraph.
4. Preserve passthrough for non-reviewer/non-spec-check agents because those routes have no evidence command to settle.
5. Add direct-handler regressions for absent and malformed session authority, while preserving existing transcript evidence-failure behavior when a valid graph exists.

## Advisory disposition

- Non-empty rejected suite typing is deferred to a focused domain-type change.
- Trusted Review Witness extraction and `types.ts` decomposition are independent architecture slices.
- Pi review-application and task-graph repair simplifications are deferred behavior-preserving cleanup.

## Validation and release

1. Focused reviewer/spec-check/dispatcher tests.
2. Typecheck and unused-symbol check.
3. Full bounded Vitest suite (`--maxWorkers=4 --minWorkers=1`).
4. Smoke suite, changed-production lint, and `git diff --check`.
5. Register immutable support paths and install the exact verified index.
6. Commit and push without force.
7. Run a fresh canonical standalone review and three-lens refutation; do not open a PR while any critical survives.
