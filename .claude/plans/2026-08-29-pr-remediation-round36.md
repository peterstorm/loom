# PR Remediation — Round 36 (Capture & Run-Directory Authority)

## Authority

- **Branch:** `main`
- **Reviewed HEAD:** `8211e184150f4b924af93a54c8e12a38a2e78b69` (working tree proven byte-identical to every frozen file digest)
- **Source review run:** `.claude/reviews/review-and-fix-runs/review-20260829T153500Z-round36-capture-authority`
- **Authoritative adjudication:** that run's `result.json`, digest `97c463d74a20ac7e4345ce21d8bc9980494ea98de5375413432a4ecfd681ad6d`
- **Exact frozen scope:** the 11 paths in `result.json.scope` (the round-35 capture/run-directory authority surface plus its two regression suites and the round-35 plan)
- **Adjudicated totals:** 61 findings emitted by 7 reviewers; 14 critical survived, 0 critical refuted, 47 advisories. Refutation panel ran 3 independent criteria (reproduction, intent, security); every surviving critical was upheld by a strict majority, `architecture-tech-lead-1` surviving 2/3 (intent returned `uncertain`).
- **Round-35 closure:** all eight round-35 items were verified implemented and green before this round started (typecheck clean, 5603 unit tests, full smoke suite). This round is an independent re-audit of that surface, and it found defects that round-35's fixes introduced.

## Mandatory critical remediation

### 1. One home for the capture-rejection audit protocol, and a journal the panel machine can replay

`code-reviewer-1`, `architecture-tech-lead-2`, `code-simplifier-2` (plus advisories `code-reviewer-2`, `silent-failure-hunter-3`)

- `harness-capture-runtime.ts:173-192` and `pi/extension.ts:577-598` hand-copy the same protocol — `rejectCapture` tombstone plus a `request-capture-rejected` journal record whose dedup key is `capture-rejected:sha256(requestId:attempt)` — and they already differ: the engine copy composes `${reason}: ${message}` and lets `appendEvent` **throw**; the Pi copy stores a pre-rendered diagnostic and converts the same fault into a typed string. One journal fault is therefore a crash on Claude and a diagnostic on Pi, and a drift of the key mints two journal records for one rejected attempt.
- Worse, that record is unwritable-in-practice for two of the five registered programs: `nextRegisteredPanelAction` (`orchestration.ts:849`) feeds every journal record to `translateLegacyPanelJournal`, whose `parseEvent` (`legacy-archive.ts:514`) returns `events[i].type must be spawn-outcome or engine-outcome` for a kind-tagged record. Because the event file is `O_EXCL` and immutable, one ordinary capture refusal permanently wedges every later `resume`/`submit` of an architecture or refutation panel run. This is the exact hazard `run-directory-handle.ts:126-136` names as the reason `RunAbandonment` stays out of the journal.
- **Fix:** own the vocabulary in the pure core. `core/harness-capture.ts` exports `CAPTURE_REJECTION_EVENT_KIND`, `captureRejectionDedupKey`, `captureRejectionAuditRecord`, and a strict `isCaptureRejectionAuditRecord`. `harness-capture-runtime.ts` exports one `terminalizeCaptureRejection(handle, request, diagnostic)` that writes the tombstone, appends the record, **never throws**, and returns a typed outcome naming the original refusal when either write fails. Both adapters call it; Pi's copy is deleted. `translateLegacyPanelJournal` carries a strictly-parsed audit record past the reducer instead of erroring on it — audit records are not machine transitions — while every other unknown record still fails closed.
- **Tests:** a registered architecture and a registered refutation run survive an audited capture refusal and still `resume`; the two adapters produce the same typed outcome under a journal-append fault; the tombstone and journal record are written exactly once for a repeated refusal; a genuinely unknown journal record still blocks a panel run.

### 2. Preserve the refusal cause when its persistence fails

`silent-failure-hunter-2` (+ advisory `pr-test-analyzer-9`)

- `harness-capture-runtime.ts:176` returns `rejection-persistence` with only the persistence error, and because the tombstone failed and the append is skipped, the actual refusal reason exists on no channel — the state the module's own header forbids.
- **Fix:** the returned outcome carries both causes (`capture refused (<reason>: <message>) and its rejection could not be persisted: …`). **Test:** an unwritable `transcripts/` directory drives this arm and the operator-visible diagnostic still names the original refusal.

