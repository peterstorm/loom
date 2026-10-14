# PR #90 remediation: Acceptance Stop Check review

- **Branch:** `feat/g4-acceptance-stop-check` (reviewed head `cd214d27`)
- **Scope:** the frozen diff of PR #90, which covers 16 files (`kind: all`, `files: null`).
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261014T162851Z-cd214d27`
  - Reviewer Protocol v2, 7 reviewers.
  - Result digest `a03d0e338424cc6dd8fd4eb7c90552fbb6160c5eeb7766af18f2d4049d380a8c`.
- **Critical findings:** 0 surviving and 0 refuted, so no Refutation Panel ran.
  - Defect family: `not-required`. There are no Declared Repair Groups and no Historical RED declarations.
- **Advisory policy:**
  - Published by `.claude/reviews/review-and-fix-runs/policy-20261014-pr90`.
  - Revision `initial`, provenance DECLARED.
  - Disposition digest `fb121c1a8bd8fca8d0da4d8b3fa6a956187e06fa00cfc7ee67362ba3b89ffd77`.

## Advisory dispositions (all 16 accepted)

| ID | Disposition | Fix |
|----|-------------|-----|
| code-reviewer-1 | accepted | A stale-aware runner lock, one per repository, kept under the subagent dir: `RunnerLock` = acquired \| held. A stop that finds the lock held fails open with a note. |
| silent-failure-hunter-1 | accepted | `blocksIssued` returns `BlockCount` = count \| unreadable{reason}. An unreadable counter produces its own note, never the cap note. |
| pr-test-analyzer-1 | accepted | Production counter tests against a temp `LOOM_SUBAGENT_DIR`: counting, independent keys, clearing, and corrupt or malformed counters. |
| pr-test-analyzer-2 | accepted | `stopCheckReportLine` tested over all four outcomes. The report-only ports are shown to persist no counter. |
| pr-test-analyzer-3 | accepted | The dispatch test asserts the note's `systemMessage`. A new crash case shows a throwing port becomes a note and the Task still settles. |
| type-design-analyzer-1 | accepted | `OwedStopCheck` is branded with a unique symbol, so only `stopCheckExpectation` can construct it. |
| type-design-analyzer-2 | accepted | `runnerReportConflicts` runs over report policies on both the source parse and the frozen parse. |
| comment-analyzer-1 | accepted | The plan's Design bullet now matches the implemented `unobservable` and `failing` semantics. |
| comment-analyzer-2 | accepted | The doc comment now says the expectation is judged per roster testcase. |
| comment-analyzer-3 | accepted | A distinct `skipped` outcome is reported as "skipped". |
| comment-analyzer-4 | accepted | operations.md separates the silent skip cases from the `systemMessage` notes. |
| architecture-tech-lead-1 | accepted | `runAcceptanceStopCheck` is total and takes `loadGraph`. Both callers dropped their try/catch. |
| architecture-tech-lead-2 | accepted | Same fix as type-design-analyzer-2. |
| architecture-tech-lead-3 | accepted | The runner lock (as in code-reviewer-1). `clearBlocks` runs on every stop that proceeds. The concurrency limit is documented. |
| code-simplifier-1 | accepted | Renamed `blockingPorts` to `inertPorts`. |
| code-simplifier-2 | accepted | A module-private `readBlocks` replaces the self-reference, and `recordBlock` takes the new count. |

## Validation

- `npx tsc --noEmit -p engine` passes; the only output is the known `@fuguejs` fixture noise.
- The targeted vitest files pass:
  - core stop-check;
  - shell stop-check;
  - dispatch stop-check;
  - verification-manifest.
- `npm run verify` covers prerequisites, typecheck, the full Vitest suite and all six smokes.

## Remediation

Start a registered remediation run with `defectFamily: not-required`. Its `supportPaths` is this plan file.
