# PR #74 remediation — status recovery for abandoned Wave Gate runs

- **Branch:** `fix/abandoned-run-recovery-status` (PR #74)
- **Scope:** `all`, the 9-file frozen diff at `03ce4528`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr74-review-20261012T075441Z`
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr74-policy-20261012T075708Z`, revision `initial`, with disposition digest `0a5931ac06a3445bf0a0fc248511f6671816dcb22ea1afadee58f213910dd953`

## Adjudication

- Emitted and admitted: 0 critical, 5 advisory.
- After refutation: 0 surviving critical, 0 refuted critical, 5 advisory.
- `defectFamily` is `{"kind":"not-required"}`: there are no repair groups, siblings, checks or Historical RED declarations.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| code-reviewer-1 | accepted | `quoteShellArgument` in `core/shell-quoting.ts`, the inverse of its scan, quotes every value of the printed replay. A property test proves each quoted value is one balanced word that reads back exactly |
| silent-failure-hunter-1 | accepted | Same root cause and fix as code-reviewer-1 |
| architecture-tech-lead-1 | accepted | `abandonReplayFlags` in `loom-status.ts` is the single owner of the replay's shape, as flag/value pairs, rendered only through `quoteShellArgument`. Building pairs, not a flat argv, also stops a `--`-shaped reason from being mistaken for a flag; a test pins that case |
| pr-test-analyzer-1 | accepted | Real-seam test: an unreadable `abandoned.json` makes status unavailable, never resumable. Status test: a successor-naming tombstone on a Wave that is not start-ready asks for `repair-wave-start-readiness`, not the successor start. Both pin existing behaviour |
| comment-analyzer-1 | accepted | The new test comments now state the invariant each test pins; the issue number and the old behaviour live in the commit and PR |

No advisory was deferred or dismissed.

## Validation

- `npm run typecheck`; the shell-quoting, status, implementation-window and abandon-stamp suites
- full `npm run verify`

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan and `engine/tests/core/shell-quoting.test.ts`, the new test, plus `engine/src/core/shell-quoting.ts`, which sits outside the reviewed scope.
