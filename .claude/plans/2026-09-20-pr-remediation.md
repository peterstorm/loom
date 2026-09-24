# PR Remediation — `fix/abandoned-gate-terminal-outcome`

## Authority

- Branch: `fix/abandoned-gate-terminal-outcome`
- Reviewed HEAD: `33334c4807bca5798aae1ecd80fc1ef40957280d`
- Standalone Review Run: `.claude/reviews/review-and-fix-runs/review-fix-20260920T023517Z-01a0bca9`
- Canonical result digest: `02688e8a963cb3aa7dd8d1a1bbdd53049b3ff2e1eb29271b12b26cfa757442ff`
- Result: 10 surviving critical Findings, 0 refuted critical Findings, 12 advisories.
- Advisory policy Run: `.claude/reviews/review-and-fix-runs/policy-20260920T032642Z-01a0bca9`
- Published initial disposition digest: `01191f7ab412e48f039b02fec5069b77e69dfd4be765b8c917725c821129621f`
- Policy provenance: `DECLARED`; all 12 advisories accepted with the reasons in the published record.

## Exact frozen review scope

`.claude/plans/2026-09-06-pr41-round9-remediation.md`, `.github/workflows/ci.yml`, `docs/operations.md`, `engine/scripts/verify-prerequisites.sh`, `engine/src/config.ts`, `engine/src/core/implementation-application.ts`, `engine/src/core/implementation-completion.ts`, `engine/src/core/implementation-retry.ts`, `engine/src/core/phase-artifact-paths.ts`, `engine/src/core/proof-obligations.ts`, `engine/src/core/spec-trace-migration.ts`, `engine/src/core/wave-gate-machine.ts`, `engine/src/handlers/helpers/attest-implementation.ts`, `engine/src/handlers/helpers/orchestration.ts`, `engine/src/handlers/helpers/reconcile-implementation-proof.ts`, `engine/src/handlers/helpers/remediate-implementation-escalation.ts`, `engine/src/handlers/helpers/repair-task-graph.ts`, `engine/src/handlers/helpers/upgrade-spec-trace.ts`, `engine/src/handlers/subagent-stop/advance-phase.ts`, `engine/src/linter/programmatic/no-cross-boundary-imports.ts`, `engine/src/machine/extract-evidence.ts`, `engine/src/orchestration/completion-check-runner.ts`, `engine/src/orchestration/git-remediation.ts`, `engine/src/orchestration/no-follow-fs.ts`, `engine/src/state-manager.ts`, `engine/src/types.ts`, `engine/src/utils/git.ts`, `engine/tests/core/attestation-binding.test.ts`, `engine/tests/core/attestation-dispatch.test.ts`, `engine/tests/core/attestation-proof.test.ts`, `engine/tests/core/implementation-retry.test.ts`, `engine/tests/core/spec-authority-load-contract.test.ts`, `engine/tests/handlers/complete-wave-gate.test.ts`, `engine/tests/handlers/helpers/attest-implementation.test.ts`, `engine/tests/handlers/helpers/orchestration.test.ts`, `engine/tests/handlers/helpers/programs/defect-family-accounting.integration.test.ts`, `engine/tests/handlers/helpers/programs/wave-gate-completion-suite.integration.test.ts`, `engine/tests/handlers/helpers/reconcile-implementation-attestation.test.ts`, `engine/tests/handlers/helpers/remediate-implementation-escalation.test.ts`, `engine/tests/handlers/helpers/repair-task-graph.test.ts`, `engine/tests/handlers/helpers/wave-spec-check-scope.test.ts`, `engine/tests/handlers/implementation-attempt-sidecar.test.ts`, `engine/tests/handlers/store-spec-check-findings.test.ts`, `engine/tests/handlers/subagent-start/mark-subagent-active-roster.test.ts`, `engine/tests/machine/extract-evidence.test.ts`, `engine/tests/orchestration/completion-check-runner.integration.test.ts`, `engine/tests/orchestration/no-follow-fs.test.ts`, `engine/tests/orchestration/orchestration-acceptance.test.ts`, `engine/tests/orchestration/report-file-boundary.test.ts`, `engine/tests/pi-imports.test.ts`, `engine/tests/pi/attempt-authority-correlation.test.ts`, `engine/tests/pi/package-manifest.test.ts`, `engine/tests/pi/phase-artifact-boundary.test.ts`, `engine/tests/pi/subagent-result.test.ts`, `engine/tests/state-manager-attestation.test.ts`, `engine/tests/state-manager-implementation-completion.test.ts`, `engine/tests/state-manager-load-guards.test.ts`, `engine/tests/state-manager.test.ts`, `engine/tests/verification-ci.test.ts`, `pi/extension.ts`, `pi/subagent-result.ts`.

