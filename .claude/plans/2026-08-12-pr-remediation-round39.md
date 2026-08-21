# PR Remediation Plan — 2026-08-12 (round 39)

**Branch:** feat/architecture-panel-mode-plan
**Review Run:** `run.K6Q41KxrdP` (standalone review, 332-path frozen scope, 6 reviewers)
**Adjudication:** 5 critical surviving, 1 refuted, 6 advisories
**Accepted advisories:** 4 of 6 (see disposition below)

## Surviving Critical Findings (mandatory)

### C1 — `dispatch.safeRun` swallows child HookResult errors

**File:** `engine/src/handlers/subagent-stop/dispatch.ts`
**Finding:** `silent-failure-hunter-1` — `safeRun` awaited every category handler but discarded the
returned `HookResult`; a `storeReviewerFindings`/`storeSpecCheckFindings` failure (unreadable transcript,
malformed trusted prompt, missing task id) became a successful `passthrough`, so a wave could look clean
while review evidence was lost.
**Fix:** category handlers now run through `runChild`, which propagates `error`/`block` results (and
turns thrown crashes into errors) after cleanup has already run; dispatch returns the failure instead of
`passthrough`. Cleanup keeps the swallow-and-log `safeRun` because it must never abort the pipeline.
**Tests:** new dispatch-resilience case — a review stop with an unreadable transcript returns a
`store-reviewer-findings` error from `dispatch` rather than `passthrough`.

### C2 — No coverage/recovery for a standalone crash after batch publication

**File:** `engine/src/handlers/helpers/orchestration-programs.ts` (`resumeStandaloneFacade`)
**Finding:** `pr-test-analyzer-1` — `publishInitialBatch` durably persists contexts/requests/receipt
BEFORE the awaiting-results checkpoint; a crash in that window permanently blocked resume with
"standalone review checkpoint is missing".
**Fix:** on a missing checkpoint, resume reconstructs the exact awaiting-results machine state from the
registered frozen authority when the durable batch publication receipt exists (the same pure state
`start` would have checkpointed), heals the checkpoint, and continues — captured reviewer evidence is
not discarded. No durable publication → clear failure.
**Tests:** new orchestration case — start a standalone run, delete the checkpoint, resume recovers to
`spawn-batch`, completes to `done`, and resumes idempotently.

### C3 — `parseContextPacket` brands `requestId` without parsing it

**File:** `engine/src/orchestration/context-packets.ts`
**Finding:** `type-design-analyzer-1` — `record["requestId"] as RequestId` bypassed `parseRequestId`, so
a packet with a malformed request id could cross the untrusted parse boundary as a plausible `RequestId`.
**Fix:** parse the request id through `parseRequestId` and refuse non-canonical ids with a `requestId`
diagnostic before rebuilding the packet.
**Tests:** new publication-faults case — a structurally valid packet (recomputed digest) carrying a
slash-bearing requestId is refused.

### C4 — `rosterAuthorityErrors` accepts shapeless ordinal verifier bindings

**File:** `engine/src/core/panel-program.ts`
**Finding:** `type-design-analyzer-2` — the `ordinalBinding` fallback accepted any slot/request whose
trailing segments matched the ordinal, ignoring the semantic lens/finding set; a reordered lens/finding
list could relabel previously issued verifier requests as authoritative.
**Fix:** when the semantic slot binding is derivable (verifier slots always are from lens + finding set),
require the exact semantic identity. The run-bound legacy ordinal identity is admitted ONLY for entries
whose semantic binding cannot be derived at all. Fixtures that built ordinal verifier rosters were
migrated to semantic bindings (`deriveRefutationVerifierBinding`).
**Tests:** new panel-program case — an ordinal-shaped verifier roster paired with a reordered lens list
is refused.

### C5 — Reviewer spawn contract lacks a deterministic ContextPacket resolver

**File:** `engine/src/handlers/helpers/orchestration-programs.ts` + `orchestration.ts` (spawn task text)
**Finding:** `architecture-tech-lead-1` — spawned reviewers received only `LOOM_REQUEST_ID` +
`LOOM_CONTEXT_DIGEST` markers and a prose instruction; nothing deterministically told the child where the
frozen context packet lives, so review execution depended on out-of-band inference.
**Fix:** every engine-issued spawned task now carries a `LOOM_CONTEXT_PATH` marker with the absolute path
to `contexts/<digest>.json` and instructs the child to read the packet there first (standalone reviews,
wave reviews/retries/spec retries, refutation verifiers, legacy panel tasks).
**Tests:** covered by the ordinary facade flows; no test asserts task text, so no fixture churn.

