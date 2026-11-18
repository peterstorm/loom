# #213 Cause 5: a re-gate reviews only changed Tasks, with roles chosen by what changed

- Issue: peterstorm/loom#213, Cause 5. Worktree `../loom-rereview-scaling`, branch `fix/rereview-scaling` from origin/main deb8c369 (includes #222, ADR-0089 restart carry-over).
- Ships as two PRs: (a) carry unchanged Tasks across a fresh Wave Gate start; (b) choose reviewers by change class.
- Decisions (operator, 2026-11-18):
  - An abandoned run's unchanged Tasks carry by default; `start wave-gate --fresh-review` forces a full re-review.
  - An unchanged Task carries even when sibling Tasks in the Wave changed.
  - The role table in PR (b) is as proposed below.

## Today
- All three re-gate paths issue every reviewed Task's full roster plus spec-check (the 35):
  - abandon → reopen-task → fresh start: `supersedeAbandonedWaveGateReview` resets every Task the abandoned run accepted (`engine/src/core/wave-gate-registration.ts:301-313`), and the tombstone is dropped (`:220`);
  - completed-wave reopen keeps unchanged Tasks' acceptances (`engine/src/handlers/helpers/reopen-completed-wave.ts:144-147,213`), but completion refuses any acceptance not from this run or its restart lineage (`engine/src/core/wave-review-carry.ts:396-411`);
  - `prepareWaveGateFacadeStart` registers with no carry (`engine/src/handlers/helpers/programs/wave-gate-start.ts:77-82`), and `prepareWaveReviewBatch` issues full rosters (`engine/src/core/wave-review-authority.ts:1153-1156`).
- `carriableAcceptance` (`engine/src/core/wave-review-carry.ts:160-180`) already proves same bytes and generation. It does not cover the rest of the packet subject: description, plan context, spec anchors, proof, prior findings, owner map and contract surface (`engine/src/core/wave-review-authority.ts:1252-1292`).

## PR (a): successor carry across a fresh start
- An abandon keeps `accepted_review_authority` and records the retired run in a new protected `retired_wave_review_runs`. A completed-wave reopen already records it in `wave_reopening_history`.
- `planSuccessorCarry(predecessor, kind)` generalises `planRestartCarry`. The predecessor is the latest retired or reopened run of the Wave. Its rosters are keyed by the accepted `packet_id`. Only the `accepted-task` carry kind is used.
- The registration gains `succession?: {previousRunId, previousAuthorityDigest, kind, carry?}`. One accessor, `registeredCarry`, replaces direct `restart?.carry` reads. The install checks every lineage entry against the protected provenance.
- A subject digest closes the drift gap: `waveTaskSubjectDigest` is recorded on the Review Run and copied into the acceptance as `subject_digest`. A `subject` drift reason is added. An acceptance without the digest is reviewed once in full (`legacy-acceptance`).
- Spec-check is always issued and the completion suite always re-runs. Carried findings feed this run's Refutation Panel and advisory decision.

### PR (a) as shipped (ADR-0090)
- Subject Digest: `waveTaskSubjectDigest` (wave-review-authority.ts) covers protocol, roster, Task identity/agent/description/plan context/anchors/contributions/files/generation/proof/test result, plan file, owner-map obligations, contract surfaces and the reviewed workspace scope + head. The install records it on a current Review Run (`subject_digest`). Deviation from the sketch: finalisation does not copy it; it seals it with the Finding IDs the acceptance left, active ∪ refuted (`acceptedSubjectDigest`, new leaf core/review-subject.ts). A straight copy could never match: finalisation changes the Findings, and a Refutation Panel moves them after acceptance; active ∪ refuted is invariant under refutation and changes on any added Finding.
- `retired_wave_review_runs` (State File, parsed, dropped by re-population): appended by `supersedeAbandonedWaveGateReview` (which no longer drops acceptances) and by `reopenCompletedWave`. One list for both kinds, so "the latest retired run of the Wave" is ordered; `successionPredecessorOf` names the abandoned tombstone else the latest record.
- `planSuccessorCarry` shares `carryTermsOf` / `acceptanceCarry` / `lineageThrough` with `planRestartCarry` (one admissibility rule, `CarryKind` restart | succession). Succession carries `accepted-task` only; the predecessor's own acceptance's roster is bound by the Subject Digest instead of a journal read. New reasons: `legacy-acceptance`, `review-unsettled`, `predecessor-unreadable`; new drift field `subject`. A restart compares the Subject Digest when present and keeps admitting legacy acceptances (ADR-0089 behaviour unchanged for in-flight runs).
- Registration `succession = {previousRunId, previousAuthorityDigest, kind, carry}` only when something carries (carry is required, typed `WaveReviewCarryAudit<AcceptedTaskCarry>`); `registeredCarry` is the one accessor. Parser refuses a succession beside restart/orphanRecovery, slot carries, or a lineage not ending with the predecessor.
- Provenance: `installWaveGateRegistration(…, succession)` refuses a succession whose predecessor is not `successionPredecessorOf` or whose carried Task no longer holds the named acceptance; `waveAcceptanceProblem(…, retired)` admits a succession only while the predecessor is a protected retired run of the Wave. Lineage entries older than the predecessor come from the predecessor's immutable registration (as a restart's do); only the predecessor is checked against protected state.
- Shell: `prepareWaveGateFacadeStart(…, {freshReview})` reads the predecessor's registration from the start's runs root and the reviewed workspaces; `start wave-gate --fresh-review`; `wave-gate-start-not-carried` JSON line on stderr.
- Tests: core/wave-review-succession.test.ts; integration replay of the 6-Task advisory round (spec-check + T6's roster only, completes on carried acceptances), `--fresh-review`, epoch byte-identity.

## PR (b): reviewers chosen by change class
- `review_basis` keeps the last accepted review across invalidation (`engine/src/core/review-output.ts:1058-1068`, `engine/src/core/task-revalidation.ts:61-62`).
- Pure `classifyReviewChange(before, after)` returns `scope-changed` or `{comment, test, doc, code}`. The shell reads the basis bytes from the basis run's packet and verifies `head_sha`; missing or mismatched bytes mean the full roster.
- `selectReviewRoles`:
  - code, scope change or unknown → the full roster;
  - comment or doc only → `comment-analyzer`;
  - test only → `code-reviewer` + `pr-test-analyzer`;
  - always add the owner of every active prior Finding that is on the roster;
  - roster order is kept.
- The selection is frozen into the registration and threaded through roster derivation via an `IssuedWaveReviewRoster` subtype.
- In a narrowed run, a Finding whose owner did not vote never retires (`priorFindingRetires`, `engine/src/core/findings.ts:1549-1554`).

## Tests (red first)
- (a): a replay of the 6-Task advisory round issues spec-check + T6's roster only; completion admits a lineage acceptance and refuses a forged or off-provenance one; each drift field blocks the carry; byte-identity without a carry; property: an unchanged subject carries, and any single mutation does not.
- (b): a doc-comment change gives `comment-analyzer` only; a test-only change gives two roles; an open `code-reviewer` advisory forces `code-reviewer`; a narrowed run never retires an absent owner's Finding; a missing basis gives the full roster; property: the classifier is monotone in `code`.
