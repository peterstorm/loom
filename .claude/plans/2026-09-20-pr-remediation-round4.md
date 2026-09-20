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