### 3. Locate the Claude transcript the way every sibling handler does

`silent-failure-hunter-1` (+ advisories `silent-failure-hunter-4`, `silent-failure-hunter-6`, `type-design-analyzer-4`)

- `capture-orchestration-result.ts:128` reads `input.agent_transcript_path ?? ""` while `utils/agent-transcript-path.ts` documents that Claude Code **stopped sending** that field; `readFileSync("")` is ENOENT, so the run's evidence handler reports `no-final-payload: result carried no final text payload` and terminally tombstones a slot that was never filled — blaming the Agent for an absent harness field. The carve-out in `resolveAgentTranscriptPath`'s doc ("its reservation already establishes run authority") does not answer field absence.
- `assistantTextOf` returns `null` for a multi-text-block final message, so `parseFinalPayload`'s `ambiguous-final-payload` refusal is unreachable on the Claude path and an ambiguous final is misreported as no final.
- **Fix:** resolve through `resolveAgentTranscriptPath`, refuse with a distinct `transcript-locator` reason naming session and agent when nothing can be located, and emit one candidate per text block so ambiguity is reported as ambiguity. Correct the `resolveAgentTranscriptPath` doc carve-out.
- **Tests:** a SubagentStop payload with no `agent_transcript_path` captures through the derived path; a locator failure names the locator, not the Agent; a two-text-block final is refused as `ambiguous-final-payload`.

### 4. Enforce reservation equality on the transcript **read** paths too

`architecture-tech-lead-1` (+ advisory `type-design-analyzer-2`)

- `readTranscriptBytesOperation` (`run-directory-handle.ts:1345`) builds `transcripts/<slotId>/attempt-<attempt>.raw` straight from caller-supplied authority with no parse and no comparison, and `readCaptureRejectionOperation` parses without comparing to the stored reservation, while `captureTranscript` and `rejectCapture` both require `canonicalStructuralEquals`. One interface therefore offers "verify-then-act" and "trust-the-caller-and-read" over the same slot, and the branded `SlotId` advertises a guarantee the reads do not provide.
- **Fix:** one internal verified-slot resolution used by all four slot-addressing operations, and delete the weaker hand-inlined copy in `orchestration.ts:1329`.
- **Tests:** mirror of the write-path refusal for both reads, plus a traversal case proving a forged `slotId` cannot read outside the run directory.

### 5. Delete the dead, divergent correlator resolver

`code-simplifier-1` (+ advisories `code-reviewer-3`, `type-design-analyzer-7`, `comment-analyzer-7`, `code-simplifier-10`)

- `readCorrelatorIdentity` has no caller anywhere and throws where the live path returns a typed `correlator` rejection; the `readIssuedRequests`/`alreadyCapturedAttempts` re-exports in the Claude adapter have no production consumer either.
- **Fix:** delete the dead resolver and the dead re-exports, retarget the one test import, and correct the `readCorrelatorIdentity` doc claim about rejection semantics.

### 6. Prove the correlator's write-once authority

`pr-test-analyzer-1`, `pr-test-analyzer-2`

- No test records a native correlator twice, so `recordHarnessCorrelator`'s conflict refusal (`run-directory-handle.ts:1234`) and its attempt-mismatch refusal (`:1226`) — the controls that stop one agent's bytes landing in another request's slot — have zero coverage.
- The "refuses a symlinked correlator" test plants a target with no `role`, which `parseHarnessCorrelatorBinding` rejects anyway, so the test passes with `O_NOFOLLOW` removed and proves nothing about swap rejection.
- **Fix:** tests that record a binding twice (byte-identical replay accepted as idempotent, conflicting request/attempt/role refused), a swap test whose planted target is a **fully valid binding for a different reserved request**, plus the lookup-identity guard (`:1255`) and the unreadable/foreign arms of `readIssuedRequests`.

### 7. Correct every comment that contradicts the code

`comment-analyzer-1` … `comment-analyzer-5` (+ advisories `comment-analyzer-6` … `comment-analyzer-16`)

