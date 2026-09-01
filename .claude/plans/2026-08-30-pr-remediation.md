# Oracle deterministic worktree remediation

## Authority and scope

- Branch: `fix/deterministic-task-completion-post-merge`
- Review scope: the exact union of the `scope` arrays in the six immutable results below (105 changed paths; the partition preserves full-worktree coverage while keeping each Context Packet within the cloud models' context limit).
- Review runs:
  1. `.claude/reviews/review-and-fix-runs/review-20260829T220231Z-oracle-part1-cloud`
  2. `.claude/reviews/review-and-fix-runs/review-20260829T223936Z-oracle-part2-cloud`
  3. `.claude/reviews/review-and-fix-runs/review-20260829T231021Z-oracle-part3-cloud`
  4. `.claude/reviews/review-and-fix-runs/review-20260829T234804Z-oracle-part4-cloud`
  5. `.claude/reviews/review-and-fix-runs/review-20260830T001932Z-oracle-part5-cloud`
  6. `.claude/reviews/review-and-fix-runs/review-20260830T004522Z-oracle-part6-cloud`
- Superseded infrastructure-failed runs: `review-20260829T212851Z-oracle-review-and-fix`, `review-20260829T215235Z-oracle-part1` (cloud children failed before producing review evidence; neither is remediation authority).

## Mandatory surviving critical Findings

All are accepted and mandatory. Duplicate Findings remain listed because each is authoritative evidence; one complete fix may resolve multiple Findings.

### Part 1

- `code-reviewer-1` — `engine/src/handlers/helpers/store-spec-check.ts:55`: move the manual override authority decision into the same locked StateManager update that writes `spec_check`; add a race regression.

### Part 2

- `code-reviewer-1` — `engine/src/handlers/subagent-stop/advance-phase.ts:321`: recompute phase transition against locked current state before commit; test same-phase authority changing between observation and update.
- `silent-failure-hunter-1` — `engine/src/handlers/subagent-start/mark-subagent-active.ts:240`: fail closed when roster publication fails for machine-less Agents; test that spawn admission does not continue.

### Part 3

- `code-reviewer-1` — `engine/src/orchestration/no-follow-fs.ts:546`: make recovery-guard reclamation prove it still owns the exact abandoned guard before unlink, preventing replacement-live-guard deletion; add race coverage.
- `pr-test-analyzer-1` — `engine/src/orchestration/no-follow-fs.ts:701`: add integration coverage for abandoned `<lock>.recovery` reclamation before the protected critical section.
- `pr-test-analyzer-2` — `engine/src/state-manager.ts:251`: add load-boundary regression for malformed persisted `wave_gates` before review-gate booleans are consumed.
- `type-design-analyzer-1` — `engine/src/handlers/helpers/reopen-completed-wave.ts:192`: bind reopening proof Task IDs to exactly the completed Wave's Tasks before mutating terminal history; test forged/empty/wrong-wave proofs.
- `comment-analyzer-1` — `engine/src/orchestration/no-follow-fs.ts:261`: make the Linux base-resolution contract and comment agree; do not claim symlink refusal where canonicalization is intended.
- `comment-analyzer-2` — `engine/src/orchestration/no-follow-fs.ts:435`: correct the Darwin atomic-commit comment to describe pathname rename after `O_NOFOLLOW_ANY` proof, not descriptor-relative rename.
- `comment-analyzer-3` — `engine/src/orchestration/no-follow-fs.ts:793`: correct `openDirectoryNoFollow` JSDoc to distinguish Linux descriptor walks from Darwin whole-path `O_NOFOLLOW_ANY`.
- `comment-analyzer-4` — `engine/src/orchestration/no-follow-fs.ts:842`: remove the swapped-ancestor mkdir window on Darwin by proving the parent again before creation and checking the created child no-follow; pin the refusal with a race regression where feasible.

### Part 4

- `silent-failure-hunter-1` — `engine/src/core/wave-gate-machine.ts:2556`: preserve LC-1/advisory projection failures as an explicit unavailable/blocked status rather than returning `null` and fabricating engine-resume guidance; test the proof-failure path.

### Part 5

All seven reviewers independently found the same mutated Dispatch defect at `engine/src/handlers/subagent-stop/dispatch.ts:181`:

- `code-reviewer-1`, `silent-failure-hunter-1`, `pr-test-analyzer-1`, `type-design-analyzer-1`, `comment-analyzer-1`, `architecture-tech-lead-1`, `code-simplifier-1` — restore the request-authority condition so Wave Gate stops continue into exact legacy settlement while non-Wave standalone requests return after capture; add a successful request-bound Wave Gate `runDispatch` regression.

## Advisory dispositions

### Part 1

| Finding | Disposition | Reason / fix |
|---|---|---|
| `type-design-analyzer-1` | accepted | Preserve branded Wave review run/digest/epoch values through the façade instead of widening to strings; contained type-safety fix. |
| `type-design-analyzer-2` | deferred | A roster-bound `ReviewRun` ADT changes persisted graph shape and many consumers; sound but not a safe targeted remediation. |
| `comment-analyzer-1` | accepted | Strengthen the absent-transcript regression to assert the concrete unreadable-transcript cause promised by its comment. |
| `architecture-tech-lead-1` | deferred | A shared/pure resume planner is broad façade redesign and conflicts with ADR-0005's decision that per-program sequencing is essential policy. |
| `architecture-tech-lead-2` | accepted | Localize Wave review authority parsing behind the existing core codec seam and reuse it in the façade. |
| `architecture-tech-lead-3` | deferred | Removing import-time `TASK_GRAPH_PATH` I/O affects the shared config API and broad call graph; valid deepening, high blast radius. |
| `code-simplifier-1` | accepted | Delete redundant revalidation already guaranteed by the parsed authority union. |
| `code-simplifier-2` | accepted | Reuse one unknown-error formatter across cleanup catches without changing behavior. |
| `code-simplifier-3` | accepted | Extract the repeated review-packet TaskGraph test fixture. |

### Part 2

| Finding | Disposition | Reason / fix |
|---|---|---|
| `code-reviewer-2` | accepted | Treat an explicitly empty transcript path as absent so the filesystem fallback remains available; add regression. |
| `silent-failure-hunter-2` | dismissed | Best-effort test cleanup intentionally suppresses removal errors; making cleanup throw can replace the assertion failure and does not improve product behavior. |
| `comment-analyzer-1` | accepted | Correct the inaccurate “never logged” comment to match asserted inferred-attribution diagnostics. |
| `architecture-tech-lead-1` | deferred | Making `resolveTransition` wholly pure requires a new filesystem observation input interface across phase advancement; sound deepening, not targeted remediation. |
| `architecture-tech-lead-2` | deferred | Splitting admission/capability/rollback planning changes the mark-active module interface and multiple Hook seams. |
| `code-simplifier-1` | dismissed | The alias identity assertions intentionally pin compatibility exports; deleting them weakens an externally observable compatibility contract. |

### Part 3

| Finding | Disposition | Reason / fix |
|---|---|---|
| `code-reviewer-2` | accepted | Make the unreadable-metadata test deterministic under root (skip/alternate assertion where mode bits cannot enforce unreadability). |
| `silent-failure-hunter-1` | accepted | Preserve primary StateManager failures when anchored-directory close also fails, using aggregated diagnostics. |
| `silent-failure-hunter-2` | accepted | Render `AggregateError` children/cause detail at the helper boundary. |
| `silent-failure-hunter-3` | accepted | Preserve actionable errno in the Darwin capability-probe failure. |
| `pr-test-analyzer-3` | accepted | Add load-boundary test for `blocked:true` Wave Gate without cause. |
| `type-design-analyzer-2` | accepted | Return a defensive immutable bindings snapshot from the in-memory SessionRegistry fake. |
| `type-design-analyzer-3` | deferred | Encoding an anchored root in the capability type changes the low-level no-follow filesystem Public Surface. |
| `comment-analyzer-6` | accepted | Delete duplicate/stale `anchoredDirectoryPath` JSDoc. |
| `comment-analyzer-7` | accepted | Correct Darwin `atomicWrite` wording. |
| `comment-analyzer-8` | accepted | Correct fake SessionRegistry header claims about deduplication and shallow snapshots. |
| `architecture-tech-lead-1` | deferred | Splitting StateManager's god seam is a multi-module migration outside this review's safe remediation boundary. |
| `architecture-tech-lead-2` | deferred | Replacing raw `AnchoredDirectory` primitives with a store handle redesigns a security-critical Public Surface. |
| `code-simplifier-1` | accepted | Same duplicate-JSDoc correction as `comment-analyzer-6`. |
| `code-simplifier-2` | accepted | Reuse `readDirectoryFileNoFollow` for anchored file reads while preserving errors. |
| `code-simplifier-3` | deferred | Replacing proof derivation's positional arrays changes the proof interface and is not required for correctness after exact Task-ID validation. |
| `code-simplifier-4` | accepted | Reuse one markdown case table in runtime-resource portability tests. |

### Part 4

| Finding | Disposition | Reason / fix |
|---|---|---|
| `code-reviewer-1` | accepted | Prove reservation ownership before transcript I/O so unreserved stops report `no-reservation`. |
| `code-reviewer-2` | accepted | Require reserved reviewer result Task identity to match the slot's Task before marking arrival. |
| `silent-failure-hunter-2` | accepted | Report a disappeared resolved transcript as a filesystem read failure rather than `no-final-payload`. |
| `type-design-analyzer-1` | deferred | Replacing exported lifecycle evidence booleans with a staged ADT changes LC-1's projection input interface and many tests. |
| `type-design-analyzer-2` | accepted | Bind advisory decision digest/context/references to one derived material set before action publication. |
| `comment-analyzer-2` | accepted | Correct the reducer/replay implementation comment. |
| `comment-analyzer-3` | accepted | Correct the stale T1 wording to Wave/run scope. |
| `comment-analyzer-4` | accepted | Correct the “only writer” test-suite comment. |
| `code-simplifier-1` | accepted | Share one internal exact next-action proof identity predicate. |
| `code-simplifier-2` | accepted | Extract repeated modern Claude attempt fixture setup. |

### Part 5

| Finding | Disposition | Reason / fix |
|---|---|---|
| `type-design-analyzer-2` | accepted | Make Wave review registration authority require a concrete Wave, matching `prepareWaveReviewBatch`. |
| `comment-analyzer-2` | accepted | Replace the stale `staleReservationsFromState` symbol reference with the actual recovery seam. |
| `comment-analyzer-3` | accepted | Correct the module header so it does not claim all parsing lives elsewhere. |

### Part 6

| Finding | Disposition | Reason / fix |
|---|---|---|
| `silent-failure-hunter-1` | accepted | Preserve the original write-grant injection failure and aggregate direct-revocation failure so grants cannot be silently orphaned. |
| `type-design-analyzer-1` | deferred | Splitting legacy/exact `PiReviewAttemptAuthority` into an ADT changes a wide cross-harness result interface. |
| `type-design-analyzer-2` | deferred | Turning `ReservedSlot` authority mixes into a full discriminated union is a broad persisted/runtime migration. |
| `architecture-tech-lead-1` | deferred | Decomposing the Pi extension adapter is a large interface redesign, not a targeted Finding fix. |
| `architecture-tech-lead-2` | deferred | Splitting the broad result-applier Public Surface requires coordinated caller migration. |
| `architecture-tech-lead-3` | deferred | Splitting Git I/O from pure evidence scanning changes a heavily consumed utility module interface. |
| `code-simplifier-1` | accepted | Share locked review-evidence application between malformed and parsed paths. |
| `code-simplifier-2` | accepted | Reuse `resolveCorrelatedRequest` for Pi result correlation. |

## Refuted-Finding audit

Never fix these as Findings:

- Part 1 `code-reviewer-2`: workspace `headSha` is a canonical byte digest, not Git HEAD; installation already re-observes dirty/untracked bytes.
- Part 1 `silent-failure-hunter-1`: stale spec-check rejection is intentionally a fail-closed no-op and later flow reloads exact authority.
- Part 1 `silent-failure-hunter-2`: reclaimed-at/authority inputs are parser-proven, making receipt-construction failure unreachable in production.
- Part 3 `comment-analyzer-5`: pending proof evidence is intentionally permitted by `hasLaterWaveTaskProgress`.
- Part 4 `comment-analyzer-1`: the pytest expression is line-start anchored through its enclosing alternative/context; panel rejected the claim.

## Implementation order

1. Restore the mutated Wave Gate Dispatch condition and add end-to-end Dispatch regression.
2. Fix lock-linearization defects (`store-spec-check`, `advance-phase`, no-follow recovery/mkdir).
3. Fix proof/authority invariants (`reopen-completed-wave`, Wave advisory status/action, registration authority, reserved result Task identity).
4. Fix fail-closed boundary diagnostics (`mark-subagent-active`, transcript capture, write-grant revocation, StateManager close).
5. Add all mandatory and accepted regression tests.
6. Apply accepted type/comment/distill changes without broad interface redesign.
7. Run distill apply mode against a green targeted baseline, then full validation.

## Validation

From `engine/`:

```bash
bun run typecheck
bun run test:unit
bun run test
```

Also run targeted suites after each implementation cluster and inspect `git diff --check`. Remediation installation must verify the temporary index's audited/staged equality before commit. No force push.
