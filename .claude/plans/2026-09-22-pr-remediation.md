# PR Remediation — 2026-09-22

## Authority

- Branch: `fix/abandoned-gate-terminal-outcome`
- Reviewed HEAD: `51fcdd02dd3c9b927ba67bc0937173dd65160311`
- Scope: the exact 112-path scope published in the Standalone Review result.
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-fix-20260922T064801Z-51fcdd02`
- Review result digest: `969f7e4b06fc5d0326b7ecc6f9041c5774e68b078c8e92b9e3d7376b4ea4c60c`
- Advisory policy publication: `.claude/reviews/review-and-fix-runs/policy-20260922T070000Z-51fcdd02`
- Policy revision: initial, disposition digest `81d3028c0a16f2dbbcc4bb5ded1dfaca852270589e78867a1ab52a91efe89c34`
- Provenance: grouping, causes, invariants, siblings, Historical RED, and advisory policy below are `DECLARED`. Only the registered remediation runner may later report selected checks as `ENGINE_OBSERVED`.

## Surviving-critical dispositions

Every canonical Finding ID is retained exactly once.

| Finding | Disposition | Declared Repair Group |
|---|---|---|
| `code-reviewer-1` | repaired | `group.phase-artifact-no-follow` |
| `silent-failure-hunter-1` | repaired | `group.wave-document-project-boundary` |
| `silent-failure-hunter-2` | repaired | `group.phase-artifact-no-follow` |
| `silent-failure-hunter-3` | repaired | `group.plan-fallback-authority` |
| `pr-test-analyzer-1` | repaired | `group.adapter-boundary-regressions` |
| `type-design-analyzer-1` | repaired | `group.phase-artifact-no-follow` |

## Declared Repair Groups

### `group.phase-artifact-no-follow`

- Finding IDs: `code-reviewer-1`, `silent-failure-hunter-2`, `type-design-analyzer-1`
- Root cause (`DECLARED`): phase-artifact existence and content observation used pathname APIs that followed leaf and ancestor symlinks after only lexical containment.
- Invariant (`DECLARED`): every phase-artifact probe/read is rooted at the TaskGraph Project Boundary and refuses any symlink component before bytes can authorize a Phase transition.
- Siblings (`DECLARED`):
  - `engine/src/handlers/subagent-stop/advance-phase.ts` — repair existence, marker reads, recursive discovery, and Plan fallback enumeration.
  - `engine/src/orchestration/wave-spec-check-documents.ts` — use the same rooted no-follow byte observation for downstream Wave authority.
  - `engine/src/orchestration/no-follow-fs.ts` — reuse its existing anchored primitives; no separate filesystem authority implementation.
  - Status: Wave observation is repaired; the existing no-follow primitive is checked unmodified and reused; no unresolved/out-of-scope sibling declared.
- Selected check: `project:verify`
- Historical RED (`DECLARED`): reviewer reproductions at reviewed HEAD accepted project-local Spec/Plan symlinks targeting external regular files and returned ready transitions.

### `group.wave-document-project-boundary`

- Finding IDs: `silent-failure-hunter-1`
- Root cause (`DECLARED`): Wave spec-check document observation resolved graph-relative paths against ambient `process.cwd()` because the project root was absent from the observer interface.
- Invariant (`DECLARED`): every Wave spec/Plan observation receives and uses the TaskGraph Project Boundary; no production adapter may infer it from cwd.
- Siblings (`DECLARED`):
  - `engine/src/handlers/helpers/programs/wave-gate.ts` — all initial, replay, submission, resume, and completion observations.
  - `pi/subagent-result.ts` and `pi/extension.ts` — successful and failed Pi spec-check settlement paths receive the already-observed TaskGraph boundary.
  - `engine/tests/handlers/helpers/wave-spec-check-scope.test.ts`, Wave Gate integration callers, and Pi tests — update explicit observer authority and add split-root pins.
  - Status: all identified observation call paths repaired; no unresolved/out-of-scope sibling declared.
- Selected check: `project:verify`
- Historical RED (`DECLARED`): the reviewer executed a split-checkout observation whose digest matched runtime checkout A instead of graph-owned checkout B.

### `group.plan-fallback-authority`

- Finding IDs: `silent-failure-hunter-3`
- Root cause (`DECLARED`): the pure Claude transition reducer recorded the selected architecture artifact but did not promote that fallback into `plan_file`.
- Invariant (`DECLARED`): an eligible architecture transition atomically records its selected Plan as both the architecture phase artifact and current `plan_file` authority.
- Siblings (`DECLARED`):
  - `engine/src/handlers/subagent-stop/advance-phase.ts` — align the shared transition reducer with the existing Pi transition update behavior.
  - `engine/tests/handlers/subagent-stop/advance-phase.test.ts` — pin fallback promotion and immutable state.
  - `pi/subagent-result.ts` — repaired elsewhere in this candidate for Wave project-root authority; its existing Plan promotion is checked and remains aligned.
  - Status: the registered sibling status is `repaired` because the Pi module changes elsewhere in the candidate; no unresolved sibling declared.
- Selected check: `project:verify`
- Historical RED (`DECLARED`): the reviewer applied a ready fallback transition and observed `phase_artifacts.architecture` updated while `plan_file` remained the known-missing path.

### `group.adapter-boundary-regressions`

- Finding IDs: `pr-test-analyzer-1`
- Root cause (`DECLARED`): existing cross-worktree tests entered the shared resolver or used a non-authoritative brainstorm write, so neither production adapter's transcript-derived Spec/Plan classification was discriminated.
- Invariant (`DECLARED`): split-root adapter tests submit a foreign absolute `spec.md` or Plan transcript write and prove neither Claude nor Pi persists it as authority.
- Siblings (`DECLARED`):
  - `engine/tests/handlers/subagent-stop/advance-phase-artifacts.test.ts` — Claude production handler regression.
  - `engine/tests/pi/phase-artifact-boundary.test.ts` — Pi production applier regression.
  - Status: both adapters covered; no unresolved/out-of-scope sibling declared.
- Selected check: `project:verify`
- Historical RED (`DECLARED`): static trace showed the prior tests remain green if transcript classification is reverted to cwd anchoring.

## Advisory dispositions

| Finding | Decision | Reason / accepted fix |
|---|---|---|
| `comment-analyzer-1` | accepted | Correct `docs/operations.md` to separate platform-neutral prerequisites from Linux-only Bash/GNU timeout requirements. |
| `comment-analyzer-2` | accepted | State the workflow's 60-minute CI job budget while retaining the 30-minute Verification Manifest limit. |
| `comment-analyzer-3` | accepted | Correct the round-9 remediation record so it attributes the directory regression only to the test that contains it. |
| `comment-analyzer-4` | accepted | Remove transient reviewer identifiers from the public-kernel comment while retaining durable ownership rationale. |
| `architecture-tech-lead-1` | deferred | An immutable all-input Wave observation redesign is broader than this authority repair and needs dedicated interface design/migration. |
| `architecture-tech-lead-2` | deferred | A full Wave lifecycle command/effect reducer is a cross-cutting crash-recovery redesign; ADR-0005 also requires concrete shared computation rather than a generic driver. |
| `architecture-tech-lead-3` | deferred | Named TaskGraph commands require a multi-caller aggregate migration and lock-time authority design beyond this repair. |
| `code-simplifier-1` | accepted | Reuse `resolvesWithin` in `projectRootForStateFile`. |
| `code-simplifier-2` | accepted | Narrow `requireNonEmptyGitOutput` to successful `Buffer` input. |
| `code-simplifier-3` | accepted | Remove the one-use `parseAttestArgs` pass-through. |
| `code-simplifier-4` | accepted | Reuse one errno-bearing test fixture in completion-check runner integration tests. |

No advisory is dismissed.

## Refuted-critical audit

`result.json.refuted_critical_findings` is empty. The Refutation Panel upheld all six critical Findings under reproduction, intent, and security lenses; there is no refuted Finding to repair or omit.

## Planned files and validation

Implementation stays within reviewed scope except this Plan and two required Wave-document observation siblings omitted from the frozen review scope: `engine/src/orchestration/wave-spec-check-documents.ts` and `engine/src/handlers/subagent-stop/store-spec-check-findings.ts`. All three must be listed as remediation `supportPaths`.

Validation commands:

1. Focused Vitest suites for phase transition, adapter boundary, Wave document authority, Git remediation, attestation, and completion-check runner changes.
2. `npm run verify` (the operator-owned `project:verify` command), producing a fresh `.loom/completion-reports/verify.junit.xml` with positive tests and zero failures.
3. Registered schema-v2 remediation with all four Declared Repair Groups selecting `project:verify`, then read the actual installation receipt and `repair-checked` assessment from the external outcome.
4. Commit the engine-installed exact index and push without force.
