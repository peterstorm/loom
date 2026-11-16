# PR #188 remediation plan (review-and-fix)

- **Branch:** `feat/judged-paths-and-remediation-task`
- **Scope:** the whole PR diff against `main`, reviewed in three slices, because the frozen diff exceeded the read-coverage budget:
  - `run.pr188-review-core`: `engine/src/core/{forward-fix,judged-paths,dispatch-holds,implementation-window,validate-task-execution,task-graph-population}.ts`, `engine/src/orchestration/implementation-brief.ts`, `engine/src/handlers/helpers/{add-forward-fix,orchestration-operations,subagent-quiescence,validate-task-graph}.ts`, `engine/src/types.ts`
  - `run.pr188-review-wire`: `engine/src/state-file-wire.ts`, `engine/src/handlers/helpers/orchestration.ts` and the five new test and fixture files
  - `run.pr188-review-docs`: the eleven changed documentation files
- **Review Run Directories:** `.claude/reviews/review-and-fix-runs/run.pr188-review-{core,wire,docs}`

## Surviving critical Findings

None in any slice: 0 emitted critical, 0 refuted. No Declared Repair Group, so the remediation uses `defectFamily: {"kind":"not-required"}`.

## Refuted Findings

None.

## Advisory dispositions (DECLARED)

Published by `standalone-disposition` runs `run.pr188-policy-core`, `run.pr188-policy-wire` and `run.pr188-policy-docs`. Each holds the exact ordered inventory with its reason.

**core (16).**
- Accepted: code-reviewer-1, silent-failure-hunter-1, pr-test-analyzer-1, pr-test-analyzer-2, type-design-analyzer-2, architecture-tech-lead-1, architecture-tech-lead-3, architecture-tech-lead-4, code-simplifier-1 through code-simplifier-5.
- Dismissed: type-design-analyzer-1. The reason invariant is enforced at both boundaries, the same as the sibling TaskReopeningAudit.
- Dismissed: architecture-tech-lead-2. Argv parsing beside its command is the project idiom, as in `parseTaskReopeningArgs`.
- Deferred: type-design-analyzer-3. Branding the validator's internal view would mean threading branded types through the untyped validator.

**wire (9).**
- Accepted: pr-test-analyzer-1, pr-test-analyzer-2, pr-test-analyzer-3, type-design-analyzer-1, architecture-tech-lead-1, code-simplifier-1, code-simplifier-2.
- Deferred: architecture-tech-lead-2. The two audit parsers prove different membership rules, and there is no third caller.
- Dismissed: code-simplifier-3. A FIELDS constant beside an explicit literal is the sibling parsers' idiom.

**docs (3).**
- Accepted: comment-analyzer-1, architecture-tech-lead-1.
- Deferred: architecture-tech-lead-2. Persisting judged_paths is a new feature, and its residual risk is recorded in the ADR.

## Accepted fixes

1. **Forward Fix shell keeps refusals typed** (core silent-failure-hunter-1, architecture-tech-lead-1). A dedicated `ForwardFixRefused` error carries the `ForwardFixRefusal` out of the locked update. Only it is reported as "refused without changing state"; any other failure is reported as a failed operation, with the State File possibly unknown.
2. **Single-flag lookup by own property** (core code-reviewer-1).
3. **Whole-history idempotent replay** (core architecture-tech-lead-3) with a `sameList` helper (code-simplifier-3).
4. **Hold wording owned by dispatch-holds.ts** (core architecture-tech-lead-4, code-simplifier-5). `forwardFixHolders` becomes private (code-simplifier-1), and TaskId is kept through the hold with no casts (type-design-analyzer-2).
5. **Parsing helpers** use local ok/fail constructors (code-simplifier-2), and `heldTaskRefusal` evaluates `isDistillTask` once (code-simplifier-4).
6. **Loader proves sealed paths** were written by a Task of an earlier Wave (wire type-design-analyzer-1). It simplifies the `abandonedRunId` and foreign-held handling (code-simplifier-2).
7. **Tests:**
   - successor-named, wave-completed, frozen-path and not-executing refusals (core pr-test-analyzer-1, pr-test-analyzer-2);
   - typed refusal rows (wire architecture-tech-lead-1, code-simplifier-1);
   - an abandonedRunId round trip and the extra tamper rows (wire pr-test-analyzer-1, pr-test-analyzer-2);
   - the dispatcher route (wire pr-test-analyzer-3).
8. **Docs:** the ADR states that judged_paths is emitted on every Task and that an absent field is read as `[]` (docs comment-analyzer-1). Rule 13 and the ADR describe the same-Wave case (docs architecture-tech-lead-1).

## Validation (operator runs; not remediation evidence)

```bash
cd engine
npx tsc --noEmit -p .
env -u PI_CODING_AGENT npm run lint
env -u PI_CODING_AGENT npx vitest run tests/core/forward-fix.test.ts tests/handlers/helpers/add-forward-fix.test.ts \
  tests/core/judged-paths.test.ts tests/handlers/validate-task-graph-judged-paths.test.ts tests/core/distill-dispatch.test.ts \
  tests/core/task-reopening.test.ts tests/handlers/helpers/orchestration.test.ts tests/docs
```

The registered remediation (`run.pr188-remediation-1`, source `run.pr188-review-core`) runs the manifest's own checks. Paths outside the core slice are named in `supportPaths`.
