# PR Remediation Plan — 2026-08-12 (round 38)

**Branch:** feat/architecture-panel-mode-plan
**Review Run:** `run.nhvvuVad1q` (standalone review, 314-path frozen scope, 6 reviewers)
**Adjudication:** 4 critical surviving, 1 refuted, 8 advisories
**Accepted advisories:** 5 of 8 (see disposition below)

## Surviving Critical Findings (mandatory)

### C1 — Wave completion crash window permanently blocks resume

**File:** `engine/src/handlers/helpers/orchestration-programs.ts` (`resumeWaveGateFacade`, ~line 1998)
**Finding:** `code-reviewer-1` — a crash after `manager.commitActiveWaveGateCompletion(...)` persists the
retired graph + `wave_gate_history` entry, but before `handle.writeCheckpoint(...)` runs, leaves the run
permanently blocked: resume finds no checkpoint, then rejects on the retired `active_wave_gate`.

**Fix:** When `resumeWaveGateFacade` sees a missing checkpoint, consult `graph.wave_gate_history` for an
entry matching `handle.runId` + `registration.input.wave` + `registration.authorityDigest` before the
active-authority check. If the completion history entry exists, the graph commit landed and the run is
terminal — heal the missing checkpoint from the entry's `completionReceipt` and return `done`. Retired
restart runs are unaffected (they always carry a `wave-gate-retired` checkpoint).

**Tests:** new `orchestration.test.ts` case that starts a Wave Gate facade, then rewrites the protected
graph to the exact post-commit state (history entry present, `active_wave_gate` retired, no checkpoint)
and asserts `resume` returns `done` and writes the terminal checkpoint; second `resume` is idempotent.

### C2 — Capture tests miss the valid-but-wrong context packet branch

**File:** `engine/tests/orchestration/orchestration-acceptance.test.ts` (capture coverage)
**Finding:** `pr-test-analyzer-1` — `captureHarnessResult` has an explicit `context-binding` defense
(`context.value.requestId !== request.requestId || context.value.role !== request.role`), but the tests
only cover a malformed (`{}`) context, so a regression dropping that comparison would pass.

**Fix:** add an acceptance test that stores a structurally VALID `ContextPacket` (built via
`buildContextPacket`, digest self-consistent) describing a different role under the reserved context
digest, and asserts capture is rejected with reason `context-binding`.

### C3 — Retry-diagnostic section accepts arbitrary bytes with the right label

**File:** `engine/src/handlers/helpers/orchestration-programs.ts` (`persistedWaveAttemptTwoCompatibilityProblem`, ~line 1292)
**Finding:** `type-design-analyzer-1` — `diagnosticContext` only checks the appended section's label
(`wave-review-attempt-1-rejection`) plus structural placement; the section bytes are never parsed, so an
attacker-controlled section reusing the label passes the persisted-attempt-2 compatibility boundary.

**Fix:** extract the fixed preamble/tail of `waveRetryDiagnosticText` into shared constants and add a pure
`parseWaveRetryDiagnosticSection(bytes)` that requires the exact canonical preamble, a non-empty parser
reason, and the exact fixed schema tail. `persistedWaveAttemptTwoCompatibilityProblem` accepts the
diagnostic-rich branch only when that parser succeeds.

**Tests:** in the existing restart-flow test, assert (a) the engine-issued attempt-2 context with the real
diagnostic section passes compatibility, and (b) a section carrying the `wave-review-attempt-1-rejection`
label with arbitrary bytes fails with the "neither a legacy retry nor one diagnostic-rich retry" message.

### C4 — context-packets header overclaims authority guarantees

**File:** `engine/src/orchestration/context-packets.ts` (module header, lines 4–12)
**Finding:** `comment-analyzer-1` — the header claims "the parent model never copies packet bytes", "the
child cannot be handed a context its request authority did not name", and "re-hashing at acceptance proves
the child read what the engine published" — guarantees this module does not enforce (packet hashing is
stored-byte integrity, not a read attestation; request binding lives in the capture boundary).

**Fix:** rewrite the header to describe only what the module actually guarantees: immutable, byte-aware,
digest-addressed packets; bytes encoded once and never normalized; content-addressed references.

## Accepted Advisories

**A1 (`silent-failure-hunter-1`)** `engine/src/handlers/subagent-stop/capture-orchestration-result.ts:50` —
`claudeFinalPayloadCandidates` swallows every transcript read failure into `[]`. Fix: `ENOENT` keeps the
absent-file meaning (`[]`); all other read errors rethrow with the transcript path context so operators see
the filesystem cause instead of a generic missing-payload rejection.

**A2 (`silent-failure-hunter-2`)** `engine/src/orchestration/no-follow-fs.ts:151` —
`recoverStaleDirectoryLock` converts lock read/rename failures into `false`, hiding corruption/attacks as
contention. Fix: `ENOENT` (expected race) keeps `false`; non-ENOENT read/tombstone-rename failures throw
with lock-name context.

**A3 (`pr-test-analyzer-2`)** `harness-capture-runtime.ts:176` — add capture acceptance coverage for a
structurally valid correlator whose stored role differs from the issued request role, asserting rejection
with reason `wrong-agent-role`.

**A4 (`comment-analyzer-3`)** `engine/src/core/review-packet.ts:173` — reword `parseIssuedReviewPacketRegistration`
doc: it parses/validates the issued-packet registration; separate verification establishes engine issuance.

**A5 (`comment-analyzer-4`)** `engine/src/core/review-packet.ts:403` — drop the redundant
"Serialize only the validated canonical domain shape." doc line.

## Declined Advisories (disposition: defer — documented, not fixed this round)

- **D1 (`type-design-analyzer-2`)** `context-packets.ts:40` — model `ContextPacket.role`/`requiredSkill` as
  parsed/typed authority projections. Broader refactor of packet identity modeling — tracked for a
  dedicated type-modeling pass.
- **D2 (`architecture-tech-lead-1`)** `engine/src/core/block-direct-edits.ts:7` — split write-authorization
  policy from filesystem side effects (FC/IS). Larger refactor, tracked.
- **D3 (`architecture-tech-lead-2`)** `engine/src/handlers/helpers/orchestration-programs.ts:1` — split the
  god facade by program boundary. Larger structural refactor, tracked in architecture plans.

## Refuted Finding Audit (never fixed)

**`comment-analyzer-2`** — `engine/src/core/review-packet.ts:76` claimed the recovery function
"separately verifies that current bytes differ from the trusted Git baseline", implying
`parseReviewPacketRecovery` itself performs the check. All three lenses (reproduction, intent, security)
refuted: the doc refers to the broader recovery path — `recoverPacketEvidence` /
`reconcile-implementation-proof.ts` computes `changedDeclaredArtifactsSinceRevision` against the trusted
baseline and rejects paths whose current bytes do not differ. No fix.

## Validation

- `cd engine && env -u PI_CODING_AGENT vitest run` (full unit suite)
- `cd engine && bunx tsc --noEmit` (typecheck)
- Targeted: `vitest run tests/orchestration/orchestration-acceptance.test.ts tests/handlers/helpers/orchestration.test.ts tests/orchestration/no-follow-fs.test.ts`

## Remediation Registration

- Review Run (immutable authority): `.claude/reviews/review-and-fix-runs/run.nhvvuVad1q`
- Support paths: `.claude/plans/2026-08-12-pr-remediation-round38.md` (new file, outside reviewed scope)
