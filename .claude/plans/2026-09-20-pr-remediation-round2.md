# PR Remediation Round 2 — `fix/abandoned-gate-terminal-outcome`

## Authority

- Branch: `fix/abandoned-gate-terminal-outcome`
- Reviewed HEAD: `6d712db809f869fd883120f20d8a052a3e121f06`
- Standalone Review Run: `.claude/reviews/review-and-fix-runs/review-fix-20260920T090417Z-6d712db8`
- Canonical result digest: `5096cd976a24b64f79e0cf03e3c3359cd960bc079aeccb1d50e4646c7f5aeb92`
- Result: 7 surviving critical Findings, 0 refuted critical Findings, 15 advisories.
- Advisory policy Run: `.claude/reviews/review-and-fix-runs/policy-20260920T094429Z-6d712db8`
- Published initial disposition digest: `33a959d88ee74503e1ef55270931e8a183a7c606b541bdb66241f73603a7a8c8`
- Policy provenance: `DECLARED`; all 15 advisories accepted for the reasons below.

## Exact frozen review scope

`.claude/plans/2026-09-06-pr41-round9-remediation.md`, `.claude/plans/2026-09-20-pr-remediation.md`, `.github/workflows/ci.yml`, `docs/operations.md`, `engine/scripts/verify-prerequisites.sh`, `engine/src/config.ts`, `engine/src/core/context-packets.ts`, `engine/src/core/implementation-application.ts`, `engine/src/core/implementation-completion.ts`, `engine/src/core/implementation-lifecycle.ts`, `engine/src/core/implementation-retry.ts`, `engine/src/core/phase-artifact-paths.ts`, `engine/src/core/proof-obligations.ts`, `engine/src/core/spec-trace-migration.ts`, `engine/src/core/wave-gate-machine.ts`, `engine/src/handlers/helpers/attest-implementation.ts`, `engine/src/handlers/helpers/cli-args.ts`, `engine/src/handlers/helpers/orchestration.ts`, `engine/src/handlers/helpers/reconcile-implementation-proof.ts`, `engine/src/handlers/helpers/remediate-implementation-escalation.ts`, `engine/src/handlers/helpers/repair-task-graph.ts`, `engine/src/handlers/helpers/upgrade-spec-trace.ts`, `engine/src/handlers/subagent-stop/advance-phase.ts`, `engine/src/linter/programmatic/no-cross-boundary-imports.ts`, `engine/src/machine/extract-evidence.ts`, `engine/src/orchestration/completion-check-runner.ts`, `engine/src/orchestration/git-remediation.ts`, `engine/src/orchestration/no-follow-fs.ts`, `engine/src/state-manager.ts`, `engine/src/types.ts`, `engine/src/utils/git-probe.ts`, `engine/src/utils/git.ts`, `engine/tests/core/attestation-binding.test.ts`, `engine/tests/core/attestation-dispatch.test.ts`, `engine/tests/core/attestation-proof.test.ts`, `engine/tests/core/implementation-retry.test.ts`, `engine/tests/core/phase-artifact-paths.test.ts`, `engine/tests/core/reviewer-context-packets.test.ts`, `engine/tests/core/spec-authority-load-contract.test.ts`, `engine/tests/handlers/complete-wave-gate.test.ts`, `engine/tests/handlers/helpers/attest-implementation.test.ts`, `engine/tests/handlers/helpers/cli-args.test.ts`, `engine/tests/handlers/helpers/orchestration.test.ts`, `engine/tests/handlers/helpers/programs/defect-family-accounting.integration.test.ts`, `engine/tests/handlers/helpers/programs/wave-gate-completion-suite.integration.test.ts`, `engine/tests/handlers/helpers/reconcile-implementation-attestation.test.ts`, `engine/tests/handlers/helpers/remediate-implementation-escalation.test.ts`, `engine/tests/handlers/helpers/repair-task-graph.test.ts`, `engine/tests/handlers/helpers/wave-spec-check-scope.test.ts`, `engine/tests/handlers/implementation-attempt-sidecar.test.ts`, `engine/tests/handlers/store-spec-check-findings.test.ts`, `engine/tests/handlers/subagent-start/mark-subagent-active-roster.test.ts`, `engine/tests/handlers/subagent-stop/advance-phase-artifacts.test.ts`, `engine/tests/machine/extract-evidence.test.ts`, `engine/tests/orchestration/completion-check-runner.integration.test.ts`, `engine/tests/orchestration/no-follow-fs.test.ts`, `engine/tests/orchestration/orchestration-acceptance.test.ts`, `engine/tests/orchestration/report-file-boundary.test.ts`, `engine/tests/pi-imports.test.ts`, `engine/tests/pi/attempt-authority-correlation.test.ts`, `engine/tests/pi/package-manifest.test.ts`, `engine/tests/pi/phase-artifact-boundary.test.ts`, `engine/tests/pi/subagent-result.test.ts`, `engine/tests/state-manager-attestation.test.ts`, `engine/tests/state-manager-implementation-completion.test.ts`, `engine/tests/state-manager-load-guards.test.ts`, `engine/tests/state-manager.test.ts`, `engine/tests/utils/git-probe.test.ts`, `engine/tests/verification-ci.test.ts`, `package.json`, `pi/extension.ts`, `pi/subagent-result.ts`.

