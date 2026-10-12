# D4.1 — Amend a v2 Requirement trace in place

- **Issue:** #57 D4.1
- **Status:** implemented on feat/amend-spec-trace (see "Implementation deviations" at the end)
- **Date:** 2026-10-12

## Problem

A populated v2 TaskGraph cannot change any Task's `spec_anchors` (Completion Claims) or `spec_contributions` in place:

- `upgrade-spec-trace` refuses v2→v2 changes by design (`spec-trace-migration.ts:173-177`). It is a one-shot legacy migration whose only replay is the identical one.
- `populate-task-graph --force` is the only route. It resets every Task to `pending`, mints fresh pending proof, sets `review_generation: 0`, clears every Finding, and drops all Wave authority (`task-graph-population.ts`).

So an anchor-only correction, such as a Requirement claimed by the wrong Task or a missing Contribution, throws away every settled implementation, review and refutation result.

## What the trace feeds, and why a naive edit is unsafe

Verified by a full map of the readers (2026-10-12):

1. **No gate re-checks stored evidence against the live trace.**
   - `checkSpecAlignment` checks only `spec_check.wave`, the verdict and the critical count (`wave-gate-checks.ts:161-176`).
   - Resume reuses a complete persisted review batch whose packets froze the old `specAnchors`/`specContributions`.
   - If the trace changed under issued packets, the Wave would complete on stale scope with no error.
2. **Every Wave's trace moves the current Wave's spec-check floor.**
   - `coverageTasks` lifts all Tasks.
   - `claimedAnywhere` and `unclaimed` read every Wave's Completion Claims.
   - The settled floor and packet read out-of-Wave anchors and `spec_anchor_hashes`, but `batchEpoch` does not.
   - So any amendment, not only one to a current-Wave Task, invalidates an installed `wave_review_epoch`.
3. **`spec_anchor_hashes` are minted only at population.**
   - `upgrade-spec-trace` never touches them.
   - A newly added claim reads as `unverifiable`, with a message saying "named no indexed entry at population time".
   - A removed claim's hash lingers, and nothing checks that the hash keys are a subset of `spec_anchors`.
4. **Nothing checks trace ids against the Spec Index at write time.** An unknown id passes the load boundary. It surfaces later as a CRITICAL `unknown-requirement` row, or as a `requirement-text-unavailable` brief refusal at the next spawn.
5. **Completed Waves are verified scope.**
   - `wave_gate_history[].authorityDigest` and `completionReceipt.stateDigest` hashed the old trace, and nothing re-verifies them.
   - `reopen-completed-wave` exists, but only for proven workspace drift, not for trace edits.

## Design

A new whitelisted helper, `helper amend-spec-trace`, with a pure core aggregate command:

```
amendSpecTrace(graph, amendment, specIndex) → Result<Amended, AmendmentRefusal>
```

It amends the trace in place and retires, in the same locked write, exactly the authority derived from the old trace. It is a separate helper from `upgrade-spec-trace`: that one stays the idempotent legacy migration, and merging the two would give one helper two contracts.

### Input

The same exact-roster contract `upgrade-spec-trace` already parses (`parseOwnershipInput` and `rosterError`, exported and reused, not copied):

```json
{"spec_trace_version": 2, "tasks": [{"id": "T1", "spec_anchors": ["FR-001"], "spec_contributions": []}, ...]}
```

Every Task appears exactly once, in protected order. Arrays are compared as sets, so a pure reordering is not an amendment and an exact replay is a no-op.

### Preconditions (refusals, checked in this order, nothing written)

1. The graph is v2. A legacy graph uses `upgrade-spec-trace`.
2. There are no `executing_tasks` and no active subagent. The implementation brief's prompt digest binds the rendered trace text.
3. **No live Wave Gate:** `active_wave_gate` is absent or a `terminal-abandoned` tombstone. A live run's packets froze the old trace, so the operator abandons it first; abandon now stamps the tombstone (#74).
4. **Completed Waves are immutable:** every Task in a Wave present in `wave_gate_history` keeps a set-equal trace. Moving a Completion Claim into or out of a completed Wave is the same change seen from the other side, so it is refused too.
5. **Every new or changed id exists in the Spec Index.**
   - The Spec Index is observed at amend time, exactly like population does.
   - If the index is unavailable and the amendment adds a Completion Claim, it is refused (fail closed). Removals and Contribution-only changes still apply.
6. The candidate passes the full relational `parseSpecTraceContract`. The load boundary runs it anyway; running it first gives a typed refusal, not a write error.

### The locked transition

- **Trace:** replace only `spec_anchors` and `spec_contributions` on the amended Tasks.
- **Hashes, per amended Task:**
  - keep the existing hash for every retained Completion Claim, which preserves drift evidence;
  - mint a hash from the amend-time Spec Index for every added claim;
  - drop the hashes of removed claims.

  Afterwards the hash keys are a subset of `spec_anchors`. The load boundary gains that check, and it holds for all writers.