- `pi/extension.ts:455` promises an absent correlator "is ignored, not failed" while a request-bound result is terminalised and reported.
- `core/harness-capture.ts:131` claims Claude derives identity from `session_id`/`agent_id`/`agent_type` against a **pre-spawn receipt** and that `requestId` arrives as an explicit claim; the identity is actually reconstructed from the durable post-spawn binding and only `agent_id` is read.
- `capture-orchestration-result.ts:11` repeats the same false session-scoping claim.
- `run-directory-handle.ts:323` claims a symlinked runs root is "already refused by the anchored walk"; `rebasedOnRealRunsRoot` resolves it *before* the walk, so it is rewritten, not refused.
- `harness-capture-runtime.ts:33` asserts `LOOM_ORCHESTRATION_RUNS_ROOT`/`RUN_DIR_ENV` are "set by the spawn side"; no production code assigns either — Pi publishes a session run binding instead.
- Plus the eleven documentation advisories (`effect-runner` "ONLY way a receipt is recorded", "Every non-capture is audited", the "no arbitrary path API" header, the stale collision rationale, the `transcript.last` origin example, the rejection-vocabulary union claim, the `piSpawnItem` cross-reference, `leafFlags`/`dirFlags`, "the plan", and the macOS rationale in a Linux-only module).
- **Fix:** each comment restated to what the code does, naming the real producer/boundary; where the doc states an aspiration the code does not meet, the doc is corrected rather than the behaviour silently changed.

### 8. Close the remaining in-scope defect-shaped advisories

Accepted advisories whose fix is local: `registerProgram` claims canonical bytes rather than caller key-order `JSON.stringify` (`type-design-analyzer-3`); `bindCapture`'s duplicate guard becomes a required argument (`type-design-analyzer-5`); the semantic-attempt domain reuses `parseSemanticAttempt` instead of a re-typed filename pattern (`type-design-analyzer-6`); `EffectRunner` reports the port error's name and cause instead of a bare message (`silent-failure-hunter-5`); staged artifacts are parsed once and carried (`code-simplifier-4`); the staged-discard loop is reused (`code-simplifier-5`); the lock's private name grammar is exported from the primitive that owns it (`code-simplifier-6`); the ENOENT-only existence rule reuses `directoryEntryExistsNoFollow` (`code-simplifier-7`); the undecidable `tombOwner === null` disjunct is deleted (`code-simplifier-8`); the impossible `stats === undefined` guard is deleted (`code-simplifier-11`); `trustedCaptureIdentity` pass-through deleted (`code-simplifier-3`); `TrustedReviewCapture` carries the branded digest types (`type-design-analyzer-8`).

### 9. Test-coverage advisories accepted as tests

`pr-test-analyzer-3` (effect-runner slot/byte-length arms plus the reason assertion), `-4` (journal gap and duplicate-sequence), `-5` (per-field authority perturbation table over `slotId`, `attempt`, `modelProfile`, `requiredSkill`, `contextDigest`, `role`, `program`, `outputSlot`), `-6` (Pi `capture-crashed` arm), `-10` (`parseArtifactRelativePath` absolute, trailing-slash, backslash, empty-component, non-string), `-11` (duplicate destination within one intent).

## Advisory dispositions

