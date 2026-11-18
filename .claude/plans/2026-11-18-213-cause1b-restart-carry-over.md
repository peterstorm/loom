# #213 Cause 1(b): Wave Gate restart reissues only exhausted slots

- Issue: peterstorm/loom#213, Cause 1 part (b). Worktree `../loom-restart-carry-over`, branch `fix/restart-carry-over` from origin/main (c022195a, includes Cause 1(a): ADR-0084).
- ADR: ADR-0088 (the number before it goes to open PR #217, whose own ADR collides with main's ADR-0084 and must renumber), "Wave Gate restart carries accepted review evidence and reissues only exhausted slots" — partly supersedes ADR-0084's "every request is reissued" bullet for a same-protocol predecessor.
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

## Design (recommended: slot-level carry across a new run)
- Registration lineage: `restart.carriedAuthority: [{runId, authorityDigest}]` (optional in the parser, compared by `sameRestartRegistration`); chained restarts accumulate.
- Restart keeps a carriable Task's run unfolded; others reset as today.
- Pure `waveReviewIssuancePlan` (new `engine/src/core/wave-review-carry.ts`): per reviewed Task `issue-full` | `carry-task` | `carry-slots(agents to issue)`.
- Plan frozen into `wave_review_epoch.carried` (hashed into `batchEpoch` only when non-empty, so existing epochs and slot ids stay byte-identical). Resume classification reads expected subjects from the epoch.
- Install rebinding (`engine/src/core/wave-review-issuance.ts:180-196`): carried slots become `CarriedReviewRunSlotAuthority` (A's slot + `carried_from: {run_id, authority_digest, packet_id}`), evidence unchanged; exhausted agents get fresh B slots.
- Completion admits acceptances listed as carried in the epoch (`engine/src/handlers/helpers/programs/wave-gate.ts:209`).
- Invariants: attempt 2 stays final per slot; a carried slot without evidence, or naming its own run, is refused; the reissued reviewer assesses the same prior roster; spec-check and the completion suite re-run; carried criticals still go to the Refutation Panel in B; abandoning B folds carried evidence into findings.
- Composes with Cause 5: it widens the admissibility predicate and reuses the plan and the epoch's `carried` field.

Rejected: Task-level only (does not meet "only the exhausted slots"); reissuing the slot inside the same run (needs an ordinal in slot identity, breaks exact batch classification, weakens ADR-0019, cannot compose with Cause 5).

## Files
New `engine/src/core/wave-review-carry.ts`; change `findings-shape.ts`, `findings.ts`, `state-file-wire.ts`, `wave-gate-program.ts`, `handlers/helpers/programs/registration.ts`, `wave-gate-replacement.ts`, `wave-gate-registration.ts`, `wave-review-authority.ts`, `wave-review-issuance.ts`, `handlers/helpers/programs/wave-review-requests.ts`, `handlers/helpers/programs/wave-gate.ts`. Docs: ADR-0088, ADR-0084 status note, ADR index, `docs/contexts/review/CONTEXT.md` ("Carried Review Evidence").

## Tests (red first)
- Replacement: T1 fully accepted + T2 with two accepted slots and one exhausted → lineage recorded, T1 untouched, T2's run kept; a v2 predecessor or roster change falls back to a full reset.
- Plan: property that issued + carried subjects equal the full roster; drift in generation, head, scope or protocol means issue.
- Issuance: rebind produces `carried_from` slots; exact replay is idempotent; empty plan leaves `batchEpoch` and slot ids byte-identical.
- Findings and wire: carried slot with evidence round-trips; without evidence, or naming its own run, refused; carried findings keep their origin packet.
- Integration: "restart reissues only the exhausted slots" issues 2 requests (spec-check + one slot) and completes after one capture; the all-exhausted test stays; abandoning after rebind folds carried evidence; completion refuses a forged acceptance outside the lineage.
