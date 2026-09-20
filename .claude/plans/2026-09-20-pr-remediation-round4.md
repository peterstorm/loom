# PR Remediation Plan — Round 4 (review-and-fix, 2026-09-20)

**Branch:** `fix/abandoned-gate-terminal-outcome` (reviewed HEAD: `f18f3264`)
**Scope reviewed:** `all` — the changed-path union frozen by the review run (91 paths: engine production + tests + pi extension + plans/docs/hooks/lint-rules/references/scripts/skills/machines)
**Review Run Directories:**
- `review-fix-20260920T180246Z-f18f3264` — **terminal-blocked** (durable evidence): comment-analyzer attempt 2 capture terminally rejected (`no-final-payload`); no verdict published. Superseded by the fresh run below (fresh run started per the recovery rule: a failed/terminal run cannot reuse evidence).
- `review-fix-20260920T181759Z-f18f3264-r2` — **done**, canonical result published. Result digest `9e40aa84cfed45d9fa846f73a960009d70eb877115f5e97fbffd6390264a7309` (76,422 bytes).
- Retry note: the first run's 5 aborted attempt-1 slots were re-driven through the engine's canonical attempt-2 retry batch (`resume`-issued), spawned 3-at-a-time per operator instruction; 6/7 slots captured there. The second-run roster was re-run fresh in waves of 3/3/1 (operator instruction).

**Canonical result:** 0 surviving criticals · 1 refuted critical · 26 advisories.

## Refuted critical (1) — report, never fix

`pr-test-analyzer-1` (engine/src/core/spec-trace-migration.ts:210 — "retirement path unobservable"): **refuted 2/3** (reproduction, intent) — its load-bearing "zero references" premise was false: `engine/tests/handlers/helpers/upgrade-spec-trace.test.ts` (a whitelisted file outside the 91-file packet projection) discriminates the retirement contract end-to-end (marker/program/authority re-proofs, exact audit fields, append-once replay, stale-scope clearing, 11 `--retire-abandoned-run` invocations). The upheld blast-radius lens itself narrowed the real residual to the terminal-abandoned tombstone-acceptance arm; a follow-up coverage pin for that arm is noted below under accepted work where practical, never as a repair of the refuted finding.

## Advisory policy publication

Run Directory `.claude/reviews/review-and-fix-runs/policy-20260920T202024Z-f18f3264` — **done**, receipt `effect:standalone-disposition:54038ee961ecdbf1e6cadf01c17bc6d8ffcf73abf91b50de69b82ad0450387cf`, disposition record digest (authoritative) `54038ee961ecdbf1e6cadf01c17bc6d8ffcf73abf91b50de69b82ad0450387cf`. Source locator/runId/resultDigest copied unchanged from `inspect --lineage`. **22 accepted, 4 deferred, 0 dismissed**, all 26 origins in exact issued order.

### Deferred (4) — evidence-based reasons published in the record

| ID | Reason |
| --- | --- |
| `code-reviewer-1` | The EPERM-group + reaped-leader classification is deliberately encoded by a frozen-scope test pin (round-3 kill-mock asserts the recycled-foreign-group outcome); reviewer verified the common sudo case classifies correctly and the exotic all-uid-changed-members case has no observed occurrence. Polarity change = design decision over the documented kernel-model premise — dedicated pass. |
| `architecture-tech-lead-1` | Required/branded boundary parameter at the phase-artifact observation seam is an interface redesign; every current caller verified correct — deepen pass (round-3 family). |
| `architecture-tech-lead-2` | Equality-core ownership of the byte-sequence type + wire-bytes start token — redesign of shared equality and the prepared-start seam; live sites digest-verify today — deepen pass. |
| `architecture-tech-lead-3` | One bounded-byte-grammar validator owned by the packet core — seam addition reconciling three divergent error shapes — deepen pass. |

### Accepted (22) — implemented this round