## Surviving-critical dispositions and Declared Repair Groups

Every canonical Finding ID appears exactly once below with status `repaired`. All group facts are `DECLARED` until the registered remediation runner observes `project:verify`.

### `group.pi-resource-single-source`

- Findings:
  - `code-reviewer-1` → `repaired`
  - `comment-analyzer-1` → `repaired`
- DECLARED root cause: the extension became the rendered Pi resource source while `package.json` retained legacy raw skill/prompt registrations.
- DECLARED invariant: Pi registers the extension plus no raw skills or prompts; rendered resources have one source and the manifest tests pass.
- Siblings:
  - `package.json` → repair; set `pi.skills` and `pi.prompts` to empty arrays.
  - `engine/tests/pi-imports.test.ts` → already declares the intended invariant; retain.
  - `engine/tests/pi/package-manifest.test.ts` → already declares the intended invariant; retain.
  - `pi/extension.ts` → comment and behavior checked together.
- Selected check: `project:verify`.
- Historical RED (`DECLARED`): the reviewed package manifest produces the two deterministic Vitest failures reported in the Finding basis.

### `group.attestation-no-write-proof`

- Findings:
  - `code-reviewer-2` → `repaired`
  - `type-design-analyzer-1` → `repaired`
  - `type-design-analyzer-2` → `repaired`
- DECLARED root cause: attestation reused generic retry/proof machinery without enforcing regression-required policy and zero delta over the complete Task-local Byte Scope.
- DECLARED invariant: attestation is regression-required, any attempt-scope byte delta is `attempt-scope-drifted`, declared-artifact writes additionally yield `declared-artifact-drifted`, and drift cannot become an accepted retry baseline.
- Siblings:
  - `engine/src/state-manager.ts` → require regression verification at the load boundary.
  - `engine/src/core/proof-obligations.ts` → reject every attestation attempt with a non-empty complete scope delta.
  - `engine/src/core/implementation-application.ts` → preserve the complete observed delta through the completion oracle.
  - `engine/src/core/implementation-retry.ts` → prevent attestation drift from authorizing a baseline-refresh retry.
  - attestation/retry/proof tests in frozen scope → add regressions for waived regression, non-declared scoped writes, and attempt-1 drift.
- Selected check: `project:verify`.
- Historical RED (`DECLARED`): the reviewer probes accepted waived regression, accepted `src/extra.ts` drift, and a retry lineage that reclassified attempt-1 writes as pre-existing.

### `group.escalation-remediation-binding`

- Finding: `type-design-analyzer-3` → `repaired`.
- DECLARED root cause: lineage projection checked receipt kind/order but not the receipt’s authority digest and failure-set binding to the terminal escalation receipt.
- DECLARED invariant: only a remediation receipt naming the exact immediately preceding terminal escalation authority and failure kinds can reset semantic retry authority.
- Siblings:
  - `engine/src/core/implementation-retry.ts` → exact lineage join.
  - `engine/src/core/implementation-completion.ts` → receipt construction remains the source of the binding.
  - `engine/tests/core/implementation-retry.test.ts` and remediation helper tests → mismatched authority/failure regressions.
- Selected check: `project:verify`.
- Historical RED (`DECLARED`): the reviewer’s pure probe accepted an all-`f` authority digest against a different terminal receipt.

### `group.wave-abandonment-root-authority`

- Finding: `code-reviewer-3` → `repaired`.
- DECLARED root cause: abandonment carried only local Run ID into protected Wave Gate state and dropped authenticated runs-root identity.
- DECLARED invariant: a terminal abandonment can tombstone `active_wave_gate` only when both canonical runs root and Run ID exactly match the protected registration.
- Siblings:
  - `engine/src/handlers/helpers/orchestration.ts` → pass authenticated runs root.
  - `engine/src/state-manager.ts` → compare exact root and ID under lock.
  - orchestration/state-manager tests → same-name cross-root refusal plus exact-root success.
- Selected check: `project:verify`.
- Historical RED (`DECLARED`): the reviewed call signature and state transition accept a same-ID marker from another runs root.

### `group.process-group-reuse-containment`

- Findings:
  - `silent-failure-hunter-1` → `repaired`
  - `pr-test-analyzer-1` → `repaired`
