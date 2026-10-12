# PR #73 remediation, round 2: decompose → execute only on population

- **Branch:** `fix/decompose-empty-graph-advance` (PR #73)
- **Scope:** `all`, 10 frozen files at `5c3f469e`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr73-review-r2-20261012T065910Z`
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr73-policy-r2-20261012T070136Z`, revision `initial`, with disposition digest `213f88a1b20c7f0ff2fef07a5fff2f19194ff3a2db29434bafd9bf71c3f3c6e1`

## Adjudication

- Emitted and admitted: 0 critical, 2 advisory.
- After refutation: 0 surviving critical, 0 refuted critical, 2 advisory.
- `defectFamily` is `{"kind":"not-required"}`: there are no repair groups, siblings, checks or Historical RED declarations.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix or reason |
|---|---|---|
| architecture-tech-lead-1 | accepted | `notReadyDiagnostic(subject, reason)` sits in the core beside `decidePhaseResult`. The Claude handler (subject: completed phase) and Pi settlement (subject: agent type) both build their refusal from it, and each shell's output is byte-identical to before |
| code-simplifier-1 | dismissed | A single match with an advance arm would mean pulling the Claude handler's locked-commit path into its own function for altitude alone. It removes no representable state, and the inner exhaustive match already turns a new decision kind into a compile error |

## Validation

- `npm run typecheck`; the advance-phase and Pi suites, whose existing assertions pin both shells' refusal text
- full `npm run verify`

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan.
