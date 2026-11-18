# ADR-0088: Wave Gate restart carries accepted review evidence and reissues only exhausted slots

## Status
Accepted (2026-11-18). Partly supersedes ADR-0084: its "every request is reissued" bullet, for a
replacement whose predecessor issued the same reviewer protocol. Issue #213, Cause 1(b).

## Context
A Wave Gate can be restarted only when every reviewer slot without evidence has exhausted attempt 2
(`prepareExhaustedWaveGateRestart`). The restart retired the whole review generation:
`resetWaveGateReviewAuthority` folded each accepted slot's new Findings into the Task, dropped the Review
Run and cleared the epoch, and the replacement issued spec-check plus every reviewed Task's full roster.
In the live run behind #213 one mistyped hash exhausted one slot, and the restart reissued all 35
requests. Thirty-four of them repeated reviews that had already been accepted against bytes that had
not changed.

The accepted evidence could not simply be kept, because everything that binds it is run-scoped. The
authority digest, `batchEpoch` (which hashes the run ID), the Review Packet ID and every slot and request ID
differ between run A and its replacement B for an unchanged Task. Stored evidence binds its slot, request
and context identity. Minting B identities for A's work would make B claim it issued requests it never
issued.

## Options Considered

1. **Task-level carry only**: a Task whose whole roster was accepted is not reissued; any other Task is
   issued in full.
   - Pros: no slot provenance; a Review Run never mixes runs.
   - Cons: does not meet "reissue only the exhausted slots". The #213 Task with four accepted slots and
     one exhausted would still reissue all five.

2. **Reissue the exhausted slot inside the same run**
   - Pros: no replacement run at all.
   - Cons: a third attempt needs an ordinal in slot identity and breaks exact batch classification. It
     weakens "attempt 2 is final" (ADR-0019), and it cannot compose with a later Task-scoped carry.

3. **Slot-level carry across a new run, by reference**
   - Pros: only the exhausted slots and spec-check are reissued. Carried evidence keeps the identity it
     was accepted under and names where it came from.
   - Cons: a Review Run can hold slots from two runs, and completion must admit an acceptance that another
     run recorded.

## Decision
**Option 3.** A restart carries every accepted reviewer slot of its predecessor into the replacement run
by reference. The replacement issues spec-check and the exhausted slots only.

- **The carry plan is decided once, at restart, and frozen into the replacement's registration** as
  `restart.carry = {lineage, carried}`. `lineage` lists every `{runId, authorityDigest}` along the
  unbroken chain of carrying restarts that led here, oldest first. Chained restarts that carry accumulate
  it, and a predecessor that carried nothing starts it afresh. `carried` lists, per reviewed Task, either `accepted-task`
  (every roster slot was accepted on the lineage; the Task is not reissued; the entry records that roster
  and the acceptance) or `accepted-slots` (the accepted agents). The plan is decided under the restart lock
  from the protected graph, the observed reviewed workspaces, and the roster the predecessor issued.
  `sameRestartRegistration` compares it. Because the registration is immutable and outlives the epoch, a
  completed run's replay can still prove its roster from it.
- **Carry is admissible only when nothing the evidence judged has changed:** the Review Generation, the
  reviewed workspace scope and head, the prior Finding IDs, the derived roster and the reviewer protocol
  descriptor. Otherwise the Task falls back to the full reset of today: accepted new Findings are folded
  and the Task is issued in full. A v2-registered predecessor never carries into a v4 replacement
  (ADR-0084). The restart names each such Task and its typed reason (the drifted facts, an unobserved or
  refused workspace, an acceptance off the lineage, nothing accepted) on its output. The reasons are the
  restart's result and stay out of the registration bytes.
- **Carried slots keep their identity and name their origin.** At install the replacement rebinds a
  carried Task's Review Run under its own Review Packet. Each carried slot keeps the predecessor's slot,
  request and context identity plus `carried_from: {run_id, authority_digest, packet_id}`. Its evidence is
  unchanged. Each exhausted agent gets a fresh slot from the replacement batch. The State File refuses a
  carried slot without evidence or one naming its own run.
- **Spec-check is always reissued.** A Task whose whole roster was accepted is not reissued at all. Its
  acceptance stays the one its run recorded.
- **Completion admits an acceptance only from the replacement run itself or from a carried `accepted-task`
  whose acceptance is on the recorded lineage.** A forged or foreign acceptance is refused.
- **Only the restart lineage carries.** Orphan recovery keeps the full reissue, because the predecessor's
  Run Directory is proven absent.
- Attempt 2 stays final per slot. The reissued reviewer assesses the same prior roster its carried
  siblings assessed. Spec-check and the completion suite re-run. Carried criticals go to the Refutation
  Panel of the replacement run. Findings minted from carried evidence keep the Review Packet that issued it,
  including when an abandoned replacement folds them.
- An empty carry plan changes nothing. The registration, `batchEpoch` and every slot ID stay byte-identical
  to the replacement of today. The plan enters `batchEpoch` only when present. State Files, registrations
  and epochs without the new optional fields load unchanged.

## Consequences
- A single exhausted slot costs one reissued request plus spec-check, not the whole Wave.
- A Review Run can hold slots issued by different runs. `carried_from` says which, and every reader that
  attributes evidence (Finding provenance, completed-roster verification) reads it.
- Workspace drift between restart and the replacement's first install refuses the install. The carried
  evidence judged bytes that no longer exist, so the run is blocked rather than silently reissued; abandon
  it and start a fresh Wave Gate.
- When a replacement is abandoned, an acceptance it carried keeps its original run. The successor's fresh
  start has no lineage, so it reissues that Task and completion refuses the old acceptance.
