# Round 36 — Phase 3 implementation ledger

Companion to `2026-08-29-pr-remediation-round36.md`. Working notes for the
in-flight remediation of run `review-20260829T153500Z-round36-capture-authority`
(14 surviving criticals, 0 refuted, 47 advisories). Delete when Phase 4 commits.

## Landed (compiles-clean as a set, NOT yet validated)

- `engine/src/core/harness-capture.ts` — `bindCapture` takes a REQUIRED
  `alreadyCaptured: ReadonlySet<CaptureKey>`; shared `CAPTURE_REJECTION_EVENT_KIND`
  + `CaptureRejectionAuditRecord` + `captureRejectionDedupKey` +
  `isCaptureRejectionAuditRecord`; reason-union / identity / origin docs corrected.
- `engine/src/orchestration/harness-capture-runtime.ts` — `terminalizeCaptureRejection`
  is the ONE never-throwing refusal protocol for both harnesses (input union
  `{reason,message}` | `{diagnostic}`); preserves the original refusal when the
  tombstone or journal write fails; dead `readCorrelatorIdentity`,
  `readIssuedRequests`, `alreadyCapturedAttempts` deleted; env-var docs corrected.
- `engine/src/core/legacy-archive.ts` — both panel translation loops carry past a
  capture-rejection record instead of refusing the whole panel.
- `pi/extension.ts` — duplicate Pi rejection protocol deleted (delegates to
  `terminalizeCaptureRejection`); `trustedCaptureIdentity` pass-through deleted;
  `TrustedReviewCapture.contextDigest/digest` branded via `parseContextDigest` /
  `parseArtifactDigest`; absent-correlator doc and `piSpawnRosterId`
  cross-reference corrected.
- `engine/src/handlers/subagent-stop/capture-orchestration-result.ts` — transcript
  located via `resolveAgentTranscriptPath` with a distinct `transcript-locator`
  refusal; one candidate per text block (makes `ambiguous-final-payload`
  reachable); dead re-exports removed; header identity doc corrected.
- `engine/src/utils/agent-transcript-path.ts` — `resolveAgentTranscriptPath` doc
  carve-out corrected (capture goes through it now).
- `engine/src/orchestration/effect-runner.ts` — `PortThrew` carries the error NAME
  and CAUSE; "ONLY way a receipt is recorded" doc corrected against
  `standalone.ts:665`.
- `engine/src/core/review-packet.ts` — `parseJsonValue` exported (the shared
  JSON-data parser behind `canonicalJson`).
- `engine/src/orchestration/run-directory-handle.ts` — `readTranscriptBytes` and
  `readCaptureRejection` now cross `verifiedReservedRequest` like the two write
  paths (one verified-slot rule for all four slot-addressing ops);
  `registerProgram` writes canonical bytes via `canonicalJson(parseJsonValue(...))`;
  `inspectCapturedSlot` reuses `parseSemanticAttempt`; `publishTranscriptBytes`
  reuses `discardStaged`; impossible `stats === undefined` guard deleted;
  `rebasedOnRealRunsRoot` doc corrected.
- **`bun run --cwd engine typecheck` is clean for `src/` and `pi/`; the ONLY
  remaining type errors are in `engine/tests/orchestration/orchestration-acceptance.test.ts`
  (imports of the deleted `alreadyCapturedAttempts` at :17/:20, `bindCapture`
  call sites at :155/:160/:581/:593/:634/:651/:652 need the now-required
  `alreadyCaptured`, and :872 must be retargeted to
  `handle.readCapturedAttempts()`).**

## Still to do (criticals first)

0. **CURRENT STATE (latest):** typecheck clean; new tests added and green:
   `engine/tests/orchestration/capture-slot-authority.test.ts` (read-path
   authority + correlator write-once/swap/lookup-identity) and
   `engine/tests/core/legacy-panel-capture-refusal.test.ts` (panel survives a
   refusal record + lookalike still corruption). Behavioural notes learned the
   hard way: `readCaptureRejection` answers `success(null)` for a request that
   was NEVER reserved (recovery asks about attempt 2 before it is issued) and
   verifies only the SLOT-ADDRESSING fields (retry recovery legitimately carries
   a re-planned contextDigest); `readTranscriptBytes` keeps full byte-equality.
   `captureClaudeResult` locates a transcript ONLY when BOTH run-authority vars
   are set, else the runtime's own `run-authority` /
   `not-an-orchestration-run` answers. Two acceptance assertions were RETARGETED
   (not weakened): two-text-block final → `ambiguous-final-payload`; absent
   transcript → `transcript-locator`.
   REMAINING: full `vitest run` + `test:smoke`, then Phase 4 commit.
   Run suites with `env -u PI_CODING_AGENT npx vitest run` (else the runtime-skew
   guard fails ~230 tests) and note several suites are slow (~5s timeout flakes in
   `orchestration-contract-acyclic`, `quality-programs`) — pass with
   `--testTimeout=60000`.

1. ~~`run-directory-handle.ts` verified-slot reads / canonical program bytes /
   `parseSemanticAttempt` / `discardStaged` / stats guard / roots doc~~ DONE.
   Deferred advisory: export the `capture.lock*` name grammar from
   `no-follow-fs.ts` instead of restating it in `inspectCapturedSlot`
   (`code-simplifier-6`) — recorded as deferred, needs a second file pass.
2. `handlers/helpers/orchestration.ts:~1329` — delete the weaker hand-inlined
   reservation check now that the handle's reads verify.
3. Tests: correlator write-once + conflicting replay + valid-swap rejection;
   panel survives a refusal record; read-authority mirrors of the write-path
   refusals incl. traversal; locator refusal; effect-runner arm coverage;
   `alreadyCaptured` fixture updates; retarget
   `orchestration-acceptance.test.ts:872-873` off the deleted helper.
4. Validation: `bun run --cwd engine typecheck`, targeted vitest,
   `npm run test:unit`, `npm run test:smoke` (NOTE: run through the loaded
   runtime at `$LOOM_PLUGIN_ROOT`; unsetting `PI_CODING_AGENT` breaks spawn
   admission for the smoke suites).
5. Phase 4: registered remediation run, stage ONLY the audited paths + the round
   36 plan, never `.claude/reviews/review-and-fix-runs/`. Ask before pushing.

## Correction to the note above (latest)

BOTH slot-addressing reads (`readTranscriptBytes`, `readCaptureRejection`) verify
`requestId` + `slotId` + `attempt` against the stored reservation — NOT whole-
authority byte equality, because Wave Gate / Standalone restart recovery reads a
slot while holding a re-planned retry authority (new `contextDigest`) for the same
slot and attempt. The WRITE paths keep `canonicalStructuralEquals`. A forged
`slotId` still cannot read (and thereby attest) another request's bytes, which is
what `architecture-tech-lead-1` required.

Full unit run at this point: `env -u PI_CODING_AGENT npx vitest run
--testTimeout=120000` → 226 files, 5621 tests, 1 failure (the restart case above,
now fixed) → re-ran those two suites green (109 tests). NEXT: full unit re-run,
`npm run test:smoke`, then Phase 4 stage+commit.
