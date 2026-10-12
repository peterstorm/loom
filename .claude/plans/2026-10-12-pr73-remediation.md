# PR #73 remediation — decompose → execute only on population

- **Branch:** `fix/decompose-empty-graph-advance` (PR #73)
- **Scope:** `all`, 9-file frozen diff at `cd34d28d`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr73-review-20261012T063819Z`, with result digest `57013f082c2a79c7e3e6b85a6ae67e0971dcf433ef42015547ba9a663e30ca58`
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr73-policy-20261012T064117Z`, revision `initial`, with disposition digest `39f1c1cf9be9663de8a7e06909422fc9b6df6611323ba5b287fbaf9e6483e8d0`

## Adjudication

- Emitted and admitted: 0 critical, 6 advisory.
- After refutation: 0 surviving critical, 0 refuted critical, 6 advisory.
- `defectFamily` is `{"kind":"not-required"}`: there are no repair groups, siblings, checks or Historical RED declarations.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| pr-test-analyzer-1 | accepted | Real-handler test: a population that fails from decompose leaves the phase at decompose with unchanged bytes. Execute re-population through the handler is already covered by the execute-default fixtures |
| type-design-analyzer-1 | accepted | Same root cause as architecture-tech-lead-1 |
| comment-analyzer-1 | accepted | The comment names populate-task-graph as the sole writer of decompose → execute, and its no-tasks refusal as the reason execute is never empty |
| architecture-tech-lead-1 | accepted | Pure `decidePhaseResult` (advance / refuse / note) in `advance-phase.ts`. The Claude handler and Pi settlement both match the non-advance arms exhaustively, so a new resolution kind is a compile error in both |
| code-simplifier-1 | accepted | One `NoTransition` shape shared by the non-advancing variants |
| code-simplifier-2 | dismissed | The handler test asserts persistence through StateManager to disk, which the pure core test cannot observe |

No advisory was deferred.

## Validation

- `npm run typecheck` (engine and Pi); the advance-phase, Pi settlement and population suites
- full `npm run verify`

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan; every other touched path is inside the reviewed scope.
