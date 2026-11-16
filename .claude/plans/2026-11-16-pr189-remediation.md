# PR #189 remediation: Forward Fix withdrawal review-and-fix

- **Branch:** `fix/forward-fix-withdraw`
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr189-review-2` (result digest `a00634c1c6e7f199b31f186a1d5cec12be8388583944ff95374a88d46c52026a`)
- **Scope (15 files):** ADR-0077, `docs/architecture.md`, `docs/contexts/implementation-proof/CONTEXT.md`, `docs/reference/recovery.md`, `engine/src/core/forward-fix.ts`, `engine/src/core/task-graph-population.ts`, `engine/src/handlers/helpers/add-forward-fix.ts`, `orchestration-operations.ts`, `orchestration.ts`, `subagent-quiescence.ts`, `engine/src/state-file-wire.ts`, `engine/src/types.ts`, `engine/tests/core/forward-fix.test.ts`, `engine/tests/handlers/helpers/add-forward-fix.test.ts`, `references/loom/recovery-runbook.md`
- **Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead (deepen), code-simplifier (distill)
- **Disposition publication:** `run.pr189-disposition-1` (`standalone-disposition-published`)

## Criticals

None surfaced. No Declared Repair Group, no selected check and no Historical RED declaration: `defectFamily: {"kind":"not-required"}`.

## Advisory dispositions (13, all accepted)

| # | Reviewer | Finding | Disposition and fix |
|---|---|---|---|
| 1 | pr-test-analyzer | Only one of `neverDispatched`'s conjuncts was tested | Accepted. A test per evidence field, iterating `JOINED_TASK_FIELDS` |
| 2 | pr-test-analyzer | Wave refusals, replay with a new reason, gate bits and retirement untested | Accepted. Refusal rows for every Wave kind, a different-reason replay refused as `not-a-forward-fix`, gate bits re-derived, retirement equal to `retireUnownedWaveReviewAuthority` |
| 3 | pr-test-analyzer | Withdraw shell protocol untested | Accepted. Pre-lock and under-lock quiescence, missing graph, bad arguments, replay without writing, non-refusal failure |
| 4 | pr-test-analyzer | Loader withdrawal rules and the population drop untested | Accepted. Malformed audit, blank reason, unknown field and non-array rows. The population test pins both Forward Fix records dropped. The live-audit branch was unreachable, so it was deleted |
| 5 | type-design-analyzer | One refusal union shared by both operations | Accepted. `ForwardFixWaveRefusalKind` composed into `ForwardFixRefusalKind` and `ForwardFixWithdrawalRefusalKind` with `Refusal<K>`. Withdrawal now also refuses `successor-named` |
| 6 | type-design-analyzer | Reason invariant repeated in the wire parser | Accepted. `parseBoundedReason`, used by three audits |
| 7 | type-design-analyzer | `neverDispatched` is a hand-listed predicate | Accepted. `isUntouchedJoinedTask` over `JOINED_TASK_FIELDS`, typed `satisfies` over every `keyof Task` |
| 8 | comment-analyzer | Runbook names braces only | Accepted. Names all four text rules |
| 9 | architecture-tech-lead | Shell protocol duplicated, file name stale | Accepted. Generic `forwardFixOperation` runner, module renamed `forward-fix-operations.ts` |
| 10 | architecture-tech-lead | Untouched-Task invariant has no home | Accepted. One predicate beside `pendingAuthoredTask` |
| 11 | code-simplifier | Reason check duplicated | Accepted (same fix as 6) |
| 12 | code-simplifier | Gate reset duplicated | Accepted. `resetWaveGates`, with `impl_complete` derived from the roster |
| 13 | code-simplifier | Shell duplicated | Accepted (same fix as 9) |

## Refuted-finding audit

None: no critical was issued, so no Refutation Panel ran.

## Support paths outside the reviewed scope

- `.claude/plans/2026-11-16-pr189-remediation.md` (this plan)
- `engine/src/handlers/helpers/forward-fix-operations.ts` (renamed shell)
- `engine/tests/handlers/helpers/forward-fix-operations.test.ts` (renamed shell tests)
- `engine/tests/core/task-graph-population.test.ts` (population drop pin)

## Validation (declared; the registered remediation observes its own)

```bash
cd engine
npx tsc --noEmit -p .
env -u PI_CODING_AGENT npx vitest run tests/core/forward-fix.test.ts tests/handlers/helpers/forward-fix-operations.test.ts tests/core/task-graph-population.test.ts
npm run lint   # clean apart from the untracked docs/markdown-audit-2026-11-12.md
```
