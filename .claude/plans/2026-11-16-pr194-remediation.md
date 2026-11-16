# PR #194 remediation: an attestation drift is terminal because of its receipt

- **Branch:** `fix/drift-terminal-by-history`
- **Review run:** `run.pr194-review-1`. Six reviewers ran: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, architecture-tech-lead (deepen) and code-simplifier (distill). They found 0 criticals and 1 advisory.
- **Dispositions:** published as `run.pr194-disposition-1`.

## Advisory (accepted)
pr-test-analyzer reported that nothing tested an unremediated drift without the attestation flag, or a non-drift failure on a non-attested Task. I added both tests:
- an unremediated drift is `escalated`, carrying its receipt and failure kinds;
- an ordinary failure is a `retry` whose predecessor is that failure's receipt.

## Support paths
- `.claude/plans/2026-11-16-pr194-remediation.md`

## Validation
`npx tsc --noEmit -p .`, then `vitest run tests/core/implementation-retry-attestation-drift.test.ts tests/core/implementation-retry.test.ts` (27 tests pass), then `npm run lint`.
