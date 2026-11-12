# PR #160 remediation — Q3–Q6 implementation gates

- **Branch:** `feat/q3-q6-implementation-gates` (PR #160), reviewed at `05120e52`
- **Scope:** the whole PR diff (168 files), reviewed in five explicit `files` slices because the diff exceeds one reviewer's 240,000-unit read budget
- **Runs root:** `.claude/reviews/review-and-fix-runs`
- **Remediation run:** `remediation.pr160-r1`

## Review runs

| Slice | Run | Files | Reviewers | Critical | Advisory | Result digest | Policy run | Disposition digest |
|---|---|---|---|---|---|---|---|---|
| Q3 plan design + contract surface | `run.pr160-q3` | 38 | 7 | 0 | 17 | `77329dbc…1b31683` | `policy.pr160-q3` | `2d02053a…d4e9f832` |
| Q4 task mutation check (source, docs) | `run.pr160-q4` | 18 | 7 | 0 | 14 | `5332b6e7…599bd0d56` | `policy.pr160-q4` | `d2dac0d1…ced2bcc9` |
| Q4 tests | `run.pr160-q4t` | 23 | 6 | 0 | 6 | `3d3bff19…65b3bb6d` | `policy.pr160-q4t` | `bd3476ba…7d67bc4f` |
| Q5 documented wire examples | `run.pr160-q5` | 40 | 7 | 0 | 8 | `d14895ee…5f5df473` | `policy.pr160-q5` | `37729daa…2efcda46` |
| Q6 no-wire-cast | `run.pr160-q6` | 49 | 7 | 0 | 13 | `baa28e24…95f0aa55` | `policy.pr160-q6` | `9969bd21…2c90ced5` |

No critical finding was raised, so no Refutation Panel ran and the defect family is `not-required`.
In `run.pr160-q5` the code-simplifier's first attempt was refused for incomplete read coverage and its retry was admitted.

## Dispositions (58 advisories: 51 accepted, 5 deferred, 2 dismissed)

Every advisory not listed below is **accepted** and fixed in this remediation.

| Run | Finding | Decision | Reason |
|---|---|---|---|
| q3 | architecture-tech-lead-2 (record roster reasons on the Review Run) | deferred | Changes the persisted State File schema and reverses a limit ADR-0069 accepts; needs its own ADR amendment and migration. |
| q3 | architecture-tech-lead-6 (Wave packet section registry) | deferred | Speculative with two sections; revisit with a third. |
| q4t | architecture-tech-lead-1 (optional `taskMutation`) | dismissed | Required on purpose: an optional arm defaulting to "no check owed" lets production omit it silently. |
| q4t | architecture-tech-lead-2 (per-check descriptor map) | deferred | Rewrites core stop-check types for a hypothetical fourth check. |
| q6 | type-design-analyzer-2 (`parsePiEntry` drops mistyped fields) | dismissed | Tolerant read is the documented, tested contract; no consumer needs malformed vs absent. |
| q6 | architecture-tech-lead-2 (two Task shape enforcers) | deferred | Redesign of the TaskGraph validator and its `--fix` path; separate change. |
| q6 | architecture-tech-lead-4 (extract the text scanner) | deferred | Reviewer recommends waiting for a second consumer. |

## Fix groups

### A — Plan design review (q3) and decompose population (q6)
- pr-test-analyzer-1: test `readPlanDesignEvidence` derivations (`readObligated`, plan unobserved, plan changed under lock) through a real Run Directory.
- pr-test-analyzer-3: test `--skip-plan-design-review` argument wiring in `cli.ts`.
- type-design-analyzer-1: brand the digest, role and kind strings in `PlanDesignEvidence` / `PlanDesignGate`.
- type-design-analyzer-3: re-hash the plan inside the lock in `accept-plan-design-review.ts`.
- comment-analyzer-2: correct ADR-0070's "authenticates the Run twice" and the `dispositionPublished` comment.
- architecture-tech-lead-1: one per-kind review profile for the plan-design kind policy.
- architecture-tech-lead-3: `populate-task-graph` asks the plan design gate.
- architecture-tech-lead-4: `currentPlan` uses the shared review-path canonicalisation; stop importing `realArtifactProbe` from a pre-tool-use handler.
- architecture-tech-lead-5: one authenticated read in `readPlanDesignEvidence`.
- code-simplifier-2, -3: share the `bad` helper; resolve the plan artifact once.
- q6 pr-test-analyzer-2: handler tests for the two new `populate-task-graph` refusals.

### B — Contract surface (q3) and documented wire examples (q5)
- q3 pr-test-analyzer-2: pin ADR-0069's two known limits with tests.
- q3 type-design-analyzer-2 + code-simplifier-1: replace the positional boolean / reference comparison in `contractSurfacesReviewed`.
- q3 comment-analyzer-1: fix the stale issuance comment in `wave-review-authority.ts`.
- q5 silent-failure-hunter-1: `scanDoc` accepts any fence info string (first token is the language).
- q5 type-design-analyzer-1: parse `shapeId` once into `WireShapeId`.
- q5 comment-analyzer-1 + code-simplifier-3: the ungoverned-list test checks existence and is titled for what it proves.
- q5 architecture-tech-lead-1: move `parseReopenRequest` and `parseUserDecision` to the functional core, returning a Result.
- q5 architecture-tech-lead-2: remove the free-text `parser` label drift in `WireShape`.
- q5 code-simplifier-1, -2: export `SECURITY_PLACEHOLDERS`; one shared JSON-array guard in test support.

### C — Task mutation check (q4, q4t)
- silent-failure-hunter-1: an all-`invalid` mutant run is `inconclusive`, never "clean"; report an `invalid` count.
- pr-test-analyzer-1: handler-level tests for `createMutationCheckHandler`.
- type-design-analyzer-1, -2: injective Task id → record file mapping; smart constructor for `TaskMutationResult`.
- comment-analyzer-1, -2: correct both module headers.
- architecture-tech-lead-1, -2, -3 and code-simplifier-1..5: reuse `someChecks`, shared runner-internals module, one `ABSENCE_CODES`, drop the `applyMutant` alias, flatten `classifyTaskBaseline`, shared classify prelude, `mutationResult` takes `resolvedRoot`.
- q4t architecture-tech-lead-3, code-simplifier-1..3: one manifest fixture; drop the fixture-only assertion; derive the SC-005 bound; drop the double cast.

### D — no-wire-cast and wire parsing (q6)
- pr-test-analyzer-1: drop the absolute wall-clock bound, keep the linear-growth ratio guard; ADR-0072 updated.
- type-design-analyzer-1: `RetainedRefutationPanelCheckpoint` keeps the validated type, no unreachable null branch.
- comment-analyzer-1: state the early-exit condition as implemented (docstring, README, ADR-0072, test title).
- architecture-tech-lead-1 + code-simplifier-1: one `isRecord` (`core/plain-record`).
- architecture-tech-lead-3: one `failClosedInput` helper for the six fail-closed PreToolUse handlers.
- code-simplifier-2, -3, -4: flatten the nested ternary; reuse `isRecord` in `scripts/lint-project.ts`; shared `json-wire` test fixture.

## Validation

```bash
cd engine && bun x tsc --noEmit
bun scripts/lint-project.ts --summary
cd engine && env -u PI_CODING_AGENT npx vitest run
bun scripts/stamp-wire-contract.ts --check
```

Known local-only failure: `tests/verification-command.test.ts` (Bun 1.4.4 against the pinned 1.4.2).
