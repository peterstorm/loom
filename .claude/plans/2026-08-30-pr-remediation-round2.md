# PR #35 round-two remediation

## Authority and exact scope

- Branch: `fix/deterministic-task-completion-post-merge`
- PR: https://github.com/peterstorm/loom/pull/35
- Exact scope: the union of the seven immutable `result.json.scope` arrays below, partitioning all 116 paths in `origin/main...HEAD` to fit cloud Context Packet limits.
- Review runs:
  1. `review-20260830T070614Z-pr35-round2-part1-cloud`
  2. `review-20260830T074447Z-pr35-round2-part2-cloud`
  3. `review-20260830T081930Z-pr35-round2-part3-cloud`
  4. `review-20260830T085430Z-pr35-round2-part4-cloud`
  5. `review-20260830T093053Z-pr35-round2-part5-cloud`
  6. `review-20260830T100227Z-pr35-round2-part6-cloud`
  7. `review-20260830T103658Z-pr35-round2-part7-cloud`

## Mandatory surviving critical Findings

### Part 1

- `code-reviewer-1` — make `resolveCorrelatedRequest` reject correlator role/attempt disagreement with the issued request; add direct regressions.
- `silent-failure-hunter-1` — transcript candidate probing may fall back only on `ENOENT`; propagate unreadable/corrupt/other filesystem failures.

### Part 2

- `code-reviewer-1` — bind Wave spec-check authority to exact plan/spec bytes, not merely their paths; reject stale evidence after either changes.
- `code-reviewer-2` — parse and scope `spec_dir` beneath `.claude/specs` before artifact discovery or persistence.

### Part 3

- `code-reviewer-1` — durably terminalize an already-resolved Claude reservation when transcript location/read/JSON capture fails, preventing infinite respawn.
- `code-reviewer-2` and `comment-analyzer-1` — make the Git diff scanner parse quoted paths and enforce actual diff-entry prelude state so hunk text cannot forge `+++ b/*.test.ts` headers or assertion evidence.
- `code-reviewer-3` — under the state lock, reject stale Wave review installation and preserve any newer captured spec-check state.

### Part 4

- `code-reviewer-1` — route request-bound Wave Gate settlement from exact request authority, not optional/corrupt `agent_type` metadata.
- `type-design-analyzer-1` — make artifact-set promotion consume only parser-minted staged artifacts; no exported structural path pair.
- `comment-analyzer-1` — correct verified-slot comments to describe the intentionally narrower transcript/rejection read identity.
- `comment-analyzer-2` — correct Darwin directory-creation comments to pathname mkdir after no-follow/identity proof.
- `architecture-tech-lead-1` — parse correlator `requestId` before it can address `requests/<id>.json`.

### Part 5

- `code-reviewer-1` — preserve own `__proto__` JSON members during canonical reconstruction so distinct untrusted documents cannot collapse to identical authority bytes.
- `code-reviewer-2` — scope lifecycle Finding counts to the active Wave; retained Findings from another Wave must not block/deadlock it.
- `architecture-tech-lead-1` — treat later-Wave active/history Implementation Attempts as progress that forbids completed-Wave reopening.

### Part 6

- `code-reviewer-1` — aggregate all recognized runner evidence so any observed failure dominates an earlier pass.
- `pr-test-analyzer-2` — add Pi integration coverage for graphless missing reviewer/spec-check diagnostics.
- `architecture-tech-lead-1` — anchor Node/Mocha pass summaries so prose such as “15 passing checks” is not test evidence.

### Part 7

- `code-reviewer-1` — a SubagentStart lacking `agent_id` must not run unrostered or let tool evidence inherit another Agent's binding; fail closed or mint exact safe identity.
- `comment-analyzer-1` — update the module header to include implementation-attempt sidecar authority among its responsibilities.

## Advisory dispositions

### Part 1

| Finding | Disposition | Reason |
|---|---|---|
| `pr-test-analyzer-4` | accepted | Add legacy panel capture-rejection translation coverage while retaining unknown-event refusal. |
| `comment-analyzer-1` | accepted | Correct the archive header's deprecation/re-export wording. |
| `architecture-tech-lead-1` | deferred | A transcript-location port redesign changes a broad harness/filesystem seam. |
| `architecture-tech-lead-2` | deferred | Closing Task review state into a persisted ADT is a schema-wide migration. |
| `code-simplifier-1` | accepted | Share legacy architecture/refutation journal parsing. |
| `code-simplifier-2` | accepted | Reuse one execution-baseline bundle type. |

### Part 2

| Finding | Disposition | Reason |
|---|---|---|
| `silent-failure-hunter-1` | accepted | An explicit out-of-scope `state.spec_file` is corrupt authority and must fail closed instead of falling back. |
| `silent-failure-hunter-2` | accepted | Narrow chmod fixture suppression to expected first-write absence and surface other failures. |
| `type-design-analyzer-1` | accepted | Preserve digest brands through Wave Task run authority. |
| `type-design-analyzer-2` | deferred | Replacing missing-result arrays with a persisted/cross-harness XOR ADT has broad caller impact. |
| `comment-analyzer-3` | accepted | Correct brainstorm fallback wording. |
| `comment-analyzer-4` | accepted | Correct backstop suite count/scope wording. |
| `comment-analyzer-5` | accepted | Correct the Darwin remediation plan self-reference. |
| `architecture-tech-lead-1` | accepted | Observe filesystem artifact inputs before the lock, then run a pure transition/locked authority recheck. |
| `code-simplifier-1` | accepted | Delegate directly where SessionRegistry port shape already matches ledger behavior. |
| `code-simplifier-2` | accepted | Name the spec-check scope predicates instead of one compound branch. |
| `code-simplifier-3` | accepted | Extract repeated Subagent pointer fixture setup. |

