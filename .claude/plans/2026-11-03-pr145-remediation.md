# PR 145 remediation: owner verification follows the family schedule

- **Branch:** `fix/owner-verification-incremental` (PR #145)
- **Scope:** the PR diff (23 files), plus this plan as a support path
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261103T114228Z-a81cd750`. Seven reviewers captured; comment-analyzer was refused once for incomplete read coverage and admitted on its retry.
- **Result:** 0 critical (none surviving, none refuted), 10 advisory
- **Advisory policy:** published in run `disposition-20261103-pr145` (initial revision, digest `ac95960c8b88b23fcd268078e28f69a773bbdd0bf9e56958369bc1d101a40a24`)

## Surviving criticals
None. No Declared Repair Group is needed. Defect family: `not-required`.

## Refuted criticals
None.

## Advisory dispositions (DECLARED)

| Finding | Decision | Reason / fix |
|---|---|---|
| pr-test-analyzer-1 | accepted | Add a State File wire row: the receipt authority loaded for a contract-stub Wave owes nothing, and a contract-unaware authority is refused |
| type-design-analyzer-1 | accepted | `duePaths` always leads with the owner and returns `NonEmpty<string>`; coverage inputs take `NonEmpty<string>`, so `[]` is unrepresentable |
| comment-analyzer-1 | accepted | `docs/operations.md` step 4: the Wave base comes from the Wave's implementation Tasks (not a contract Task) |
| comment-analyzer-2 | accepted | `references/plan-template.md`: the matrix test lands by the first Wave that *owes* the family |
| architecture-tech-lead-1 | deferred | `TaskGraph.acceptance_contracts` is optional itself (absent means no contracts), so a required key rejects every TaskGraph caller; production callers pass the parsed graph, and the accepted wire test pins the one adapter |
| architecture-tech-lead-2 | accepted | The brief decides through `owesInWave`, and contract-ness through `contractTaskIdsOf`, the same rule the gate uses |
| code-simplifier-1 | accepted | Folded into the brief rewrite: partition the siblings once |
| code-simplifier-2 | dismissed | `ownerStampedGraph` keeps `parseTaskGraph` within the 50-line `max-function-lines` rule; inlining it was the 78th violation |
| code-simplifier-3 | accepted | One exported path predicate in `plan-paths.ts` (`listsPath`), used by `invariantRoles` and the schedule |
| code-simplifier-4 | accepted | Same defect as architecture-tech-lead-2; regression test: a sibling change before the owner is due is told its Wave owes nothing |

## Validation
- `bun scripts/typecheck.ts` (engine)
- The owner-verification, brief, validator, runner and wire suites
- `npm run verify` at the repository root
- `bun scripts/lint-project.ts --summary`, held at the 77-violation baseline
