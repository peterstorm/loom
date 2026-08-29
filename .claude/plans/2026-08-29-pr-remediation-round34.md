# PR Remediation Round 34

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260829T004112Z-deterministic-task-completion-oracle-post-remediation-38`
- Source result digest: `703f45d257542f547cea620c22bc44a1c594ab8268f86011b1c69f2bb8292407`
- Frozen scope: the source result's exact 85-path `scope` array.

## Mandatory fixes
1. Count TypeScript executable test-runner calls without treating `function test(...)` helper declarations as tests; add focused and property regressions.
2. Count Python executable `test_*` functions/methods without treating an empty `class Test*` declaration as a test; add regressions.
3. Pin successful pure Wave review preparation through the live façade and `installWaveReviewRuns`, asserting exact roster/model/context/spec slot and protected reviewer slot correlation.

## Advisory dispositions
### Accepted
- Add direct attempt-2 slot/retry coverage if the new Wave authority integration fixture can reuse the same authority without synthetic state.
- Remove the three fixture-restating comments in `store-spec-check-findings.test.ts`.
- Correct the `pi/subagent-result.ts` module header to describe the actual per-applier ports.

### Deferred
- Review-state ADT redesign, pure phase transition extraction, Trusted Review Witness aggregate extraction, shared hook parser, shared pointer-capture helper, and orchestration env fixture helper are valid but broader architectural changes unrelated to these mandatory evidence fixes.

## Refuted-finding audit
No critical was canonically refuted. The Wave coverage finding received one security-lens refutation but survived the 2-of-3 threshold and remains mandatory.

## Validation
Focused scanner/property/Wave integration tests; typecheck and unused checks; full bounded Vitest; smoke with inherited Pi runtime variables unset; changed-production lint; `git diff --check`; registered remediation/index installation; commit/push; fresh canonical review and refutation panel.