| ID | Fix |
| --- | --- |
| `silent-failure-hunter-1` | Bounded sanitized cause embedded in the five crash guards (helpers.ts ×2, context-packets.ts ×2, standalone-evidence.ts) using the codebase's own boundedThrownCause pattern; typed messages preserved. |
| `pr-test-analyzer-2` | Ordering/refusal test for `requireNonEmptyGitOutput` (guard consolidation claims pinned). |
| `pr-test-analyzer-3` | Anti-vacuity test for `no-cross-boundary-imports` (violating import reported; clean file clean). |
| `pr-test-analyzer-4` | Wrapper-level pin of the abandon stamp arms (no-graph/stamp-failed retry guidance) in the orchestration suite. |
| `type-design-analyzer-1` | `CommandExecution` discriminated into observed/spawn-failed arms; report pairing compile-time; non-null assertion and defensive refusal deleted. |
| `comment-analyzer-1` | Duplicate summary JSDoc above `observeGitProbe` deleted (one fix also discharges code-simplifier-3). |
| `comment-analyzer-2` | Discriminator comment corrected to the removed symbols (`git.repositoryRootFrom`/`git.repositoryRoot` of utils/git). |
| `comment-analyzer-3` | Pre-provisioning comment scoped: only the per-file grant is inert; the core allow line is a live-but-unused import grant. |
| `code-simplifier-1` | Dead `repositoryRootFrom` deleted (zero callers verified). |
| `code-simplifier-2` | Four non-At diff wrappers delegate to their At twins (signatures/messages preserved). |
| `code-simplifier-3` | (see comment-analyzer-1) |
| `code-simplifier-4` | `protectedDirs` unexported (config.ts). |
| `code-simplifier-5` | `ATTESTATION_VERIFICATION_POLICY` unexported. |
| `code-simplifier-6` | `parseAttestArgs` unexported. |
| `code-simplifier-7` | `parseRemediationArgs` unexported. |
| `code-simplifier-8` | Six helpers.ts internals unexported (gitPaths, reviewablePath, parseNumstatAdditions, trackedAdditions, untrackedAdditions, refutationRetryTask). |
| `code-simplifier-9` | Ten wave-gate.ts internals unexported. |
| `code-simplifier-10` | `MAX_CAUSE_TEXT`/`boundedCauseText` unexported. |
| `code-simplifier-11` | `ATTESTATION_DRIFT_FAILURE_KINDS` unexported. |
| `code-simplifier-12` | Three wave-gate-machine.ts internals unexported. |
| `code-simplifier-13` | `stampAbandonedWaveGateRegistration` unexported. |
| `code-simplifier-14` | Three pi/extension.ts internals unexported. |

Every unexport claim was independently re-verified (zero cross-file references) before implementation.

## Defect family

Zero surviving criticals → remediation start input declares `defectFamily: {"kind":"not-required"}`; no check subprocess, no historical-red. The registered remediation run still proves candidate authority and installs the verified index.

## Support paths (declared at start)

Computed against the r2 review's authorized scope (91 paths, `kind: "all"`):

- `.claude/plans/2026-09-20-pr-remediation-round4.md` (this plan)
- `engine/tests/handlers/helpers/orchestration-abandon-stamp.test.ts` (pta-4, new file)
- `engine/tests/linter/programmatic/no-cross-boundary-imports.test.ts` (pta-3)
- `engine/tests/orchestration/git-remediation-ordering.test.ts` (pta-2, new file)

Every other edited file is already inside the authorized scope; a first start attempt that listed scope-covered files as support paths was refused (`support path '…' is already authorized`) before any run directory was created, and the corrected input started cleanly.

## Validation

Development (not P3 evidence): `npx tsc --noEmit` clean; targeted suites for every touched module green (attest/remediate/repair/orchestration/abandon-stamp 148, git+workspace+state 218, standalone successor/disposition 40, orchestration/standalone-review/wave-gate/reviewer-protocol 173, contract surface + attestation 27, wave-gate model/policy 149, pi-extension-review-events 147); full `npm run verify` green (9011 tests / 0 failures + 23/23 smokes, fresh `.loom/completion-reports/verify.junit.xml`).

Registered (P3): remediation run `remediation-20260920T211711Z-f18f3264-r2` (source `review-fix-20260920T181759Z-f18f3264-r2`, source result digest `9e40aa84cfed45d9fa846f73a960009d70eb877115f5e97fbffd6390264a7309`) → terminal `done`, outcome `remediation-installed` with `verified-index-installed` receipt: effectId `effect:remediation-install:09f1f0376605a8dffe331c499240ede24826963290c6272d817f7878ab9f8c10`, indexDigest `42c9e6e87af8949dd76c745edcbaf9df79e78b3d8d1e6181d3ce86d4794bd02b`, witnessDigest `415b488a1cab834b89d7364287c902214c21b2d6435e8e1a8c889b87bdee1c5a`; defect-family assessment `not-required` (`no-surviving-critical-findings`, survivingCriticals `[]`, refutedCriticals `[pr-test-analyzer-1]`); zero check events (required by the not-required contract). An earlier start attempt (`remediation-20260920T211523Z-f18f3264`) was refused pre-registration for over-broad support paths and left no durable record — no abandon needed.

---

# Round 5 — the four deferred findings (user override of the published deferral, 2026-09-20)

The user authorized implementing the 4 deferred findings on HEAD `7bd9a03b`. Design pass first (each finding's
claims re-verified against the sources), then one focused edit per finding.

## `code-reviewer-1` — EPERM can never prove process-group dissolution (fail-closed)

