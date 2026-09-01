# PR #40 remediation — round 5

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Reviewed head: `a3f1b2d99c14d1ad5a9f69b759b26a250b6fd6d2`
Review Run Directory: `review-20260901T171454Z-2864499`
Result digest: `c2bcec1e31127da2e4fc06d2b08aa916ca077750f01b43d544a17131662aa294`

## Mandatory critical fixes

- Report completed Tasks retaining execution/attempt authority as a defensive status contradiction while preserving the parser-compatible result-cleanup path that retires such reservations.
- Rename the final “no agent can serve” reclamation heading to bounded policy eligibility.
- Replace the impossible status example with real renderer output including top-level blocked action and nested implementation recovery.

## Advisory dispositions

Accepted:

- Timestamp-less legacy reservations now produce unavailable status instead of a status-to-Pi dispatch loop.
- Add exact rollback/context retirement, Retry Context malformed-field, retry_count clearing, and mixed initial/retry batch regressions.
- Remove duplicate Retry Context from `WaveImplementationDispatch`; exact prompt appendix is the sole wire instruction.
- Correct hook settlement documentation and plan component ownership.
- Apply local distill moves for discriminant narrowing, positional registration, workspace observation reuse, and atomic cleanup result return.

Deferred:

- Persisted Attempt Context and active-attempt ADTs, per-Task authority-batch inputs, implementation-window module extraction, Pi spawn transaction, versioned receipt context identity, and broader reducer/comment cleanup remain dedicated deepen/distill work.

## Refutation audit

The Finding claiming receipts retain prompt/context identity was refuted by reproduction and intent: the plan claimed retained issued request identity (reservation and authority digests), not retained prompt/context bytes. All other critical Findings survived.

## Support path

- `.claude/plans/2026-09-01-pr40-remediation-round5.md`

## Validation

Focused status/parser/registration/rollback suites; typecheck and unused-code; full-tier lint; authoritative unit and smoke suites; diff check; registered remediation; verified index; normal push.

## Validation receipt

- Focused completed/timestamp-less reservation, cleanup compatibility, mixed batch, parser, rollback, and retry success regressions: passed.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 2 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,049 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
