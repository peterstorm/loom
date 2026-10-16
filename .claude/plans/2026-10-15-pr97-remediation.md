# PR #97 remediation (review-and-fix round 1)

- **Branch:** `feat/claude-implementation-brief-marker`, HEAD `d7126cd5` at review.
- **Scope:** `all`, the 22 files of the PR diff against `main`.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261015-pr97`.
  - 7 reviewer slots, all captured on attempt 1.
  - Emitted 0 critical and 8 advisory. After refutation: 0 surviving critical, 0 refuted, 8 advisory.
- **Policy publication:** `policy-20261015-pr97`, initial revision (DECLARED). Artifact sha256 `b6a57e39cda56400d8d6061a47e25e81c3e7e1b579960a74c0a2cad5eefb6285`.

## Surviving criticals

None, so the defect family is `not-required`. There are no repair groups, siblings, selected checks or Historical RED declarations.

## Refuted criticals

None.

## Advisory dispositions

| ID | Disposition | Reason and fix |
|---|---|---|
| code-reviewer-1, silent-failure-hunter-1, architecture-tech-lead-1 | accepted | The shim's grep was a second marker grammar. It missed JSON-escaped leading whitespace and blocked prompts that only began with the marker. Fix: with no TaskGraph, the shim keeps its fast exit 0 unless the payload mentions `LOOM_IMPLEMENTATION_BRIEF`. Such a payload goes to the engine route, where `parseImplementationBriefMarker` decides. An unexpandable marker blocks there. |
| pr-test-analyzer-1 | accepted | The wraps on the sibling gates were untested. Fix: a test drives every `SPAWN_VETOES` default export with an unexpandable marker, and each must block naming itself. Real hook-process tests pin the `validate-task-execution` rewrite stdout with exit 0. A second process test shows `validate-agent-skill` admitting a marker because its brief names the skill, while still refusing a non-marker one-liner. |
| architecture-tech-lead-2 | accepted in part | The invariant is now structural and tested: `validate-agent-model` is wrapped too, so every veto expands the marker, and the `SPAWN_VETOES` test fails on any unwrapped veto. A mutation check confirmed this. The per-process re-render is kept, because each wired hook is a separate process that sees only the original input, and a shared render cache would bring its own staleness risk. |
| code-simplifier-1 | accepted | The nested ternary in `hookSuccessStdout` becomes an exhaustive switch helper, `hookSpecificOutputOf`. Output is unchanged. |
| code-simplifier-2 | accepted | The expansion is narrowed once in `validate-task-execution`, and the dead optional chaining is removed. |
| code-simplifier-3 | accepted | `taskId` is dropped from the expanded variant, because no production caller read it. |

## Incident during remediation

The first `types.ts` edit added the call to `hookSpecificOutputOf` before the edit that defined the helper. Loom is installed live from this checkout, so every hook that allows a call crashed on the undefined function. The rules gate then blocked every Edit and Bash call. The operator restored `types.ts` with `git checkout` from the prompt, and the change was re-landed as one edit. Lesson: edit any engine file the live hooks import in a single atomic step, never a call before its definition.

## Validation

- `npx tsc --noEmit` in `engine/`, plus the unused-locals check.
- The `tests/handlers/pre-tool-use/` suite.
- `npm run verify` at the repository root.

## Support paths outside the reviewed scope

- `.claude/plans/2026-10-15-pr97-remediation.md` (this plan)
- `engine/src/handlers/pre-tool-use/validate-agent-model.ts` (now wrapped)