## Engine defect discovered during remediation (fixing before install)

**E1 — standalone finalize never persists the canonical T2 refutation checkpoint**

**File:** `engine/src/handlers/helpers/orchestration-programs.ts` (awaiting-refutation finalize path)
**Symptom:** a standalone run whose verifier slot is accepted on attempt 2 (attempt-1 verdict
machine-rejected, then retried) could not be used as a remediation source: `restoreRefutationCompletion`
replays only accepted-verdict + tally events from the legacy completed-state projection, sees the slot
still awaiting attempt 1, and rejects the `:2` request — "checkpoint lacks a valid durable Refutation
Panel completion receipt" blocked `helper orchestration start remediation`.
**Root cause:** the facade drove the T2 panel in memory but discarded every step's `recordedEvent`
(including `refutation-verdict-rejected`), so `completedPanelCheckpoint` was persisted as `null`.
**Fix:** collect the full immutable event prefix while submitting verdicts (including retries) and
completion, build the canonical `refutationPanelCheckpoint` (schemas v2, event prefix + terminal state),
and pass it as `completedPanelCheckpoint` (+ `publicationResolver`) when the completion receipt is built.
The legacy projection is still persisted for compatibility; restore now succeeds via the canonical replay
for attempt-2 acceptances.
**Tests:** extended the existing "publishes standalone refutation attempt 2" facade test to complete the
retry, drive to `done`, and re-resume idempotently — the re-resume replays the receipt and fails without
E1 (verified) and passes with it.

## Accepted Advisories

- **A1 (`code-reviewer-1`)** `capture-orchestration-result.ts` — `claudeFinalPayloadCandidates` still hid
  ELOOP/ENOTDIR before `readFileSync`: the `existsSync` pre-check returns false for those. Fix: drop the
  swallow for non-ENOENT by replacing the pre-check with a read whose catch distinguishes ENOENT from
  other errors (round-38 A1 completion).
- **A2 (`silent-failure-hunter-2`)** `no-follow-fs.ts` — tombstone re-read and restore-rename failures
  were reduced to `false` contention. Fix: ENOENT stays a race; other read/rename failures throw with
  lock/tombstone context (round-38 A2 completion).
- **A3 (`type-design-analyzer-3`)** `context-packets.ts` — `buildContextPacket` trusted caller-supplied
  `ByteSection` digest/length. Fix: rehash bytes and verify digest+length for every section at build time.
- **A4 (`type-design-analyzer-4`)** `wave-gate-operations.ts` — `PreparedBatch.prepared` allowed
  undeliverable `DerivedPart`s. Fix: prepared arm carries only `PreparedPartValue` (derived) parts; join
  narrows with a type guard.

## Declined Advisories (disposition: defer — documented)

- **D1 (`comment-analyzer-2`)** — packet mixes stale-memory notes with current-state claims without
  provenance. Cortex-memory hygiene, not loom code; out of scope of this remediation.
- **D2 (`architecture-tech-lead-2`)** — god facade `orchestration-programs.ts`. Large structural
  refactor, tracked in architecture plans (same disposition as round 38).

## Refuted Finding Audit (never fixed)

**`comment-analyzer-1`** — claimed the review packet gives two frozen scope sizes (232 vs 313 paths) for
the same run. All three lenses refuted: the 313-path statement explicitly names `run.luNQKIjNzt`, the
232-path statement names no run, and the pending review is `run.K6Q41KxrdP`; the packet itself builds
both authority and frozen-source sections from the same scope argument. No fix.

## Validation

- `cd engine && env -u PI_CODING_AGENT bunx tsc --noEmit`
- Full unit suite via `vitest run` (known environmental flake set verified against baseline: a handful of
  property/pi-import tests fail only under full-suite worker load and pass in isolation).

## Remediation Registration

- Review Run (immutable authority): `.claude/reviews/review-and-fix-runs/run.K6Q41KxrdP`
- Support paths: `.claude/plans/2026-08-12-pr-remediation-round39.md` (new file, outside reviewed scope)
- Note: an earlier remediation start (`run.3DNES6ON48`) installed the pre-E1 worktree; the final run
  installs the full set including E1 and this plan.