- DECLARED root cause: the wait loop used leader-gone/EPERM as a stop condition but returned the stale EPERM probe, so the caller escalated after authority was proven lost.
- DECLARED invariant: leader-gone plus EPERM normalizes to `gone`; no later signal may target that numeric process-group ID.
- Siblings:
  - `engine/src/orchestration/completion-check-runner.ts` → return normalized `gone` state.
  - `engine/tests/orchestration/completion-check-runner.integration.test.ts` → injectable deterministic EPERM/leader-gone regression asserting no SIGKILL.
- Selected check: `project:verify`.
- Historical RED (`DECLARED`): the reviewed deterministic branch invokes SIGKILL after `groupGoneAfterLeaderDeath` returns true.

### `group.state-file-project-root`

- Finding: `architecture-tech-lead-1` → `repaired`.
- DECLARED root cause: artifact resolution inferred project root from canonical state-directory names although `LOOM_STATE_PATH` accepts nested noncanonical locations.
- DECLARED invariant: phase artifacts resolve against the project boundary that selected the authoritative State File, never an inferred arbitrary parent.
- Siblings:
  - `engine/src/config.ts` → retain project-root authority with State File discovery.
  - `engine/src/core/phase-artifact-paths.ts` → accept only explicit/parsed project-root authority or canonical layouts.
  - `engine/src/handlers/subagent-stop/advance-phase.ts` → consume the authoritative root.
  - phase-artifact/config tests → nested override regression.
- Selected check: `project:verify`.
- Historical RED (`DECLARED`): `/repo/custom/state.json` resolves reviewed project-relative artifacts below `/repo/custom` instead of `/repo`.

## Advisory dispositions and accepted fixes

The exact ordered inventory was published with `DECLARED` provenance. All are accepted:

1. `silent-failure-hunter-2`: make confirmed-empty Git root observation typed/diagnosed rather than silent cached fallback.
2. `silent-failure-hunter-3`: reject every unconsumed attestation CLI token.
3. `silent-failure-hunter-4`: reject every unconsumed escalation-remediation CLI token.
4. `comment-analyzer-2`: document remediation as the terminal-escalation exit and attestation as a separate eligible-pending operation.
5. `comment-analyzer-3`: correct CI timeout prose to per-job/per-leg.
6. `comment-analyzer-4`: align the Zod boundary comment/allowlist explanation with actual consumers.
7. `architecture-tech-lead-2`: centralize repeated Git empty-output probing in a narrow typed lower adapter with deterministic fake-driven tests.
8. `architecture-tech-lead-3`: deepen attestation/remediation lifecycle commands so eligibility and mutation are one pure aggregate transition.
9. `code-simplifier-1`: remove the discarded attestation-proof derivation from the fixture.
10. `code-simplifier-2`: share retry/attestation prompt-context framing without changing diagnostics.
11. `code-simplifier-3`: group changed/attested artifact parsing by common invariant while preserving discriminants.
12. `code-simplifier-4`: replace the attestation appendix nested ternary with guard clauses.

No advisory is deferred or dismissed.

## Refuted-finding audit

None. `refuted_critical_findings` is empty; no refuted Finding will be modified as remediation work.

## Operator-directed additional fix

The user explicitly requested repair of the disposition-resume performance defect discovered while executing this workflow. `engine/src/core/context-packets.ts` now retains small frozen dense arrays and represents large immutable sections with compact private typed storage; `engine/tests/core/reviewer-context-packets.test.ts` pins exact serialization, indexing, iteration, immutability, and compactness. Authenticated lineage reading improved from roughly 102 seconds to roughly 7 seconds without changing packet bytes or digests.

## Anticipated support paths

These paths are outside the frozen scope and must be named at remediation start if retained/touched:

- `.claude/plans/2026-09-20-pr-remediation.md`
- `engine/src/core/context-packets.ts`
- `engine/src/core/implementation-lifecycle.ts`
- `engine/src/handlers/helpers/cli-args.ts`
- `engine/src/utils/git-probe.ts`
- `engine/tests/core/phase-artifact-paths.test.ts`
- `engine/tests/core/reviewer-context-packets.test.ts`
- `engine/tests/handlers/helpers/cli-args.test.ts`
- `engine/tests/handlers/subagent-stop/advance-phase-artifacts.test.ts`
- `engine/tests/utils/git-probe.test.ts`
- `package.json`

## Validation

Development validation:

1. `cd engine && bun run typecheck`
2. Focused Vitest runs for each repair group after each move.
3. `npm run verify` from repository root.
4. Re-run the authenticated lineage benchmark against the immutable source review.

Registered remediation validation:

- Selected fixed check for every Declared Repair Group: `project:verify`.
- Required fresh report: `.loom/completion-reports/verify.junit.xml`.
- Success terminology: `repair-checked` with `ENGINE_OBSERVED` check results; no claim of proven closure or semantic resolution.
