# PR #220 remediation (loom#199 Cause 4: the spec is amended by an audited operation)

- Branch: `feat/amend-spec` (worktree `loom-amend-spec`)
- Review run: `.claude/reviews/review-and-fix-runs/pr220-review-1`. Result digest `814f7229…2b02`.
- Policy publication: `pr220-policy-1`

## Engine-observed counts
13 findings: 0 critical, 13 advisory. Defect family: `not-required`.

## Advisory dispositions (DECLARED)
12 accepted, 1 dismissed. The dismissed one asked the audit to require a re-judged Task to stay completed. A Task can legitimately be reopened later, so the one reader filters by status and claims at use instead.

The fixes:
- **One re-judgement rule.** `rejudgeClaimsOf` in `core/spec-rejudgement.ts` feeds both the coverage projection and the completion re-anchoring. It covers a completed Task, still claiming the id, that an amendment listed. The unused `pendingRejudgements` is deleted.
- **One audit chain.** The shell observes the current spec under the lock. The core refuses when the current spec isn't the text the last amendment wrote.
- **Byte-write failure.** The message says the amendment is recorded and to rerun the same command, and the temporary file is removed.
- **Stricter types and parser.** The before and after observations are the indexed variant in both. The parser refuses an id in two lists and a repeated re-judgement pair, and `parseRejudgements` is extracted.
- **Docs.** Reworded the type doc, the module header, ADR-0087 and `recovery.md`.
- **Tests:**
  - an id moved to Out of Scope;
  - the contribution refusal;
  - de-duplication across two amendments;
  - an exact rewritten property;
  - re-anchoring that leaves an unchanged claim alone;
  - the chain refusal;
  - the parser refusals;
  - the byte-write failure and its rerun.

## Support paths (outside the reviewed scope)
- `.claude/plans/2026-11-18-pr220-remediation.md`
- `engine/src/core/spec-rejudgement.ts`

## Validation (mine, not remediation evidence)
- `tsc` reports no errors in `engine/src`.
- `bun run lint` is clean.
- 13 targeted files pass, 335 tests.
