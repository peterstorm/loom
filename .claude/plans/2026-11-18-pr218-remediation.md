# PR #218 remediation (loom#199 Cause 6: an attesting attempt cannot write)

- Branch: `feat/attestation-blocks-edits` (worktree `loom-attest-guard`)
- Review run: `.claude/reviews/review-and-fix-runs/pr218-review-1`. Result digest `2793ae0a…03cc8`. The engine retried silent-failure-hunter once for incomplete read coverage.
- Policy publication: `pr218-policy-1`

## Engine-observed counts
15 findings: 0 critical, 15 advisory. Defect family: `not-required`.

## Advisory dispositions (DECLARED)
14 accepted, 1 deferred. The deferred one is a discriminated Pi grant kind, which would change the minted grant format.

The fixes:
- **ADR index order.** ADR-0085 now follows ADR-0084. CI's `adr-index` test failed on this too.
- **Pi grant shape.** One optional `implementationTask {taskId, taskGraphPath}` field on the active grant. It is set for every implementation grant and absent exactly for a phase grant, so a half-recorded grant can't be represented and no implementation grant skips the check.
- **Unobservable carries its cause.** `TaskWriteMode` is a discriminated union whose `unobservable` arm carries the cause. `taskWriteMode` takes an `ObservedTasks` result, and the refusal message includes the cause.
- **Neutral shell module.** `engine/src/handlers/attestation-mode.ts` holds `readAttestationTasks` and `callerWriteModeOf`. Each harness only names the Task and its graph source: `claudeCallerWriteMode` for Claude Code, `grantCallerWriteMode` in `pi/child-write-grant.ts` for Pi.
- **Tests.** Both adapters are tested, and the grant activation test asserts the Task and TaskGraph are kept. There is also a `CallerBinding` type name, and the test titles are reworded.

## Support paths (outside the reviewed scope)
- `.claude/plans/2026-11-18-pr218-remediation.md`
- `engine/src/handlers/attestation-mode.ts`
- `engine/tests/pi/child-write-grant.test.ts`

## Validation (mine, not remediation evidence)
- `tsc` reports no errors in `engine/src` or the touched tests. The only Pi errors are the uninstalled Pi package, as on main.
- `bun run lint` is clean.
- 5 files pass, 186 tests: `attestation-writes`, `child-write-grant`, the `block-direct-edits` handler suite, the binding property tests, and `adr-index`.
