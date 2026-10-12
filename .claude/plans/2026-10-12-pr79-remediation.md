# PR #79 remediation

- **Branch:** `feat/53-slice-5`
- **Scope:** the 25 files of PR #79 (the frozen diff of review run `pr79-review-2`)
- **Review run:** `.claude/reviews/review-and-fix-runs/pr79-review-2`, result digest `0d973ba4…`.
  - `pr79-review-1` was abandoned and superseded. Its scope included an untracked third-party cache, `engine/src/handlers/pre-tool-use/.impeccable/hook.cache.json`, which is now excluded locally through `.git/info/exclude`.
- **Result:**
  - 0 critical emitted or admitted;
  - 0 surviving and 0 refuted critical;
  - 19 advisory.
  - All 7 reviewers were admitted on attempt 1.

## Critical findings

None. `defectFamily` is `not-required`.

## Advisory dispositions (DECLARED)

Published in `pr79-policy-1` (initial revision, digest `e2f87c1e…`): 12 accepted and 7 dismissed.

| Theme | Findings | Decision |
|---|---|---|
| `InferredTaskId` brand erased at consumers | silent-failure-hunter-1, type-design-analyzer-1, architecture-tech-lead-1, code-simplifier-1 | **Accepted.** The illusory brand is removed, and the docs name the real type barrier, `ImplementationAttemptAuthority`. |
| Guard regex too narrow; header overclaims | pr-test-analyzer-2, comment-analyzer-1, architecture-tech-lead-2 | **Accepted.** The guard now covers `.at(0)`, destructuring and loose or strict length-1 tests, each pinned, and the header names exactly what is refused. The architecture finding's suggestion to take the graph instead of the array is declined: Pi's pure resolver receives the executing set as an argument by design. |
| Parent-prompt attribution not tested end to end | pr-test-analyzer-1 | **Accepted.** New subagent-result test. |
| Ambiguous caller not tested at the handler | pr-test-analyzer-3 | **Accepted.** New fail-closed handler test. |
| Pi docblock contradicts itself | comment-analyzer-2 | **Accepted.** Reworded. |
| Plan omissions | comment-analyzer-3 | **Accepted.** As implemented now covers the CONTEXT.md placement and the line-citation caveat. |
| Repeated `Extract<…>` type | code-simplifier-2 | **Accepted.** `BoundImplementationTask` replaces it. |
| Nullable intermediate in the unreadable-transcript path | code-simplifier-4 | **Accepted.** Narrowed once. |
| Duplicate instruction in the template | code-simplifier-6 | **Accepted.** Workflow step 2 is reverted. |
| Brace tokens in dependency descriptions | code-reviewer-1, type-design-analyzer-2 | **Dismissed.** Unreachable: a completed dependency's description already passed the residual-placeholder check as its own brief's `{task_description}`. |
| ReviewPath coupling, roster input, Dependencies line | architecture-tech-lead-3 | **Dismissed.** ReviewPath is the State File boundary's own path brand, the roster is needed for typed refusal, and the Dependencies line is the header summary. |
| Shared source walker | code-simplifier-3 | **Dismissed.** Taste: the two walkers have different roots and exclusions. |
| Fold the plan's design into As implemented | code-simplifier-5 | **Dismissed.** The decision record keeps the decided design and its delta. |

## Validation

- `tsc --noEmit` is clean.
- The affected Pi, settlement, attribution and gate tests pass.
- Full `npm run verify` is run before the registered remediation.

## Registered remediation

`defectFamily: not-required`. Support path: this plan file.

## Round 3 (`pr79-review-3`)

- **Scope:** commit `859c7c57`, 27 files.
- **Result:**
  - 0 critical;
  - 9 advisory;
  - all 7 reviewers admitted on attempt 1, two of them with no findings.
- **Decisions:** published in `pr79-policy-3` (initial revision, digest `da3d5dd5…`). 5 accepted, 4 dismissed.

| Finding | Decision |
|---|---|
| architecture-tech-lead-3: two attribution vocabularies | **Accepted.** `TaskAttribution` and `unprovenAttributionReason` move to `core/task-attribution.ts`. Pi's `unprovenAttribution` delegates to them, and the Claude legacy warning uses the same text. |
| comment-analyzer-1: the "can only quarantine" wording omits stored evidence | **Accepted.** The module header, `docs/deterministic-core.md` and this plan now say that a guess settles through the untrusted legacy resolution, which stores evidence but leaves the Task pending for revalidation. |
| code-simplifier-1, 2, 3 | **Accepted.** One freeze in `phaseGateTarget`; `pre`/`post` take an optional `agentId`; a local `bound()` constructor in the Pi resolver. |
| pr-test-analyzer-1: failed-path parent-prompt test | **Dismissed.** Unreachable: the failed path always passes an empty parent prompt. |
| type-design-analyzer-1, architecture-tech-lead-2: guard is textual | **Dismissed.** Decided in round 2; the barrier is `ImplementationAttemptAuthority`. |
| architecture-tech-lead-1: `soleActiveBinding` port | **Dismissed.** It delegates to the same pure `resolveSoleActiveBinding`, so the rule has one owner. |