### Part 3

| Finding | Disposition | Reason |
|---|---|---|
| `code-reviewer-4` | accepted | Recheck exact active Wave Gate authority under the lock before committing Refutation Panel outcomes. |
| `type-design-analyzer-1` | deferred | A full `ReservedSlot` authority ADT is a broad Pi lifecycle migration. |
| `type-design-analyzer-2` | accepted | Construct a typed non-empty slot-authority roster without `as never`. |
| `comment-analyzer-2` | accepted | Correct supplied-transcript precedence wording to include availability/fallback behavior. |
| `architecture-tech-lead-1` | deferred | Unifying Claude/Pi settlement changes two harness shells and their Public Surfaces. |
| `architecture-tech-lead-2` | deferred | A new pure Wave Gate resume planner is broad façade redesign constrained by ADR-0005. |
| `code-simplifier-1` | accepted | Table-drive spec-check marker extraction. |
| `code-simplifier-2` | accepted | Share Wave Gate reset/replacement scaffolding. |
| `code-simplifier-3` | accepted | Reuse one project-directory test helper. |
| `code-simplifier-4` | accepted | Name and reuse the correlator digest fixture recipe. |

### Part 4

| Finding | Disposition | Reason |
|---|---|---|
| `type-design-analyzer-2` | accepted | Make the read-only State command set runtime immutable, not merely typed readonly. |
| `comment-analyzer-3` | accepted | Correct the Pi result test header's repository claim. |
| `code-simplifier-1` | accepted | Replace the async-IIFE/sentinel shell with direct scoped try/catch. |
| `code-simplifier-2` | accepted | Use direct compile-time authority assertions. |
| `code-simplifier-3` | accepted | Extract the repeated locked-state mutation harness. |

### Part 5

| Finding | Disposition | Reason |
|---|---|---|
| `silent-failure-hunter-1` | accepted | Preserve terminal-block action construction failure as explicit unavailable status. |
| `silent-failure-hunter-2` | accepted | Preserve done-action construction failure as explicit unavailable status. |
| `pr-test-analyzer-1` | accepted | Add duplicate reopening-proof Task ID regression. |
| `pr-test-analyzer-2` | accepted | Replace timer-sensitive lock race with deterministic synchronization. |
| `type-design-analyzer-1` | accepted | Preserve canonical `ReviewPath` branding after parsing. |
| `comment-analyzer-1` | accepted | Document all cleanup responsibilities. |
| `comment-analyzer-2` | accepted | Describe postimage as HEAD bytes, not ambiguous original bytes. |
| `architecture-tech-lead-2` | deferred | Parser-minting `WaveReopeningProof` changes an exported proof interface; exact invariant checks remain mandatory. |
| `code-simplifier-2` | accepted | Share Review Packet envelope validation. |

### Part 6

| Finding | Disposition | Reason |
|---|---|---|
| `pr-test-analyzer-3` | accepted | Add missing/unreadable transcript evidence-capture tests. |
| `type-design-analyzer-1` | deferred | Replacing TestEvidence's established product type with a witness ADT changes many consumers. |
| `type-design-analyzer-2` | deferred | A full PiSpawnReservation lifecycle ADT is broad extension-state redesign. |
| `architecture-tech-lead-2` | deferred | Extracting the entire tool-result batch lifecycle is a large interface redesign. |
| `code-simplifier-1` | accepted | Reuse the already parsed immutable session ID. |
| `code-simplifier-2` | accepted | Replace historical test prose with the current invariant. |

### Part 7

| Finding | Disposition | Reason |
|---|---|---|
| `silent-failure-hunter-1` | accepted | Aggregate operation/lock failure with descriptor-close failure instead of masking the primary error. |
| `type-design-analyzer-1` | accepted | Return parser-constructed branded Task IDs from `parseTaskGraph`. |
| `type-design-analyzer-2` | deferred | An anchored-leaf capability type changes the low-level no-follow filesystem Public Surface. |
| `comment-analyzer-2` | accepted | Replace time-bound “the plan” wording with durable security rationale/ADR reference. |
| `architecture-tech-lead-1` | deferred | Moving all Wave Gate transition policy out of StateManager is a multi-module persistence redesign. |
| `architecture-tech-lead-2` | deferred | Splitting mark-active planning/rollback into a new seam is broad Hook-interface redesign. |
| `code-simplifier-1` | accepted | Use `findLast` for newest call-start lookup where runtime support is guaranteed. |
| `code-simplifier-2` | accepted | Extract repeated cleanup binding fixture. |
| `code-simplifier-3` | accepted | Share one private anchored leaf-write primitive with preserved error/close semantics. |

## Refuted-Finding audit

Never fix these as Findings:

- Part 1 context-packet tamper coverage already exists outside the partitioned scope.
- Part 1 capture refusal terminalization/audit coverage already exists outside the partitioned scope.
- Part 1 stale reservation invalidation coverage already exists outside the partitioned scope.
- Part 2 lifecycle-arm comment remains accurate for the closed current spawn union.
- Part 2 runtime-identity comment is read as the recursive source walk plus explicitly listed package files.
- Part 5 structured Finding counts are consumed by `deriveFindingCounts`; the alleged legacy-only bypass was not reproducible.
- Part 6 zero-test runner summaries already have coverage outside the partitioned scope.

## Validation

From `engine/`:

```bash
bun run typecheck
bun run test:unit
bun run test
```

Also run focused regressions after each cluster and `git diff --check`. Registered remediation must install an exact audited Git index before commit and push.
