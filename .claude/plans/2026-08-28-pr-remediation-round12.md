# PR Remediation Round 12 — phase, assertion, and spec-check retry authority

## Immutable review authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Source run: `review-20260828T112538Z-deterministic-task-completion-oracle-post-remediation-16`
- Reviewed revision: `fd97d6d6b472e5afc0d5b565cf68cd31fe9cd8ed`
- Result digest: `d4513b20a198f62d1df0835424eaacf96ab289aa60ec48f737f6b9474fafaf59`
- Frozen scope: the 145 paths recorded in the source result.
- Surviving criticals: 3; refuted criticals: 0.

## Mandatory remediation

1. Replace nullable phase-transition resolution with a discriminated union carrying explicit not-ready reasons for missing, unresolved, or out-of-scope brainstorm/spec/plan/alignment artifacts. A recognized completed phase Agent must return a contextual hook error rather than silent passthrough when not ready.
2. Make assertion evidence inspect executable added code rather than raw diff text: strip string literals and line/block comments before matching assertion syntax. Pin test-title and comment laundering with examples plus a generated property.
3. Persist exact spec-check slot attempt authority inside the current `wave_review_epoch`, initialized at attempt 1 and advanced atomically to attempt 2 after durable retry publication. Require exact run/Wave/epoch/slot/attempt agreement when applying spec-check evidence, and derive recovery/exhaustion from that protected authority instead of hard-coding attempt 1.
4. Add parser/load-boundary tests for the new nested spec-check authority and integration coverage proving an issued attempt 2 remains exhausted across recovery rather than being reissued indefinitely.

## Advisory disposition

- **Accepted — reopening JSON diagnostics:** retain the exact `JSON.parse` cause in the malformed-payload error.
- **Accepted — transcript-path comment:** narrow the comment to exact modern settlement and document legacy inference/quarantine.
- **Accepted — reviewer-slot boolean state:** remove the helper whose boolean pair represented the impossible accepted+invalid state; derive one result only after the conflict guard.
- **Deferred — config policy/runtime split:** independent architecture refactor beyond this remediation.
- **Deferred — TaskGraph parser/persistence split:** broad module-boundary migration with unrelated risk.
- **Deferred — Wave Gate module decomposition:** focused deepening slice, not an authority defect patch.
- **Deferred — duplicated StateManager pointer capture:** worthwhile cleanup but unrelated to the upheld findings.
- **Deferred — duplicated Pi review application shell:** worthwhile cleanup but unrelated to the upheld findings.
- **Deferred — mark-tests-passed nested ternaries:** isolated readability cleanup without correctness impact.

## Validation and release

1. Focused phase-handler, Git evidence, State File parser, Wave recovery, and façade integration tests.
2. Typecheck and unused-symbol check.
3. Full bounded Vitest suite (`--maxWorkers=4 --minWorkers=1`).
4. Smoke suite, changed-production lint, and `git diff --check`.
5. Register the plan plus the omitted Wave façade and parser/Git regression paths as explicit support paths, then install the exact verified index.
6. Commit and push without force.
7. Reload Pi at the runtime boundary, then run a fresh canonical standalone review and three-lens refutation; do not open a PR while any critical survives.
