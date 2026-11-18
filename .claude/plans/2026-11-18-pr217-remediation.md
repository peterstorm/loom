# PR #217 remediation (loom#199 Cause 2b: add-task replaces Forward Fix)

- Branch: `feat/retire-forward-fix-holds` (worktree `loom-retire-holds`)
- The scope was too large for one review (258702 units against the 240000 budget), so it was split into two runs:
  - `.claude/reviews/review-and-fix-runs/pr217-review-a`: every changed file outside `engine/tests/` (31 files). Result digest `e7a0a4e1…bc77`.
  - `.claude/reviews/review-and-fix-runs/pr217-review-b`: the changed files under `engine/tests/` (7 files). Result digest `5639bbfa…8231`. The engine retried pr-test-analyzer once for incomplete read coverage.
- Policy publications: `pr217-policy-a` and `pr217-policy-b`.

## Engine-observed counts
- Slice A: 16 findings, all advisory.
- Slice B: 5 findings, all advisory.
- No critical findings survived or were refuted. Defect family: `not-required`.

## Advisory dispositions (DECLARED)
- Slice A: 10 accepted, 4 deferred, 1 dismissed. Each reason is in `pr217-policy-a`.
  - Deferred: branded ids in the edit types, consolidating the edit scans, the gate-reset helper in `task-revalidation.ts`, and the sealed-subset wire shape.
  - Dismissed: merging the flag parser with the edit-constructor id parser.
- Slice B: 5 accepted.

The main fixes:
- **Replay bug** (code-reviewer-1). `replayedEdit` compared the Task's current `depends_on`, so a retry was missed after a later edit added an incoming edge. It now compares only the recorded edit.
- **One wait relation** (architecture-tech-lead-1). `dispatch-holds.ts` exports `waitsFor` and `waitRelation`. `add-task` and `add-dependency` now refuse a cycle that closes through a legacy Forward Fix hold.
- **Withdrawing a legacy fix Task** (silent-failure-hunter-2). `withdraw-task` also withdraws an untouched legacy fix Task, moving its audit into `forward_fix_withdrawals`.
- **Released Tasks are reported** (silent-failure-hunter-1). The withdrawal outcome lists the Tasks it released, and the report names them.
- **No invariant throws** (silent-failure-hunter-3, type-design-analyzer-1, architecture-tech-lead-3). A request the edit constructors reject now gets a typed `invalid-request` refusal.
- **Smaller signature.** `pathAdmissionRefusal` now works out the completed Waves from the graph itself.
- **Docs.** The `WavePlanEdit` doc names all four edit kinds, and ADR-0081 now says in the past tense that ADR-0084 retired the holds.
- **Tests:**
  - retro facts for added Tasks;
  - the parser table for legacy withdrawals;
  - withdrawing a legacy fix Task, and cycles through a legacy hold;
  - a typed legacy audit fixture with no casts, and shared helpers in `fixtures/sealed-wave.ts`;
  - `dependencyAdded` and `rawJson` helpers.

## Support paths (outside slice A's reviewed scope)
- `.claude/plans/2026-11-18-pr217-remediation.md`
- `engine/src/core/task-dependency-edit.ts` (uses the shared wait relation)
- `engine/tests/core/retro-facts.test.ts`, `engine/tests/core/task-addition.test.ts`, `engine/tests/fixtures/sealed-wave.ts` and `engine/tests/handlers/helpers/task-addition-operations.test.ts`. These are slice B's files and carry its accepted fixes.

## Validation (mine, not remediation evidence)
- `tsc` reports no errors in `engine/src` or the touched tests.
- `bun run lint` is clean.
- 14 targeted files pass, 1058 tests: task-addition, the shells, add-dependency, rescope, retro, the implementation window, brief, distill, status, architecture and subagent authority.
