# PR #187 remediation (2026-11-16)

- Branch: `fix/185-successor-reviewer-contract` (PR #187, issue #185, ADR-0077)
- Scope: the 28 files of the PR diff against `main` (frozen by the review run)
- Review Run Directory: `.claude/reviews/review-and-fix-runs/run.pr187-review-20261116`
  (result digest `be1f913fac231e41a0ad5673434ea5cfbde14ddbb3d5926626cf16c7e3c23058`)
- Policy publication: `.claude/reviews/review-and-fix-runs/run.pr187-policy-20261116`
  (disposition digest `4d0a6bb144c2435002f9f0a5cca2b0726e3aac6326f3808ef90edb2efc85010d`)

## Criticals

None emitted, none surviving, none refuted. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Fix |
| --- | --- | --- |
| code-reviewer-1, architecture-tech-lead-1 | accepted | Bound `describeInadmissibleAssessment`: cap listed references, bound echoed values, property test of the 2048-byte bound over arbitrary rows. |
| silent-failure-hunter-1 | accepted | Re-proof returns a tagged outcome (`reproved` / `differs` / `unbuildable` with message); both callers report the build failure. |
| pr-test-analyzer-1 | accepted | Handler test: `recoverOrPublishStandaloneRetry` re-proves roster and pre-roster retry packets and refuses a forged one. |
| pr-test-analyzer-2 | accepted | `standaloneInputChange` takes only the two snapshots; every branch tested with hand-built snapshots. |
| type-design-analyzer-1 | accepted | `admitsStandaloneAssessment(roster, index, assessment)`; admitted verdicts derived from standing and decisions through `verdictsFor`. |
| type-design-analyzer-2 | dismissed | The frozen request `contextDigest` commits one layout; issuance only builds the roster layout. |
| comment-analyzer-1, comment-analyzer-2 | accepted | Rewrite the successor wire section (missing word; `draft` is a v2 finding, never the v2 envelope); name `decisionDigest` / `proposal.decisionDigest`; re-stamp. |
| comment-analyzer-3 | accepted | Rename the verdict-list test to what it asserts. |
| architecture-tech-lead-2, code-simplifier-1 | accepted | One exported successor rule wording, carried verbatim by the wire contract, spawn task and retry. |
| architecture-tech-lead-3 | dismissed | The frozen digest already records the layout; a separate two-entry module fails the deletion test. |
| code-simplifier-2 | accepted | Merge the two identical test-helper arms. |

## Validation

From `engine/`: `npx tsc --noEmit`, `npm run -s lint`, `bun ../scripts/stamp-wire-contract.ts --check`,
`env -u PI_CODING_AGENT npx vitest run`, `env -u PI_CODING_AGENT npm run -s test:smoke`.
