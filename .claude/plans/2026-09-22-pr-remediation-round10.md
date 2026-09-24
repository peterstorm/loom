# PR Remediation Round 10 — 2026-09-22

## Authority

- Branch: `fix/abandoned-gate-terminal-outcome`
- Reviewed HEAD: `2a14e68c788728c7be21de012c0b7bde80e457b9`
- Scope: the exact 131-path scope published in the Standalone Review result.
- Review Run Directory: `.claude/reviews/review-and-fix-runs/20260922T153733Z-review-fix-abandoned-gate`
- Review result digest: `fa7d1aaafb904e6b1d72f05d649e341712e821bfafd81d37c5add3276f6b7e08`
- Advisory policy publication: `.claude/reviews/review-and-fix-runs/20260922T162129Z-policy-abandoned-gate`
- Policy revision: initial, disposition digest `457e58d338d8ec9d3ecc215fdcf81d42dbb9e731e5d82469edf2cb60952061ce`
- Provenance: grouping, root causes, invariants, sibling accounting, Historical RED, and advisory policy are `DECLARED`. Only the registered remediation runner may report selected checks as `ENGINE_OBSERVED`.

## Surviving-critical dispositions

Every canonical Finding ID is retained exactly once.

| Finding | Disposition | Declared Repair Group |
|---|---|---|
| `code-reviewer-1` | repaired | `group.task-local-runtime-ownership` |
| `code-reviewer-2` | repaired | `group.task-local-runtime-ownership` |
| `silent-failure-hunter-1` | repaired | `group.wave-gate-abandonment` |
| `type-design-analyzer-1` | repaired | `group.wave-document-project-boundary` |
| `architecture-tech-lead-1` | repaired | `group.task-local-runtime-ownership` |
| `architecture-tech-lead-2` | repaired | `group.task-local-runtime-ownership` |

## Declared Repair Groups

### `group.task-local-runtime-ownership`

- Finding IDs: `code-reviewer-1`, `code-reviewer-2`, `architecture-tech-lead-1`, `architecture-tech-lead-2`
- Root cause (`DECLARED`): Task-local completion inferred engine ownership from broad hard-coded namespaces rather than the exact authoritative State File selected for the settlement. This both hid unowned Git-visible review changes and rejected a configured custom State File.
- Invariant (`DECLARED`): repository observation excludes only the exact authoritative State File; ignored runtime artifacts never enter the Git-visible observation, while every other changed path remains Task-local, sibling-owned, or unresolved out-of-scope evidence.
- Siblings (`DECLARED`):
  - `engine/src/handlers/helpers/task-local-completion.ts` — replace namespace classification with exact State File authority.
  - `engine/src/handlers/helpers/exact-implementation-settlement.ts` — carry exact State File authority through the shared Claude/Pi settlement port.
  - `engine/src/handlers/subagent-stop/update-task-status.ts` and `pi/subagent-result.ts` — supply the State File selected by each production adapter.
  - `engine/tests/handlers/helpers/task-local-completion.unit.test.ts` and `task-local-completion.integration.test.ts` — pin exact classification, custom State File acceptance, and unowned `.claude/reviews` rejection.
  - Status: all identified shared-shell and adapter siblings will be repaired; no unresolved or out-of-scope sibling is declared.
- Selected check: `project:verify`
- Historical RED (`DECLARED`): reviewer reproductions showed an unowned `.claude/reviews/forged-authority.json` write accepted after filtering, while `.custom/state/active_task_graph.json` was rejected as out-of-scope after an engine update.

### `group.wave-gate-abandonment`

- Finding IDs: `silent-failure-hunter-1`
- Root cause (`DECLARED`): the abandonment transition installed a terminal gate while retaining the completion-suite receipt whose load invariant permits only a nonterminal gate.
- Invariant (`DECLARED`): every transition that retires or terminalizes active Wave Gate authority atomically retires its correlated completion-suite receipt; exact abandonment replay remains idempotent.
- Siblings (`DECLARED`):
  - `engine/src/state-manager.ts` — terminal abandonment clears the outgoing suite in the same locked write.
  - `engine/src/core/wave-gate-machine.ts` and `engine/src/handlers/helpers/programs/wave-gate.ts` — centralize restart authority reset as one pure aggregate command, including suite retirement.
  - `engine/tests/state-manager.test.ts`, `engine/tests/handlers/helpers/orchestration-abandon-stamp.test.ts`, and `engine/tests/handlers/helpers/orchestration.test.ts` — pin manifest-bearing abandonment, identical replay, successor registration, and exhausted-review restart persistence.
  - Status: all identified abandonment/restart siblings will be repaired; no unresolved or out-of-scope sibling is declared.
