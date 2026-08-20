# PR Remediation — 2026-08-20

## Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Reviewed head:** `80ab581a7168c4f4071973e6bc969af6ebe68538`
- **Merge base (`main`):** `eda64237336193dac66843323b4c69dd4bafcd32`
- **Standalone Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260820T122019Z-01a01f1d`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/review-20260820T122019Z-01a01f1d/result.json`
- **Result digest:** `e74f8535bced4c787b14bd4f7d40edbe01f583cebb56c31f0fa455f0799f897a`
- **Exact frozen scope:** the canonical path array at `result.json#/scope`.
- **Remediation support paths outside frozen scope:** none; this Plan and every planned source/test/documentation path are already in the frozen scope.

## Surviving critical Findings — mandatory

1. **`pr-test-analyzer-1` — rollback failure after a denied guarded bind is untested**
   - Finding: tests prove successful removal after `bindMachineAgent` fails, but never force `removeActiveAgentStrict` itself to fail. The security-sensitive branch that reports an unproven rollback and leaves a role-bearing roster row therefore has no regression.
   - Fix: add a filesystem fault regression in `engine/tests/handlers/subagent-start/mark-subagent-active-roster.test.ts`. Arrange a valid pre-existing roster row so rollback must use the atomic rewrite path, make its deterministic temporary path unwritable, and independently make machine binding fail. Assert the Hook blocks, names `active-roster rollback could not be proven`, leaves the denied row observable, and demonstrates why the lingering implementation-role row is write-authorizing. Preserve the existing successful-rollback regression.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-1` — accepted.** Malformed final Claude transcript JSON is evidence corruption, not an absent final payload. Parse the final line into an explicit result and surface its one-based line number and `JSON.parse` cause through request-bound capture. Add a malformed-final-line regression while preserving the no-fallback rule.
2. **`silent-failure-hunter-2` — accepted.** Artifact staged-file cleanup failures currently disappear. Make staged cleanup return deterministic path-qualified diagnostics, append them to the primary artifact publication failure, and add an actual filesystem cleanup-failure regression.
3. **`silent-failure-hunter-3` — accepted.** Transcript staged-file cleanup failures likewise hide leftover evidence. Preserve the primary capture cause while appending any non-ENOENT staged cleanup failure with the staged path; cover the diagnostic combination at the cleanup interface and retain capture atomicity tests.
4. **`silent-failure-hunter-4` — accepted.** Pi session binding publication must report both its original publication error and failure to remove its staged registry. Replace the swallowed cleanup catch with combined, path-qualified failure reporting and add boundary coverage.
5. **`pr-test-analyzer-2` — accepted.** Add one real CLI integration that reaches a façade-emitted advisory `await-user`, passes that exact request id to `decide --request`, resumes through the registered program, and observes the terminal `done` action. This pins status/façade/decision identity as one end-to-end contract.
6. **`pr-test-analyzer-3` — accepted.** Add focused `publishDecisionContext` tests for digest mismatch, non-byte values, invalid UTF-8, invalid JSON, byte-identical idempotence, and an occupied content-addressed slot with different bytes.
7. **`type-design-analyzer-1` — accepted.** Replace nullable `WaveReviewContextAuthority` combinations with a discriminated union for `spec-check-invoker` authority versus Task-review authority. Parse exact role/task/taskRun/task/packetId combinations at the boundary and reject illegal cross-role combinations as corrupt.
8. **`architecture-tech-lead-1` — accepted.** Complete ADR-0006’s explicit follow-up: derive the Wave Gate driver’s advisory/refutation/ready-to-complete intent from `projectWaveGateLifecycle` rather than re-deriving advisory count/request/approval predicates in the shell. The shell reads durable event evidence and executes the typed core intent; it does not decide the lifecycle stage. Add pure drive-step tests and update ADR-0006.
9. **`architecture-tech-lead-2` — accepted.** Curate `handlers/helpers/programs/index.ts` to the operations/types consumed by the orchestration façade. Helper-level tests import their owning volume directly instead of widening the caller interface. Add a Public Surface regression and update ADR-0007’s previously unresolved consequence.
10. **`code-simplifier-1` — accepted.** Extract one private malformed-record salvage pipeline parameterized only by the envelope parser; keep the two exported remediation-specific entry points and their behavior unchanged. Add parity coverage.
11. **`code-simplifier-2` — accepted.** Reuse one text-content flattener for Pi messages and Claude tool-result content instead of maintaining the string-or-text-block rule twice. Preserve transcript ordering and unsupported-content behavior; extend parser coverage across both formats.

### Deferred

- None. Every advisory is evidence-backed and has a complete in-scope remediation.

### Dismissed

- None.

## Operator-directed current-protocol correction

- **Pi retry self-roster masks abandoned timestamped reservations — accepted.** A separate operator report exposed a legacy TaskGraph deadlock, but the ordering is also reachable on current graphs when Pi terminates after committing `reserved_at` and before result cleanup. Sample graph activity before the prospective Pi batch adds its own roster rows, pass that typed observation to task registration, and reclaim only aged reservations carrying a valid current-protocol timestamp. Keep roster-first rollback safety, keep a pre-existing active agent fail-closed, and do not add a timestamp-less legacy migration path. Add pure eligibility coverage and a real Pi retry/cleanup integration.

## Refuted critical Finding audit

- `result.json.refuted_critical_findings` is empty. No critical Finding was refuted or omitted.
- The registered Refutation Panel upheld `standalone-review:pr-test-analyzer-1` unanimously:
  - **reproduction:** the bind-failure test forces only `.machine` failure and proves successful roster removal; no test induces strict removal failure or checks the rollback diagnostic.
  - **intent:** the production code explicitly treats failed rollback as an unproven role-bearing row, but that branch has no test.
  - **security:** `shouldBlockDirectEdit` treats a surviving implementation-role row as write authorization, so rollback failure is security-sensitive.

## Planned changed files

- `.claude/plans/2026-08-20-pr-remediation.md`
- `docs/adr/ADR-0006-lc1-reaches-production-by-projection.md`
- `docs/adr/ADR-0007-curated-public-surface.md`
- `engine/src/core/findings.ts`
- `engine/src/core/validate-task-execution.ts`
- `engine/src/core/wave-gate-machine.ts`
- `engine/src/handlers/helpers/programs/index.ts`
- `engine/src/handlers/helpers/programs/wave-gate.ts`
- `engine/src/handlers/task-execution.ts`
- `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`
- `engine/src/orchestration/run-directory-handle.ts`
- `engine/src/orchestration/session-run-bindings.ts`
- `engine/src/parsers/parse-transcript.ts`
- `engine/tests/core/findings.test.ts`
- `engine/tests/handlers/helpers/orchestration.test.ts`
- `engine/tests/handlers/helpers/quality-programs.test.ts`
- `engine/tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts`
- `engine/tests/handlers/pre-tool-use/validate-task-execution.test.ts`
- `engine/tests/handlers/stale-task-reservation.test.ts`
- `engine/tests/handlers/subagent-start/mark-subagent-active-roster.test.ts`
- `engine/tests/orchestration/orchestration-acceptance.test.ts`
- `engine/tests/orchestration/publication-faults.test.ts`
- `engine/tests/orchestration/session-run-bindings.test.ts`
- `engine/tests/parsers/parsers.test.ts`
- `engine/tests/pi-extension-review-events.test.ts`
- `pi/extension.ts`

## Validation

Establish a green baseline before implementation, then run focused tests after each coherent move:

```bash
cd engine
npm run test:unit -- --run \
  tests/handlers/subagent-start/mark-subagent-active-roster.test.ts \
  tests/orchestration/orchestration-acceptance.test.ts \
  tests/orchestration/publication-faults.test.ts \
  tests/orchestration/session-run-bindings.test.ts \
  tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts \
  tests/handlers/helpers/quality-programs.test.ts \
  tests/handlers/helpers/orchestration.test.ts \
  tests/handlers/pre-tool-use/validate-task-execution.test.ts \
  tests/handlers/stale-task-reservation.test.ts \
  tests/core/findings.test.ts \
  tests/parsers/parsers.test.ts \
  tests/pi-extension-review-events.test.ts
```

Final gates:

```bash
cd engine
npm run typecheck
npm run test:unit
npm test
```

After the implementation is green, run `distill` in apply mode one move at a time with covering tests after each move. Then start registered remediation with `supportPaths: []`, resume to `done`, use only the engine-installed verified index, commit, and push without force.
