# PR #243 remediation — review-and-fix

- **Branch:** `fix/jvm-test-evidence` (peterstorm/loom#243)
- **Scope:** `all` over the branch diff against `origin/main` (8 files, frozen by the review run)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/pr243.review` (result digest `a36fcea08118220ffcb8db46231da4c15bef119bb3e329dcfed1432840e0b12e`)
- **Policy publication:** `.claude/reviews/review-and-fix-runs/pr243.policy` (`artifacts/disposition.json`, initial revision)

## Engine counts (inspection)

9 findings: 0 surviving critical, 0 refuted critical, 9 advisory, 0 resolved.

## Surviving criticals

None. Defect-family accounting: `{"kind":"not-required"}`. No Declared Repair Group, no selected check, no Historical RED.

## Refuted criticals

None.

## Advisory dispositions (DECLARED, all accepted)

| Finding | Decision | Reason / fix |
|---|---|---|
| silent-failure-hunter-1 | accepted | The reader now returns `PersistedOutputRead` (`read`, `over-cap`, `size-mismatch`, `unreadable`); the stderr note names the cause, including a head mismatch. |
| pr-test-analyzer-1 | accepted | Matrix rows for a `.groovy` and a `.scala` simple class, and `$Nested` with no outer class → null. |
| pr-test-analyzer-2 | accepted | End-to-end test of a same-size file with a different head; unit test that an over-cap spill is refused without touching the file. |
| type-design-analyzer-1 | accepted | `withPersistedBashOutput(payload, whole)` re-derives the spill from the payload it restores, so a spill cannot be paired with another call. |
| type-design-analyzer-2 | accepted | `ReportedJvmClass` is a discriminated union: `qualified` with `packagePath`, `simple` with `name`. |
| comment-analyzer-1 | accepted | The end-to-end test header states the guarded invariant instead of the past behaviour. |
| comment-analyzer-2 | accepted | The I6 regression comment cites loom#242 and the ledger shape, not an external Task. |
| code-simplifier-1 | accepted | `Buffer.byteLength(whole, "utf8")` replaces the `TextEncoder` copy (core already uses `Buffer.byteLength`). |
| code-simplifier-2 | accepted | One shared fixture, `engine/tests/fixtures/claude-spilled-payload.ts`, for the spilled payload shape, the head size and the byte count. |

## Support paths (outside the frozen scope)

- `.claude/plans/2026-11-19-pr-remediation.md` (this plan)
- `engine/tests/fixtures/claude-spilled-payload.ts` (code-simplifier-2)

`docs/feature-guard-map.md` (in scope) moves `engine/tests/` from 942 to 943 TS files for the new fixture, keeping `tests/docs/facts.test.ts` green.

## Validation

Per the operator, tests run in CI, not locally: the PR's `Verification` workflow (static, unit 1–4, smoke on ubuntu-24.04 and macos-15). With zero surviving criticals the registered remediation selects no check; it audits and installs the index only.
