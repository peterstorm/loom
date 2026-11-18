# ADR-0091: A fresh Wave Gate carries unchanged Tasks' accepted reviews

## Status
Accepted (2026-11-18). Amends ADR-0089: its Successor Carry extends the restart's accepted-task carry to a fresh start. Issue #213, Cause 5. Extended by ADR-0093: a Task that does not carry is issued only the reviewers its change since its Review Basis needs; the Subject Digest keeps naming the derived roster, and a narrowed acceptance carries like any other.

## Context
A Wave Gate that ends without completing is succeeded by a fresh `start wave-gate`: after an abandon (usually followed by `reopen-task` and a re-implementation), or after a completed Wave is reopened because some Task's bytes drifted. Every such fresh start issued spec-check plus the full roster of every reviewed Task. In the run behind #213 an advisory round on one Task of six cost 31 requests, 25 of which repeated reviews already accepted against bytes and context that had not changed.

The restart carry-over (ADR-0089) does not reach this path. It is decided at restart from a live predecessor; a fresh start has no live predecessor, and the abandon supersession dropped every acceptance the abandoned run recorded. Completion also admitted only acceptances from the run itself or its restart lineage. And the restart's admissibility rule compared bytes, generation and roster, not the rest of what a reviewer packet presents: the description, plan context, Requirement trace, proof, test result, owner map and contract surface.

## Options Considered

1. **Keep the full re-review**
   - Pros: nothing new to trust.
   - Cons: the cost of #213 stays; every re-gate of a large Wave pays for every Task.

2. **Carry by bytes alone, as the restart does**
   - Pros: no new fields.
   - Cons: an edited description, plan context, Requirement trace or a new owner map would carry a review that never saw it. A fresh start can be days after the acceptance, unlike a restart.

3. **Carry by a Subject Digest, along a protected succession**
   - Pros: a Task carries only when everything its packet presented is unchanged; provenance is a protected State File record, not the Run Directory alone.
   - Cons: a new optional field on the Review Run, the acceptance and the State File; acceptances recorded before it are reviewed in full once.

## Decision
**Option 3.** A fresh Wave Gate start succeeds the latest retired run of its Wave and carries, as ADR-0089 `accepted-task` entries, every reviewed Task whose accepted review still judges its unchanged subject.

- **Subject Digest.** The install records on each current Review Run the digest of its Task's review subject: protocol, roster, description, agent, plan context, Requirement anchors and contributions, declared and modified files, Review Generation, proof, test result, owner-map obligations, contract surfaces, plan file and the reviewed workspace scope and head. Finalisation seals it into the acceptance's `subject_digest` together with the Finding IDs the acceptance left (active and refuted). A Refutation Panel only moves Findings between those two sets, so it does not break the seal; any added Finding does. A restart carry compares it too when present, and reports `subject` drift.
- **Retired runs are protected provenance.** Retiring an abandoned run's tombstone (a fresh start's install, `reopen-task`, `add-task`, spec amendments) and reopening a completed Wave append a `retired_wave_review_runs` record: run, Wave, authority digest and how it ended. Retiring a tombstone no longer drops the acceptances the abandoned run recorded.
- **A registration records one origin.** Fresh, restart, orphan recovery or succession: the audits are exclusive by type and each keeps its own JSON key, so registrations written before stay valid.
- **Succession is planned at start and frozen into the registration.** `prepareWaveGateFacadeStart` names the predecessor (`successionPredecessorOf`: the abandoned tombstone, else the Wave's latest retired record), loads its registration and the reviewed workspaces, and asks the pure `planSuccessorCarry`. The registration gains `succession = {previousRunId, previousAuthorityDigest, kind, carry}` only when something carries, so a start with no carry is byte-identical to before. The lineage is the predecessor's own recorded lineage (restart or succession) plus the predecessor. `registeredCarry` is the one accessor for a registration's carry, restart or succession.
- **An acceptance carries only when** it is on that lineage, it has a `subject_digest`, the Task holds no unsettled Review Run, and its protocol, generation, roster, scope, head, Subject Digest and review status still hold. A legacy acceptance without the digest is reviewed in full once (`legacy-acceptance`). A sibling's change does not stop a Task carrying.
- **An advisory disposition never breaks a carried acceptance.** ADR-0090 records a disposition on the TaskGraph and leaves a deferred or dismissed advisory out of the prior Findings a later review is issued. Neither the Subject Digest nor its seal reads that selection. The digest covers what the packets present apart from Findings, and the seal binds the Task's active and refuted Finding IDs, which a disposition leaves unchanged. A carried Task is issued to no reviewer, so it has no selection to judge, and its advisories reach the new run's advisory decision with the dispositions already recorded for them. This holds for a restart's `accepted-task` as well. A partly accepted restart Task (`accepted-slots`) still treats a changed selection as drift, as ADR-0090 decided, because its reissued slots would be issued it.
- **`start wave-gate --fresh-review`** plans nothing and issues every reviewed Task in full.
- **Admission.** The locked registration install refuses a succession whose predecessor is not the protected one, or whose carried Task no longer holds the acceptance named. The batch install re-checks each carried acceptance against the observed bytes and Subject Digest, as ADR-0089 does. Completion admits a carried acceptance only from the registration's lineage and, for a succession, only while the predecessor is a protected retired record of the registration's exact Wave; the registration parser refuses a succession without one.
- **Unchanged from ADR-0089:** spec-check is always issued and the completion suite re-runs; carried criticals and advisories reach this run's Refutation Panel and advisory decision; the start reports each reviewed Task it did not carry and why (`wave-gate-start-not-carried` on stderr), never in the registration.

## Consequences

**Positive:**
- The #213 advisory round re-gates with spec-check plus the changed Task's roster: 6 requests instead of 31.
- The carry rule now covers the whole packet subject for restarts as well.

**Negative:**
- A Task accepted before this change is reviewed in full on its next fresh start.
- A predecessor older than the immediate one is trusted through the predecessor's immutable registration, as a restart's lineage is; only the immediate predecessor is checked against protected state.
- `review_status: passed` and the abandoned run's acceptance survive the abandon until a successor reviews or reopens the Task.