`engine/src/orchestration/completion-check-runner.ts`: probe states are now
`alive | surviving-descendants | recycled-leader | eperm | gone` — EPERM with a reaped leader is its own state
because it cannot distinguish uid-changed survivors (setuid execution inside a project command) from a recycled
foreign numeric id. `waitForProcessGroupGone` confirms dissolution ONLY on a provable ESRCH;
`groupGoneAfterLeaderDeath` (which treated EPERM as `gone`) is deleted. Termination refuses WITHOUT escalating to
SIGKILL when the post-SIGTERM probe is EPERM ("…could not be confirmed after SIGTERM (EPERM)…") — the pre-round-5
invariant (never signal a numeric id that may name a foreign recycled group) is preserved, at the cost of a rare
extra refusal. Parent-close unconfirmed + EPERM → `termination-unconfirmed` ("…dissolution could not be confirmed
(EPERM)…"). The frozen kill-mock test is rewritten to pin the new polarity (termination refused, SIGTERM sent,
SIGKILL never signalled); a parent-close EPERM arm test added (no signals at all).

## `architecture-tech-lead-1` — phase-artifact boundary params are required

`engine/src/handlers/subagent-stop/advance-phase.ts`: `observePhaseTransition` and `countMarkers` take
`baseDir`/`phaseArtifactBaseDir` as REQUIRED parameters (no `process.cwd()` default); the cwd default survives only
on the documented compatibility shell `resolveTransition`. Production callers (pi/extension.ts) already passed the
project boundary; test call sites now pass it explicitly (advance-phase.test.ts, subagent-result.test.ts ×6,
phase-artifact-boundary.test.ts) so ambient-cwd anchoring can never return silently.

## `architecture-tech-lead-2` — sequence-aware structural equality + wire bytes minted once at the start seam

`engine/src/core/orchestration-contract/identity.ts`: `canonicalStructuralEquals` recognizes Context Packet
`ImmutableByteSequence` values via the registry-shared tag `IMMUTABLE_BYTE_SEQUENCE_TAG` (exported through the
contract facade; symbol-keyed on the frozen prototype, so JSON/Object.keys stay unchanged) and byte-compares them
position by position — both directions, and inside nested records — instead of comparing two empty key sets
vacuously true. `engine/src/handlers/helpers/programs/standalone.ts`:
`prepareStandaloneSuccessorFacadeStart` mints `registrationWire = JSON.stringify(registration)` once, byte-budgets
the wire, and the prepared start carries the frozen wire; `startPreparedStandaloneSuccessor` registers
`JSON.parse(prepared.registrationWire)`, so the untyped JSON bridge at the start seam is one deterministic string.
`engine/src/handlers/helpers/programs/standalone-source.ts` dropped the `JSON.parse(JSON.stringify(packet.value))`
projection in favor of direct `canonicalStructuralEquals(packet.value, decoded.value)` — byte-compare changes
seq-vs-seq semantics from vacuously-true to real, strictly stricter, and outcomes are unchanged wherever digests
match.

## `architecture-tech-lead-3` — one shared byte-grammar validator

`engine/src/core/context-packets.ts`: `boundedByteIterable(raw, maximum): DomainResult<Uint8Array,
ByteGrammarViolation>` owns the grammar (`iterable` / `bound{count,maximum}` / `byte`); `buildContextPacket` and
`parseSection` consume it (exact refusal prose preserved; the builder's non-iterable bytes path is now a typed
refusal instead of a TypeError); `standalone-successor-registration.ts`'s `boundedSectionBytes` delegates to it
(null-collapse + exact messages preserved). No consumer can drift from the others on what a legal section is.

## New tests

- `engine/tests/core/context-packet-byte-grammar.test.ts` — grammar acceptance/refusal matrix (arrays, iterables,
  sequences, strings, sparse holes, bound excess), packet-parser refusal prose pins, builder typed refusal,
  cross-parser agreement with the successor registration path (same hostile inputs, same verdicts).
- `canonical-structural-equals.test.ts` "Context Packet byte sequences" — sequence vs its parsed wire form (both
  orders), equal bytes equal, differing bytes separate (the vacuous-equality fix), non-array refusal, nested-record
  position comparison.
- `standalone-successor-registration.test.ts` — exact encoded frozen-source section admitted (digest/length carry
  through); every byte shape the shared grammar refuses collapses to the same registration refusal.
- `completion-check-runner.integration.test.ts` — rewritten EPERM termination test + parent-close EPERM arm.

## Validation

Development (not P3 evidence): `npx tsc --noEmit` clean; targeted suites green — context-packet grammar/equality/
projection/reviewer-packets + advance-phase + phase-artifact-boundary 142, runner integration + successor
registration + subagent-result 114, equality + successor integration/source + reviewer-protocol-standalone 32.
Full `npm run verify` from repo root: see `.loom/completion-reports/verify.junit.xml` (fresh, this round).
