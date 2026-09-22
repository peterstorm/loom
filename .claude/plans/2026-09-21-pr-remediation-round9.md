# PR Remediation Plan — Round 9 (`20260921T191639Z-review-fix-ef35acf8`)

**Branch:** `fix/abandoned-gate-terminal-outcome`  
**Reviewed HEAD:** `ef35acf819674886fdea05af2b7a2a3faefa4e7a`  
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/20260921T191639Z-review-fix-ef35acf8`  
**Canonical result digest:** `0a514cefe5ecd6b1b61174572798736db93e34784d5c347f6067a9912e369424`

## Scope and adjudication

The exact frozen review scope is the ordered 120-path `result.json.scope` inventory in the Review Run above. This remediation may touch paths in that scope plus this new Plan and `scripts/smoke-panel-mode.sh`; both must be registered as remediation `supportPaths` before the candidate is captured. The smoke script is a sibling acceptance fixture whose persisted absolute `spec_dir` must adopt the repaired project-relative invariant.

The inspection renderer reports 3 emitted/admitted critical Findings and 13 advisory Findings. After the registered three-lens Refutation Panel: 3 critical Findings survive, 0 are refuted, and all 13 advisories remain advisory.

## Surviving-critical dispositions

All three original Finding IDs are dispositioned exactly once as `repaired`.

### Declared Repair Group `group.plan-artifact-regular-file`

**Findings:** `code-reviewer-1`, `silent-failure-hunter-1`

- **Root cause (DECLARED):** architecture fallback candidate selection treated filesystem readability as sufficient artifact authority. `accessSync(R_OK)` accepts directories, and the date-prefix name filter did not require a regular file, so a readable directory ending in `.md` could be recorded as the architecture Plan.
- **Invariant (DECLARED):** every selected phase document is a readable regular file. A directory, including one whose name ends in `.md`, never becomes phase-artifact authority. Date-prefix selection considers only readable regular files.
- **Siblings (DECLARED, paths-declared):** `engine/src/handlers/subagent-stop/advance-phase.ts` owns all transition-time filesystem probes. The recorded Plan, canonical slug candidate, date-prefix fallback, Spec, Brainstorm, and Plan Alignment probes will share the regular-file predicate. `engine/tests/handlers/subagent-stop/advance-phase.test.ts` and `engine/tests/handlers/subagent-stop/advance-phase-artifacts.test.ts` pin the invalid-directory refusal. No sibling is unresolved or out of scope.
- **Selected fixed check:** `project:verify`.
- **Historical RED (DECLARED):** against reviewed HEAD, a sole readable `.claude/plans/<date>-*.md/` directory makes `resolveTransition("architecture", ...)` return `ready`; the new regression expects `not-ready` and therefore fails against that vulnerable behavior. Reference: the reviewer reproductions retained in `result.json`.

### Declared Repair Group `group.phase-artifact-project-boundary`

**Finding:** `type-design-analyzer-1`

- **Root cause (DECLARED):** `SpecArtifactDirectory` parsing and resolved containment could use ambient `process.cwd()`, while transition observation separately knew the TaskGraph Project Boundary. Absolute persisted directories and artifact paths could therefore retain foreign-checkout authority.
- **Invariant (DECLARED):** persisted `spec_dir` authority is project-relative, and every artifact containment decision and filesystem probe resolves against the TaskGraph Project Boundary supplied by the shell. Ambient cwd is retained only by explicitly documented compatibility entry points.
- **Siblings (DECLARED, paths-declared):** `engine/src/core/phase-artifact-paths.ts` owns path parsing/classification; `engine/src/handlers/subagent-stop/advance-phase.ts` and `pi/subagent-result.ts` are the two shell adapters and must pass their observed graph root. Existing boundary tests in `engine/tests/core/phase-artifact-paths.test.ts`, `engine/tests/handlers/subagent-stop/advance-phase-artifacts.test.ts`, and `engine/tests/pi/phase-artifact-boundary.test.ts` cover the sibling adapters. No sibling is unresolved or out of scope.
- **Selected fixed check:** `project:verify`.
- **Historical RED (DECLARED):** on reviewed HEAD, an absolute `spec_dir` beneath runtime checkout A can be parser-minted while a TaskGraph owned by worktree B is observed; artifact discovery then reads A. The new cross-boundary regression expects refusal and fails against that behavior.

## Advisory dispositions

Published immediately as DECLARED initial policy Run `20260921T194900Z-policy-ef35acf8`, disposition digest `45d81dbd03bb3f1087b8745ef970dc8f9fa008156ccd555c27c586c99d78ec24`, against the exact source result above.

All 13 advisories are **accepted**:

1. `silent-failure-hunter-2` — preserve ambiguity as a distinct, actionable Plan-candidate refusal while remaining fail-closed.
2. `type-design-analyzer-2` — make `ImmutableByteSequence` indexed reads return `number | undefined`, matching runtime property semantics.
3. `type-design-analyzer-3` — retain `ImplementationSettlementReceiptId` and `ImplementationAuthorityDigest` brands in `RemediationPlan`.
4. `comment-analyzer-1` — correct the round-8 Plan’s inverted historical parser statement from “refused” to “accepted”.
5. `comment-analyzer-2` — correct the completion-runner test comment to describe timeout → dissolved probe → close ordering.
6. `comment-analyzer-3` — state that the new timing failure was fixed and only the remaining observed failures were attributed to pre-existing load nondeterminism.
7. `comment-analyzer-4` — remove transient round/reviewer shorthand from production Plan-resolution JSDoc.
8. `code-simplifier-1` — replace nested selection-kind formatting with an exhaustive subject formatter.
9. `code-simplifier-2` — replace nested request-validation conditionals with sequential guards while preserving precedence.
10. `code-simplifier-3` — share the identical non-present leader refusal arm without changing error recording.
11. `code-simplifier-4` — retain only durable resolution-order, containment, and cardinality comments in production.
12. `code-simplifier-5` — centralize `process.kill` spy restoration in existing test cleanup.
13. `code-simplifier-6` — introduce a review-ready Task fixture for repeated Wave Gate setup.

**Deferred:** none.  
**Dismissed:** none.

## Refuted-critical audit

`result.json.refuted_critical_findings` is empty. No refuted Finding will be repaired or represented in Defect-Family Accounting.

## Implementation order

1. Establish a green focused baseline.
2. Repair project-boundary parsing/classification and add cross-worktree/absolute-path regressions.
3. Repair regular-file Plan selection and expose distinct absent vs ambiguous outcomes.
4. Apply accepted type-safety and documentation advisories.
5. Apply accepted behavior-preserving distill moves one at a time, rerunning covering tests after each move.
6. Run engine typecheck, focused suites, and root verification.
7. Start a fresh schema-v2 remediation with this Plan and `scripts/smoke-panel-mode.sh` in `supportPaths`, both Declared Repair Groups, all three exact Finding IDs, and `project:verify`; resume to the verified-index installation outcome.

## Validation commands

Development validation (not registered P3 evidence):

- `cd engine && npx tsc --noEmit`
- `cd engine && env -u PI_CODING_AGENT npx vitest run tests/core/phase-artifact-paths.test.ts tests/handlers/subagent-stop/advance-phase.test.ts tests/handlers/subagent-stop/advance-phase-artifacts.test.ts tests/pi/phase-artifact-boundary.test.ts`
- `cd engine && env -u PI_CODING_AGENT npx vitest run tests/core/context-packet-projection.test.ts tests/core/canonical-structural-equals.test.ts tests/core/implementation-retry.test.ts tests/handlers/helpers/remediate-implementation-escalation.test.ts`
- `cd engine && env -u PI_CODING_AGENT npx vitest run tests/orchestration/completion-check-policy.test.ts tests/orchestration/completion-check-runner.integration.test.ts tests/handlers/helpers/orchestration.test.ts`
- `npm run verify`

Registered P3 evidence: fresh engine observation of `project:verify`, including required report `.loom/completion-reports/verify.junit.xml`, on unchanged candidate bytes.