## Surviving-critical dispositions and Declared Repair Groups

Every canonical Finding ID appears exactly once with status `repaired`. Group facts remain `DECLARED`; only the registered remediation check can become `ENGINE_OBSERVED`.

### `group.post-reap-process-authority`

- Finding: `code-reviewer-1` → `repaired`.
- DECLARED root cause: after the command leader closed, containment treated a successful negative-PGID probe as continuing identity even though a recycled same-UID group produces the same result.
- DECLARED invariant: no signal is sent after leader closure solely on a recyclable numeric PGID; post-close observation either proves the original group gone/recycled or waits without signaling and reports unconfirmed survival.
- Siblings:
  - `engine/src/orchestration/completion-check-runner.ts` → separate live-leader termination from post-close observation.
  - `engine/tests/orchestration/completion-check-runner.integration.test.ts` → deterministic same-UID recycled-group and surviving-descendant regressions.
- Selected check: `project:verify`.
- Historical RED (`DECLARED`): the reviewed parent-close path sees `present` for a recycled signalable group and immediately sends SIGTERM/SIGKILL to that foreign group.

### `group.taskgraph-project-boundary`

- Findings:
  - `code-reviewer-2` → `repaired`.
  - `silent-failure-hunter-2` → `repaired`.
  - `pr-test-analyzer-1` → `repaired`.
  - `comment-analyzer-1` → `repaired`.
  - `architecture-tech-lead-1` → `repaired`.
- DECLARED root cause: project-root authority was recomputed from ambient cwd/relative environment state in the Claude adapter and omitted entirely by the Pi adapter.
- DECLARED invariant: one typed TaskGraph Project Boundary is observed from the authoritative absolute State File path and consumed unchanged for every project-relative artifact and repository operation, independent of later cwd.
- Siblings:
  - `engine/src/config.ts` → return root plus Git/layout provenance from one observation.
  - `engine/src/handlers/subagent-stop/advance-phase.ts` → consume the typed boundary root.
  - `pi/extension.ts` → derive the boundary once and use it for both phase artifacts and settlement repository probes.
  - `engine/tests/pi/phase-artifact-boundary.test.ts` and advance-phase tests → relative override/cwd-drift and nested Pi regressions.
- Selected check: `project:verify`.
- Historical RED (`DECLARED`): reviewer probes resolved `/repo/custom/state.json` to `/repo/custom`, and a relative override ceased matching after cwd changed.

### `group.pi-settlement-project-authority`

- Finding: `silent-failure-hunter-1` → `repaired`.
- DECLARED root cause: Pi converted failure to establish the TaskGraph checkout into an ambient-repository fallback before exact implementation settlement.
- DECLARED invariant: Pi settlement uses only the TaskGraph Project Boundary; unavailable Git authority blocks settlement and never substitutes the runtime checkout or cwd.
- Siblings:
  - `pi/extension.ts` → remove ambient root fallback and share the one boundary with phase progression.
  - `pi/subagent-result.ts` and Pi settlement tests → preserve typed unavailable/non-repository handling.