- **Retire trace-derived review authority** with `resetWaveGateReviewAuthority` for every Task in the current Wave. This is the same retirement restart, orphan recovery and successor start already use.
  - It clears `review_run`, `spec_check`, `wave_review_epoch`, `active_wave_completion_suite` and the tombstone.
  - It re-derives `wave_gates` blocks.
  - It keeps Findings and review generations.
  - It also clears `accepted_review_authority` where it points at the abandoned run, as `supersedeAbandonedWaveGateReview` does.
- **Keep:** Task `status`, `proof`, attempt history, test evidence, findings, refuted and resolved findings, completed history.
- **Audit:** append a `spec_trace_amendments` entry: `{schemaVersion: 1, kind: "spec-trace-amendment", wave: current_wave, retiredRunId | null, changes: [{taskId, before: {anchors, contributions}, after: {...}}], specIndexObservation}`. It gets a strict wire parser, and the amended state must agree with the last entry.

### What the operator does afterwards

1. Status shows the Wave in its implementation window, with the start recovery.
2. The next `/wave-gate` start issues fresh packets over the amended trace, so spec-check and reviewers judge the new scope.
3. Implementation proof is untouched, so nothing is re-implemented.
4. Tasks whose reviews were reopened are re-reviewed by that gate as usual.

## Rejected alternatives

- **Relax `upgrade-spec-trace` to allow v2→v2.**
  - It would give one helper two contracts.
  - Its `retireWaveGateScope` is narrower than `resetWaveGateReviewAuthority`: it leaves `review_run`, `accepted_review_authority` and `active_wave_completion_suite`, and it never re-derives blocks.
  - Kept as is. Whether that narrower retirement is itself a defect is noted below and should be checked separately.
- **Allow completed-Wave amendments with an audit flag.** Completed history is verified authority. Changing its scope without re-verification is exactly the silent-stale-evidence failure above.
- **Amend under a live gate and re-issue packets automatically.** That couples a state helper to the Run Directory program. Abandon-then-amend reuses two existing, tested operations.

## Tests (written first)

- **Core (pure):**
  - each refusal, as a typed error;
  - an exact replay is a no-op;
  - hash retention, minting and dropping;
  - retirement clears exactly the trace-derived fields and keeps status, proof and findings;
  - the audit entry matches;
  - property: any accepted amendment yields a graph the load boundary accepts, with hash keys a subset of anchors.
- **Shell:**
  - the helper commits through StateManager;
  - it refuses an executing Task or active subagent;
  - with a tombstone, the amendment then a fresh successor start installs cleanly;
  - without a tombstone, a fresh start installs cleanly.
- **Load boundary:** a hash key outside `spec_anchors` is refused, and existing graphs still load.
- **Registration:** whitelist, `KNOWN_HANDLERS`, the handshake route, and the guard-state-file helper match.

## Docs

- `docs/operations.md`:
  - a new "Amending the Requirement trace" section;
  - the escalation/attest section stops naming "anchor-only repair" as a reset scenario.
- `commands/loom.md`, the decompose/repair guidance.
- `CONTEXT.md`, the Requirement Content Hash entry: hashes are minted when an edge is created, at population or at amendment.

## Separate follow-ups (not in this change)

- `upgrade-spec-trace --retire-abandoned-run` uses the narrower `retireWaveGateScope`. Check whether it leaves `review_run` or `accepted_review_authority` behind for the successor.
- The stale doc comment on `coverageTasks`: enforcement reads `epochSettledFloor`, not "the same lift".

## Implementation deviations

- **No load-boundary "hash keys ⊆ anchors" check.** `upgrade-spec-trace` changes anchors without touching hashes, so an upgraded legacy graph can legitimately carry a hash key for a claim it no longer makes; a load check would make such graphs unloadable. The invariant is enforced by construction for every amended Task and pinned by the core property test. The load boundary instead checks that each Task's live trace matches its latest `spec_trace_amendments` change (set-equal).
- **Any added id needs an available Spec Index, Contributions included** (the design refused only added Completion Claims). An unproven Contribution id would surface later as a relational or projection failure; failing closed at amend time is cheaper. Removals still apply without an index.
- **Added ids must be completable (FR/AS), not merely indexed.** An OOS id is refused as `unknown-requirement`, since claiming or contributing to an excluded item is a category error.
- **Retirement when no tombstone exists is residue-only.** `resetWaveGateReviewAuthority` runs only if a current-Wave epoch, completion suite, spec-check, or `review_run` survives; otherwise nothing else changes, so an older Wave's `spec_check` is not cleared needlessly. With a tombstone, the exported `supersedeAbandonedWaveGateReview` is reused unchanged.
- **Exact replay is a no-op before state preconditions.** A replay after a successor gate went live returns `unchanged` instead of `live-wave-gate`.
- **Added refusals:** `not-executing` (phase must be execute) and `spec-authority-changed` (the observed Spec Index must name the locked `spec_file`, mirroring population).
- **Re-population drops `spec_trace_amendments`** with the Tasks it described.
