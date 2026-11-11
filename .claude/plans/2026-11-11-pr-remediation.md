# PR #159 remediation — 2026-11-11

- **Branch:** `feat/q1-distill-task` (PR #159, base `main`), reviewed at `d222981a`.
- **Scope:** the PR's 138 changed files. The diff (818 KB) exceeds one reviewer's
  240,000-unit read budget, so it was reviewed as four explicit `files` slices.
- **Runs root:** `.claude/reviews/review-and-fix-runs`

| Run | Files | Reviewers | Critical (surviving / refuted) | Advisory |
|---|---|---|---|---|
| `run.pr159-s1` | 32 | 7 | 0 / 0 | 15 |
| `run.pr159-s2` | 42 | 6 | 0 / 0 | 13 |
| `run.pr159-s3` | 24 | 6 | 0 / 0 | 7 |
| `run.pr159-s4b` | 38 | 7 | 0 / 0 | 9 |
| `run.pr159-s4` | 40 | — | abandoned | — |

`run.pr159-s4` was abandoned: `guard-subagent-authority` refuses a subagent's
reader call that names a `machines/` path (a protected Loom directory when the
subagent's cwd is the Loom checkout), so no reviewer could meet the read
obligation. `run.pr159-s4b` is the same slice without `machines/README.md` and
`machines/distill-agent.machine.json`. **Those two files have no registered
review.** The parent read both diffs (DECLARED, unregistered) and found nothing;
`engine/tests/machine/distill-agent-machine.test.ts` pins the machine and the
README's generated diagram.

## Critical findings

None survived and none was raised, so there is no Declared Repair Group, no
sibling accounting, no selected check and no refuted finding to audit.
Remediation input: `defectFamily: {"kind":"not-required"}`.

## Advisory dispositions

Published by the engine (`standalone-disposition`, revision `initial`):

| Policy run | Source | Disposition digest |
|---|---|---|
| `policy.pr159-s1` | `run.pr159-s1` | `6b66cb613ff3d948531a0f657cc1080bdbd33cea31f0fbcc6f0b97cbe8432d77` |
| `policy.pr159-s2-r2` (correction of `policy.pr159-s2`, `938a44c0…`) | `run.pr159-s2` | `e6b05c03b30b543881dc981eaab4b7c6830fef2a432821981dc9a4791cd53502` |
| `policy.pr159-s3` | `run.pr159-s3` | `3a75a23c3e3ae0b0e6e72fe04667b637addc6cfa552bd55ed141339909bf80e1` |
| `policy.pr159-s4b` | `run.pr159-s4b` | `975f01cddd69c8a69c9a3901b0d94cb8dacc263906f5c09c4d7d8b7b7eb7faa2` |

41 accepted, 1 deferred, 2 dismissed (after one correction). IDs are `result.json` IDs within the named run.

- **Dismissed — s2 `architecture-tech-lead-2`** (`firstCallSetup` in the Rule
  contract): the flag replaced a comment-only ordering rule in `d222981a`; moving
  the warm-up to the loader takes it outside the executor, the only owner of the
  per-invocation deadline. s2 `code-simplifier-2` removes the double filter.
- **Deferred — s3 `architecture-tech-lead-2`** (a parsed `DistillTask` variant of
  the Task union): an ADR-level change to the State File model across every
  lifecycle module; the load boundary already refuses each illegal shape, and the
  accepted Task-role policy record gives the rules one owner meanwhile.

### Accepted fixes, by work package (disjoint file sets)

**A — proof, snapshot, settlement**
- s1 `pr-test-analyzer-1`: test `parseModifiedFiles` on malformed `filesModified`.
- s1 `type-design-analyzer-1`: `ObservedProofEvidence` as a union so `restoredAfter` cannot sit beside non-empty `filesModified`.
- s1 `architecture-tech-lead-2`, `code-simplifier-3`, `code-simplifier-4`: one `distillSettlementOutcome` owning restore decision, failure kinds and retention.
- s1 `code-simplifier-1`, `code-simplifier-2`: drop the unreachable provenance fallback and the identity `mapNonEmpty`.
- s2 `silent-failure-hunter-1`: `removeLeaf` swallows only ENOTEMPTY/ENOENT.
- s2 `silent-failure-hunter-2`: stderr note when a rollback cannot discard a snapshot.
- s2 `code-simplifier-3`: one `withheldBecause` helper in the settlement shell.
- s4b `architecture-tech-lead-1`, `pr-test-analyzer-1`: the settlement shell owns persist-then-release; both transports call one entry point; the ordering is tested once, plus the Pi call site.
- s4b `code-reviewer-1`: fixed reservation labels instead of `Math.random()`.
- s4b `code-simplifier-1`: shared Distill test helpers in `engine/tests/fixtures`.

**B — Task role, population, skeletons, Wave review**
- s1 `silent-failure-hunter-1`: population note when no Distill Task is planned for want of a frozen classification.
- s1 `architecture-tech-lead-1`, `type-design-analyzer-2`, `architecture-tech-lead-3`: one closed Task role with a policy record; `isDistillTask` a type guard; `populatedTask` takes the role.
- s1 `type-design-analyzer-3`: an explicit skeleton outcome for a Distill Task's absent bound file.
- s1 `code-simplifier-5`: hoist `carriesLabel(DISTILL_APPENDIX_LABEL)`.
- s2 `pr-test-analyzer-1`: tests for the authored-Distill refusal and the waiver-warning exemption in `validate-task-graph`.
- s2 `type-design-analyzer-2`: `WaveTaskReview` as a tagged union.
- s2 `architecture-tech-lead-1`: one Wave-review view consumed by gate checks, drivers and renderers.
- s3 `code-simplifier-3`: one shared `sibling`/`fileOf` fixture.
- s4b `code-simplifier-3`: imports before the helper in `populate-task-graph.test.ts`.

**C — revalidation, reopening, State File wire**
- s2 `type-design-analyzer-1`, `architecture-tech-lead-4`, `code-simplifier-4`; s3 `type-design-analyzer-1`, `architecture-tech-lead-1`: one owner for the swept-Distill-Task fact — `revalidationTargets` returns branded named and swept ids, the completed-Wave path uses it instead of a counterfactual, the audit is built by one constructor, and the two audit meanings are named.
- s3 `code-simplifier-1`: first-seen-by-Wave map in `distillTaskPerWaveError`.
- s3 `code-simplifier-2`: drop the unreachable guard in `parseDistinctTaskIds`.
- s3 `code-simplifier-4`: state "absent or non-empty" directly in the reopening test.

**D — linter, scripts, docs**
- s2 `architecture-tech-lead-3`, s4b `architecture-tech-lead-2`: one project clone-lint context built once; an authoritative corpus is a distinct type from a cache-assisted one.
- s2 `code-simplifier-1`: **dismissed on correction** — the linter boundary config grants `engine/src/linter/clones/` no import from `core/plain-record`; the private guard stays.
- s2 `code-simplifier-2`: `hasFirstCallSetup` as a type predicate.
- s4b `comment-analyzer-1`, `comment-analyzer-2`: `--init` help wording; executor test comment states the invariant.
- s4b `code-simplifier-2`: drop the pass-through local in `reviewer-protocol-wave.integration.test.ts`.
- s1 `code-simplifier-6`, `code-simplifier-7`: `agents/distill-agent.md` runner table; the garbled bullet in `docs/operations.md`.

## Validation (development runs, not registered evidence)

From the worktree:

```bash
cd engine && npm run typecheck
bun scripts/lint-project.ts --summary
cd engine && npm run test:unit
```

Known local limit: `tests/verification-command.test.ts` fails 15 cases under
local Bun 1.4.4 against the `.bun-version` 1.4.2 pin, on `main` as well.

## Registered remediation

One schema-v2 run against `run.pr159-s1`, `defectFamily: not-required`,
`supportPaths` naming this plan and every changed path outside that run's frozen
scope.

## Outcome notes (DECLARED)

- s1 `architecture-tech-lead-2`: the single `distillSettlementOutcome` landed; the
  reviewer's further idea of a type-only leaf module for the structurally
  duplicated views was not done (compile-time assignability assertions in
  `engine/tests/core/task-role.test.ts` guard the drift instead).
- s1 `silent-failure-hunter-1`: the population note is tested in core; the
  handler's stderr line for `no-frozen-classification` has no handler-level test.
