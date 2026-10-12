# D4.1 — Amend a v2 Requirement trace in place

- **Issue:** #57 D4.1
- **Status:** implemented on feat/amend-spec-trace (see "Implementation deviations" at the end)
- **Date:** 2026-10-12

## Problem

A populated v2 TaskGraph cannot change any Task's `spec_anchors` (Completion Claims) or `spec_contributions` in place:

- `upgrade-spec-trace` refuses v2→v2 changes by design (`validatedOwnershipCandidate` in `spec-trace-migration.ts`). It is a one-shot legacy migration whose only replay is the identical one.
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

The same exact-roster contract `upgrade-spec-trace` already parses (`parseOwnershipInput` and `rosterError`, now in `core/spec-trace.ts` and shared by both helpers, not copied):

```json
{"spec_trace_version": 2, "tasks": [{"id": "T1", "spec_anchors": ["FR-001"], "spec_contributions": []}, ...]}
```

Every Task appears exactly once, in protected order. Arrays are compared as sets, so a pure reordering is not an amendment and an exact replay is a no-op.

### Preconditions (refusals, nothing written)

As implemented, checked in this order; the first that applies wins. Items marked † were added during implementation (see "Implementation deviations").

1. `legacy-graph`: the graph is v2. A legacy graph uses `upgrade-spec-trace`.
2. `invalid-input`: the exact roster parses, matches the protected roster in order, and repeats no id within a Task's arrays.
3. **No-op replay:** a submitted trace that is set-equal for every Task returns `unchanged` here, before any state precondition.
4. `not-executing` †: the graph is in the execute Phase with a current Wave.
5. `spec-authority-changed` †: the observed Spec Index names the locked `spec_file`.
6. `implementation-active`: there are no `executing_tasks`. The shell also refuses an active subagent before and under the lock. The implementation brief's prompt digest binds the rendered trace text.
7. `live-wave-gate`: **No live Wave Gate.** `active_wave_gate` is absent or a `terminal-abandoned` tombstone. A live run's packets froze the old trace, so the operator abandons it first; abandon now stamps the tombstone (#74).
8. `completed-wave-changed`: **Completed Waves are immutable.** Every Task in a Wave present in `wave_gate_history` keeps a set-equal trace. Moving a Completion Claim into or out of a completed Wave is the same change seen from the other side, so it is refused too.
9. `spec-index-unavailable` / `unknown-requirement`: **every added id, claim or Contribution, is a completable FR/AS entry of the Spec Index observed at amend time**, exactly like population. An unavailable index refuses any added id (fail closed); removals still apply.
10. `invalid-trace`: the candidate passes the full relational `parseSpecTraceContract`. The load boundary runs it anyway; running it first gives a typed refusal, not a write error.

### The locked transition

- **Trace:** replace only `spec_anchors` and `spec_contributions` on the amended Tasks.
- **Hashes, per amended Task:**
  - keep the existing hash for every retained Completion Claim, which preserves drift evidence;
  - mint a hash from the amend-time Spec Index for every added claim;
  - drop the hashes of removed claims.

  Afterwards an amended Task's hash keys are a subset of its claims: every added claim is hashed, every retained claim keeps its recorded hash if it had one (a claim hashless since legacy upgrade stays hashless), and removed claims' hashes are dropped. This holds by construction; there is no load-boundary check (see deviations).
- **Retire trace-derived review authority** for the current Wave: `supersedeAbandonedWaveGateReview` over a tombstone, otherwise any residue, both through one `retireWaveReviewAuthority(graph, wave)` in `wave-gate-registration.ts`, built on `resetWaveGateReviewAuthority`. This is the same retirement restart, orphan recovery and successor start already use.
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
  - property: any accepted amendment yields a graph the load boundary accepts, with each amended Task's hash keys a subset of its claims (equal to them when every retained claim was hashed, as in the test fixture).
- **Shell:**
  - the helper commits through StateManager;
  - it refuses an executing Task or active subagent;
  - with a tombstone, the amendment then a fresh successor start installs cleanly;
  - without a tombstone, a fresh start installs cleanly.
- **Load boundary:** a trace contradicting its latest amendment is refused, and existing graphs still load. (The planned hash-key subset check was dropped; see deviations.)
- **Registration:** whitelist, `KNOWN_HANDLERS`, the handshake route, and the guard-state-file helper match.

## Docs

- `docs/operations.md`:
  - a new "Amending a v2 Requirement trace" section;
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
- **A repeated id in a submitted trace is `invalid-input`** (PR #75 review). Arrays compare as sets, so without it a repeated id read as an unchanged replay and reported success; the protected trace was never at risk because a changed candidate failed `invalid-trace`.
- **One retirement entry point beside the reset** (PR #75 review, rounds 1 and 2): `retireWaveReviewAuthority(graph, wave)` in `wave-gate-registration.ts` owns the tombstone-versus-residue branch, the residue predicate and the reset, and throws on a live gate (the caller's precondition). Each residue field is pinned by its own test, so a field added to the reset but missed by the predicate fails there.
- **The exact-roster input grammar lives in `core/spec-trace.ts`** (PR #75 review, round 2), beside `parseTraceOwnership`, `traceOf` and `sameRequirementTrace`, so the permanent amendment command does not depend on the removable legacy-upgrade module.
- **The load boundary chains each Task's amendment history** (PR #75 review, round 2): a change must start, as sets, where that Task's previous change ended. Changes are not tied to `wave_gate_history`, because an amended Wave later completes legitimately.