- Selected check: `project:verify`
- Historical RED (`DECLARED`): the reviewer ran abandonment twice on a manifest-bearing active gate; both attempts failed the `active_wave_completion_suite requires a nonterminal active_wave_gate` load invariant and left the registration active.

### `group.wave-document-project-boundary`

- Finding IDs: `type-design-analyzer-1`
- Root cause (`DECLARED`): absolute document paths bypassed the supplied TaskGraph Project Boundary, and the observation interface represented a missing boundary as legal.
- Invariant (`DECLARED`): one immutable observation request always carries the TaskGraph Project Boundary; every relative or absolute Spec/Plan path must resolve within it before no-follow bytes can become Wave authority.
- Siblings (`DECLARED`):
  - `engine/src/orchestration/wave-spec-check-documents.ts` — require the boundary and reject foreign absolute paths.
  - `engine/src/handlers/helpers/programs/wave-gate.ts`, `engine/src/handlers/subagent-stop/store-spec-check-findings.ts`, and `pi/subagent-result.ts` — supply the observed TaskGraph boundary through every production path.
  - `engine/tests/handlers/helpers/wave-spec-check-scope.test.ts` and affected Wave/Pi tests — use the required request and add a foreign-absolute-path regression.
  - Status: all identified observation callers will be repaired; no unresolved or out-of-scope sibling is declared.
- Selected check: `project:verify`
- Historical RED (`DECLARED`): the reviewer supplied a project root and a foreign absolute Spec path; production read and hashed the external bytes instead of refusing them.

## Advisory dispositions

The immutable publication above is authoritative for the complete ordered inventory.

| Finding | Decision | Reason / accepted fix |
|---|---|---|
| `silent-failure-hunter-2` | deferred | Not-targeted variants deliberately preserve unrelated or absent protected registration while Run abandonment succeeds; changing the public outcome needs separate operator-status contract design. |
| `pr-test-analyzer-1` | accepted | Add behavior-level Task-local completion regressions for exact State File exclusion and unowned review-namespace rejection. |
| `pr-test-analyzer-2` | accepted | Add a manifest-bearing exhausted-review restart persistence regression. |
| `type-design-analyzer-2` | deferred | A discriminated persisted Wave authority aggregate requires a broad schema and historical-compatibility migration; current parsing remains fail-closed. |
| `comment-analyzer-1` | accepted | Correct the recovery comment to name re-population or explicit migration. |
| `comment-analyzer-2` | accepted | Separate fatal UTF-8 decode attribution from frozen-source JSON parse attribution. |
| `comment-analyzer-3` | accepted | Name `core/findings.ts` and `attributeFindings` instead of a stale positional reference. |
| `comment-analyzer-4` | accepted | Scope the transient-empty rationale to output-producing Git probes. |
| `architecture-tech-lead-3` | accepted | Move correlated restart invalidation into one pure Wave Gate aggregate command; ADR-0005's per-program driver remains intact. |
| `architecture-tech-lead-4` | accepted | Replace the optional-root call shape with one required immutable observation request. |

No advisory is dismissed.

## Refuted-critical audit

`result.json.refuted_critical_findings` is empty. No refuted Finding will be repaired or omitted.

## Planned files and validation

The following touched paths are outside the frozen review scope and must be listed in remediation `supportPaths` at start:

- `.claude/plans/2026-09-22-pr-remediation-round10.md`
- `engine/src/handlers/helpers/exact-implementation-settlement.ts`
- `engine/src/handlers/subagent-stop/update-task-status.ts`
- `engine/tests/handlers/helpers/exact-implementation-settlement.test.ts`
- `engine/tests/handlers/helpers/programs/reviewer-protocol-wave.integration.test.ts`
- `engine/tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts`
- `engine/tests/handlers/helpers/task-local-completion.integration.test.ts`

Validation commands:

1. Focused Vitest suites for Task-local completion, Wave document scope, StateManager abandonment, and Wave Gate orchestration.
2. Engine typecheck and the full relevant unit suite.
3. `npm run verify`, producing a fresh `.loom/completion-reports/verify.junit.xml` with positive executed tests and zero failures.
4. Registered schema-v2 remediation with all three Declared Repair Groups selecting `project:verify`; read the actual installation receipt and `repair-checked` assessment from the external outcome.
5. Commit the engine-installed exact index and push without force.
