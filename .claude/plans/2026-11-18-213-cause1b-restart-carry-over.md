# #213 Cause 1(b): Wave Gate restart reissues only exhausted slots

- Issue: peterstorm/loom#213, Cause 1 part (b). Worktree `../loom-restart-carry-over`, branch `fix/restart-carry-over` from origin/main (c022195a, includes Cause 1(a): ADR-0084).
- ADR: ADR-0089 (the number before it goes to open PR #217, whose own ADR collides with main's ADR-0084 and must renumber), "Wave Gate restart carries accepted review evidence and reissues only exhausted slots" — partly supersedes ADR-0084's "every request is reissued" bullet for a same-protocol predecessor.
- Decisions (operator, 2026-11-18):
  - Slot-level carry: reissue only exhausted slots (not Task-level only).
  - Spec-check is always reissued on restart; it is never carried.
  - Carry only along the restart lineage; orphan recovery keeps today's full reissue (its predecessor's Run Directory is proven absent).

## What restart does today
- Precondition: every slot without evidence is exhausted at attempt 2 (`engine/src/core/wave-gate-replacement.ts:97-119`).
- `resetWaveGateReviewAuthority` (`engine/src/core/wave-gate-registration.ts:185-217`) folds accepted slot findings into `findings` (`preserveAcceptedReviewRunFindings`, `engine/src/core/findings.ts:1471`), drops the run, clears `spec_check`, `wave_review_epoch` and the completion suite.
- `prepareWaveReviewBatch` issues every reviewed Task's full roster (`engine/src/core/wave-review-authority.ts:1053,1166`) plus spec-check (`engine/src/core/wave-review-issuance.ts:73-80`). Completion refuses acceptances from another run (`engine/src/handlers/helpers/programs/wave-gate.ts:206-212`). Result: 1 + every roster slot (the 35). Pinned at `engine/tests/handlers/helpers/orchestration.test.ts:3382`.

## Why carried evidence needs explicit provenance
`authorityDigest`, `batchEpoch` (hashes runId), `packetId`, slot and request ids all differ between run A and run B for an unchanged Task (`engine/src/core/wave-review-authority.ts:114-120,1095-1117,1178-1230`). Evidence binds slot/request/context ids (`engine/src/core/findings.ts:1637-1680`). Carry by reference: keep A's slot identity plus a `carried_from` marker; never re-mint B ids for work B did not issue. Admissible only with the same generation, workspace scope and head, `prior_finding_ids`, derived roster and reviewer protocol descriptor.

## Design as shipped (ADR-0089)
The pre-implementation sketch (a restart.carriedAuthority lineage, the plan frozen in a wave_review_epoch.carried field, resume and completion reading the epoch) is superseded by ADR-0089. The epoch is cleared at completion, but a completed run's replay must still prove its roster. The registration is durable, immutable and compared by `sameRestartRegistration`. So the plan lives there:
- Registration: `restart.carry = {lineage, carried}`. `lineage` is every `{runId, authorityDigest}` along the unbroken chain of carrying restarts, oldest first. `carried` holds per reviewed Task an `accepted-task` (roster + acceptance) or `accepted-slots` (agents) entry. Absent when nothing carries, so such registrations stay byte-identical.
- Pure `planRestartCarry` (`engine/src/core/wave-review-carry.ts`) decides under the restart lock from the graph, the observed workspaces and the predecessor's published rosters (`publishedRostersOf`). It returns the audit and a typed not-carried reason per reviewed Task issued in full; the restart reports the reasons on its output, never in the registration.
- Restart keeps a carried Task's run unfolded; others reset as today.
- `issuedRoles` and `waveReviewCarryOf` (`engine/src/core/wave-review-carry-plan.ts`) are the one reading of a plan: batch preparation, install, rebinding, resume classification and completed-roster verification use them. The plan enters `batchEpoch` only when present.
- Install rebinding (`rebindCarriedReviewRun`): carried slots keep A's identity plus `carried_from: {run_id, authority_digest, packet_id}`, evidence unchanged; exhausted agents get fresh B slots. Drift after the restart refuses the install.
- Completion admits an acceptance from the run itself or an `accepted-task` carry whose acceptance is on the lineage (`waveAcceptanceProblem`).
- Invariants: attempt 2 stays final per slot; a carried slot without evidence, or naming its own run, is refused; the reissued reviewer assesses the same prior roster; spec-check and the completion suite re-run; carried criticals still go to the Refutation Panel in B; abandoning B folds carried evidence into findings under its origin packet.
- Composes with Cause 5: it widens the admissibility rule and reuses the registration's `carry` plan.

Rejected: Task-level only (does not meet "only the exhausted slots"); reissuing the slot inside the same run (needs an ordinal in slot identity, breaks exact batch classification, weakens ADR-0019, cannot compose with Cause 5).

## Files
New `engine/src/core/wave-review-carry.ts` and `engine/src/core/wave-review-carry-plan.ts`; change `findings-shape.ts`, `findings.ts`, `state-file-wire.ts`, `wave-gate-program.ts`, `handlers/helpers/programs/registration.ts`, `wave-gate-replacement.ts`, `wave-gate-registration.ts`, `wave-review-authority.ts`, `wave-review-issuance.ts`, `handlers/helpers/programs/wave-review-requests.ts`, `handlers/helpers/programs/wave-gate.ts`. Docs: ADR-0089, ADR-0084 status note, ADR index, `docs/contexts/review/CONTEXT.md` ("Carried Review Evidence").

## Tests (red first)
- Replacement: T1 fully accepted + T2 with two accepted slots and one exhausted → lineage recorded, T1 untouched, T2's run kept; a v2 predecessor or roster change falls back to a full reset.
- Plan: property that issued + carried subjects equal the full roster; drift in generation, head, scope or protocol means issue.
- Issuance: rebind produces `carried_from` slots; exact replay is idempotent; empty plan leaves `batchEpoch` and slot ids byte-identical.
- Findings and wire: carried slot with evidence round-trips; without evidence, or naming its own run, refused; carried findings keep their origin packet.
- Integration: "restart reissues only the exhausted slots" issues 2 requests (spec-check + one slot) and completes after one capture; the all-exhausted test stays; abandoning after rebind folds carried evidence; completion refuses a forged acceptance outside the lineage.