- Selected check: `project:verify`.
- Historical RED (`DECLARED`): the reviewed nullish chain selects `git.repositoryRoot()` or `process.cwd()` after the TaskGraph-root probe fails, allowing bytes from another checkout to satisfy proof.

## Advisory dispositions and accepted fixes

All decisions are `DECLARED` and were published in exact advisory-origin order.

1. `pr-test-analyzer-2` — accepted: replace the misleading attestation test with a real terminal attempt-2 escalation fixture.
2. `type-design-analyzer-1` — accepted: require a tombstone's non-null `supersededBy` Run ID to match the fresh Wave Gate registration.
3. `type-design-analyzer-2` — accepted: return discriminated no-graph, not-targeted, stamped, and replayed abandonment outcomes to the shell.
4. `type-design-analyzer-3` — accepted: replace the array-typed compact proxy with an explicit immutable byte-sequence contract exposing only supported operations.
5. `type-design-analyzer-4` — accepted: make unchecked attestation transformation private; only the aggregate command may mint attested Tasks.
6. `type-design-analyzer-5` — accepted: split live and retired protected Wave Gate registrations into a discriminated union over terminal outcome.
7. `comment-analyzer-2` — accepted: describe normal proof as declared-artifact movement plus policy-dependent test obligations.
8. `comment-analyzer-3` — accepted: document scope-wide `attempt-scope-drifted` separately from declared-artifact drift.
9. `comment-analyzer-4` — accepted: correct the recognized-flag/unconsumed-token JSDoc.
10. `comment-analyzer-5` — accepted: document Git-authorized roots and the explicit canonical/legacy non-repository fallback.
11. `architecture-tech-lead-2` — accepted: replace formatted core failures with a readonly discriminated lifecycle-error union rendered by the shell.
12. `architecture-tech-lead-3` — accepted: delete compatibility planner exports and move their tests to the aggregate-command interface.
13. `code-simplifier-1` — accepted: derive the attestation proof once and use it for both Task state and audit plan.
14. `code-simplifier-2` — accepted: centralize the shared exact task/reason argument grammar while preserving operation-specific diagnostics.
15. `code-simplifier-3` — accepted: remove unreachable confirmed-empty Git branches and document the throwing adapter policy.

No advisory is deferred or dismissed.

## Refuted-finding audit

None. `refuted_critical_findings` is empty; no refuted Finding will be modified.

## Anticipated support paths

These paths are outside the frozen scope and must be named in remediation start input if retained/touched:

- `.claude/plans/2026-09-20-pr-remediation-round2.md`
- `engine/src/core/context-packet-projection.ts`
- `engine/src/handlers/helpers/implementation-lifecycle-errors.ts`
- `engine/src/handlers/helpers/programs/helpers.ts`
- `engine/src/handlers/helpers/programs/standalone-evidence.ts`
- `engine/src/handlers/helpers/programs/standalone-source.ts`
- `engine/src/handlers/helpers/programs/standalone-successor-registration.ts`
- `engine/src/handlers/helpers/programs/standalone-successor-source.ts`
- `engine/src/handlers/helpers/programs/standalone.ts`
- `engine/src/handlers/helpers/programs/wave-gate.ts`
- `engine/tests/fixtures/implementation-escalation.ts`
- `engine/tests/orchestration/uncovered-branches.test.ts`
- `engine/tests/pi-extension-review-events.test.ts`
- `engine/tests/handlers/helpers/programs/standalone-successor.integration.test.ts`
- Any additional new regression/helper path must be added explicitly before remediation starts.

## Validation

Development validation:

1. Focused Vitest suites after each repair group.
2. `cd engine && bun run typecheck`.
3. `git diff --check`.
4. `npm run verify` from the repository root.
5. Final `distill` apply pass after a green baseline, followed by covering tests.

Registered remediation validation:

- Selected check for every Declared Repair Group: `project:verify`.
- Required fresh report: `.loom/completion-reports/verify.junit.xml`.
- Success terminology: `repair-checked` with `ENGINE_OBSERVED` check results; no claim of semantic proof or Finding resolution.