- **Accepted (37):** `code-reviewer-2`, `code-reviewer-3`, `silent-failure-hunter-3`, `-4`, `-5`, `-6`, `pr-test-analyzer-3` … `-11`, `type-design-analyzer-2`, `-3`, `-4`, `-5`, `-6`, `-7`, `-8`, `comment-analyzer-6` … `comment-analyzer-16`, `code-simplifier-2` (as critical 1), `-3`, `-4`, `-5`, `-6`, `-7`, `-8`, `-10`, `-11`, and the coverage items in §9. Each is either subsumed by a critical fix above or a local change inside the frozen scope.
- **Deferred — `type-design-analyzer-1` (`CaptureOutcome` collapses terminal and transient refusals into one `reason: string`):** sound and material — a transient lock fault currently tombstones terminally — but the correct fix changes retry semantics for every consumer of a rejection (wave-gate and standalone both derive attempt-2 from tombstones) and needs its own adjudicated round rather than riding in as an unreviewed behaviour change.
- **Deferred — `architecture-tech-lead-3` (checkpoint slot is a stringly-typed pass-through with four owners), `-4` (`RunDirHandle` retains no descriptor), `-5` (Pi `tool_result` shell keeps a routing decision and two protected-state reductions), `-6` (`RunDirHandle` handed whole to every consumer):** four independent module deepenings. Each moves a seam or re-cuts an interface, which is out of scope for a behaviour-preserving remediation of the surviving criticals; recorded here so the next round can pick them up.
- **Dismissed — `code-simplifier-9` (`verifiedReservedRequest`'s three diagnostic parameters):** the two callers do not vary one subject word, they name two different facts — a *capture* authority and a *rejection* authority. Collapsing them would remove which operation refused from the operator-visible diagnostic.

## Refuted audit

No critical was refuted: all 14 were upheld by a strict majority across the reproduction, intent, and security criteria. `architecture-tech-lead-1` was upheld by reproduction and security with intent `uncertain`; it is fixed anyway because the enforcement asymmetry is verifiable in code.

## Validation

```bash
bun run --cwd engine typecheck
(cd engine && bunx vitest run tests/orchestration/publication-faults.test.ts tests/orchestration/orchestration-acceptance.test.ts tests/handlers/helpers/orchestration.test.ts)
bun run --cwd engine test:unit
bun run --cwd engine test:smoke
```

Plus the changed-production lint pass, `git diff --check`, and a `distill` apply-mode pass over the diff.

## Environment deviation (recorded)

The live Pi session loaded Loom from `/home/peterstorm/dev/claude-plugins/loom-benchmark-runtime-3815f65`, so the runtime-identity handshake reports `package-root-mismatch` for any CLI run from this checkout even though the two trees are byte-identical (`sha256:4d3d46e6e1dd1ac4ccdd8d6e20a4fe72b4b858c776ff33cc897e73e6845dba6b` from both roots). Every façade call in this round therefore ran through `$LOOM_PLUGIN_ROOT/engine/src/cli.ts` — the loaded runtime itself — so the handshake stayed enforced and the Pi session run binding, correlator recording, and request-bound capture all ran for real. No handshake was bypassed and `PI_CODING_AGENT` was never unset for a mutation.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-29-pr-remediation-round36.md`

## Phase 4 — validation receipt

Correction recorded by the 2026-08-31 remediation: this receipt's original
claim that `bun run --cwd engine typecheck` was clean at the reviewed HEAD was
false. The unused-code pass reported 14 dead imports across eight test files.
Those imports are now removed and the exact gate has been rerun successfully.
Fresh validation for the corrected working tree is:

- `bun run --cwd engine typecheck` — clean, including `noUnusedLocals` and
  `noUnusedParameters`.
- `env -u PI_CODING_AGENT bun run --cwd engine test:unit` — **226 files,
  5651 tests, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke` — all smoke suites
  pass.
- `git diff --check` — clean.

New tests: `engine/tests/orchestration/capture-slot-authority.test.ts`
(read-path reservation authority incl. forged-slot and traversal refusals;
correlator byte-identical replay, conflicting request/attempt/role refusals,
lookup-identity guard, and a symlink swap whose target is a FULLY VALID binding
for another reserved request) and
`engine/tests/core/legacy-panel-capture-refusal.test.ts` (both panels replay with
a refusal record in the journal; a lookalike record is still corruption; one
shared journal identity per refused attempt).

Two assertions in `orchestration-acceptance.test.ts` were retargeted, not
weakened, because the fixes changed the refusal they observe: a two-text-block
final is now `ambiguous-final-payload` (it used to be misreported as
`no-final-payload`), and an absent transcript is now `transcript-locator`
(a harness field absence, not a claim about the Agent).

Behaviour learned while landing the verified reads: both slot-addressing READS
verify `requestId` + `slotId` + `attempt` against the stored reservation rather
than whole-authority byte equality, because restart recovery reads a slot while
holding a re-planned retry authority; the WRITE paths keep full structural
equality. `readCaptureRejection` answers "no rejection" for a request that was
never reserved, since recovery asks about attempt 2 before it is issued.

Deferred (recorded, not silently dropped): `code-simplifier-6` — the
`capture.lock*` name grammar is still restated in `inspectCapturedSlot` instead
of being exported from `no-follow-fs.ts`.

Phase-4 deviation: this remediation was validated by the full unit and smoke
suites rather than by driving a registered remediation run through the façade.
