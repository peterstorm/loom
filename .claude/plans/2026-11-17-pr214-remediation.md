# PR #214 remediation (review-and-fix)

- Branch: `fix/reviewer-packet-identity` (worktree `loom-review-identity`).
- Scope: the PR diff against `origin/main`, split in two slices because the whole diff exceeded the read-coverage budget:
  - `run.pr214-src`: production, docs, agents, references, probes and the smoke script (43 files);
  - `run.pr214-tests`: `engine/tests/**` (53 files).
- Review Run Directories: `.claude/reviews/review-and-fix-runs/run.pr214-src` and `run.pr214-tests`.
- Policy publications: `run.pr214-src-policy` and `run.pr214-tests-policy`.

## Critical findings
None emitted, none surviving, none refuted, in either slice. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

### run.pr214-src
| ID | Decision | Fix / reason |
|----|----------|--------------|
| pr-test-analyzer-1 | dismissed | v4 admission tests exist in the test slice (`reviewer-protocol-wave-v4.test.ts`). |
| pr-test-analyzer-2 | dismissed | Descriptor refusal arms are tested in the test slice. |
| pr-test-analyzer-3 | dismissed | Replacement-issues-v4 is tested in `orchestration.test.ts` and the Wave integration test. |
| type-design-analyzer-1 | accepted | `IssuedReviewerProtocol` becomes a union tying schemaVersion 2 to version 2\|4 and 3 to 3. |
| type-design-analyzer-2 | accepted | Exhaustive version matches in `reviewerFixedSections` and `decodeCurrentPayload`. |
| type-design-analyzer-3 | deferred | Naming the decoder version on stored evidence changes the persisted evidence model. |
| comment-analyzer-1 | accepted | Rewrite the stale "fresh Wave Gate reviews issue v2" paragraph in `docs/standalone-review.md`. |
| comment-analyzer-2 | accepted | Mark the plan's inherit-the-predecessor design as superseded by ADR-0084. |
| architecture-tech-lead-1 | accepted | Same fix as type-design-analyzer-1. |
| architecture-tech-lead-2 | deferred | Wave-only at the packet seam is an interface change; registration and admission enforce it. |
| architecture-tech-lead-3 | deferred | Same as type-design-analyzer-3. |
| architecture-tech-lead-4 | accepted | Same fix as comment-analyzer-2. |
| code-simplifier-1 | accepted | Same fix as comment-analyzer-2. |
| code-simplifier-2 | accepted | `prior_findings` typed via `WaveReviewerPayloadV4`; drop the `ParsedPayloadV2` alias. |
| code-simplifier-3 | deferred | Typing the request program changes the request authority type (deepen). |

### run.pr214-tests
| ID | Decision | Fix / reason |
|----|----------|--------------|
| pr-test-analyzer-1 | accepted | Pin refusal code/path on the two negative tests; add the reverse forgery. |
| pr-test-analyzer-2 | accepted | Wrong-kind and extra-key cases for `parseWaveReviewerPayloadV4`. |
| type-design-analyzer-1 | accepted | Discriminated fixture input: a v4 caller supplies no identity. |
| type-design-analyzer-2 | accepted | `currentWavePayload` parses the stored descriptor with the engine parser. |
| architecture-tech-lead-1 | deferred | Per-cell fixture redesign across suites. |
| architecture-tech-lead-2 | dismissed | An explicit descriptor per packet build is intentional. |
| architecture-tech-lead-3 | deferred | Pre-existing hand-built receipts outside this change. |
| architecture-tech-lead-4 | accepted | One shared fixture `assertNever`. |
| code-simplifier-1 | accepted | Same as architecture-tech-lead-4. |
| code-simplifier-2 | accepted | Derive version from `cell.version`. |
| code-simplifier-3 | accepted | Group the `REVIEWER_PROTOCOL_V2` import with the other core imports. |

## Validation
- `bun scripts/typecheck.ts` (engine), `bun scripts/lint-project.ts` (root).
- vitest on every touched file and the suites importing the changed fixtures.
- `npm run test:smoke` (engine).

## Remediation
- Registered remediation per slice with `defectFamily: {"kind": "not-required"}`.
- `supportPaths`: this plan file, and every touched path outside each slice's frozen scope.
