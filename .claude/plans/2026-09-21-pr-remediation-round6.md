# PR Remediation Plan — Round 6 (review-and-fix, 2026-09-21)

**Branch:** `fix/abandoned-gate-terminal-outcome` (reviewed HEAD: `7bd9a03b` → current HEAD `6bf9cc08`)
**Scope reviewed:** `all` — the changed-path union frozen by the review run (100 paths: engine production + tests + pi extension + plans/docs/hooks/lint-rules/references/scripts/skills/machines)

## Review Run

`.claude/reviews/review-and-fix-runs/review-fix-20260921T054240Z-7bd9a03b` — **done**, canonical result published.
Result digest `fed18591bc0bfa0a58c2547f10801fa1f5de7d0556033f6539bbc13895446875` (68,204 bytes).
7/7 slots captured on attempt 1, 0 rejected. Runtime handshake re-verified after a user `/reload`
(revision skew from the round-5 checkout edits; SKEW refused the first start, reload → HANDSHAKE_OK, no
run directory was created by the refused attempt).

**Emitted/admitted: 0 critical; 18 advisory. After refutation: 0 surviving critical; 0 refuted critical; 18 advisory.**
No refutation panel was triggered (non-empty critical set required).

## Policy publication

Run Directory `.claude/reviews/review-and-fix-runs/policy-20260921T060936Z-7bd9a03b` — **done** (standalone-disposition
published). Disposition record digest (authoritative) `15ddd29c7a5fd3cd21f702c46f24076c5b4e61d7cc5ca476ddcf6f11c803a25a`.
Source locator/runId/resultDigest copied unchanged from `inspect --lineage`. **14 accepted, 4 deferred, 0 dismissed**,
all 18 origins in exact issued order.

## Surviving criticals (0)

None. `defectFamily: {"kind":"not-required"}` at remediation start; no check subprocess, no historical red.

## Deferred (4) — evidence-based reasons published in the record

| ID | Reason |
| --- | --- |
| `code-reviewer-1` | Third polarity refinement of the same termination arm within one day; current refusal is fail-closed with the exotic precondition documented; leader-correlation changes the round-5 contract the freshly rewritten frozen kill-mock test pins — dedicated operator-authorized design pass. |
| `architecture-tech-lead-2` | Interface redesign across ~105 importing files (Finding/ReviewRun vocabulary out of the types.ts catch-all into core/findings.ts with compatibility re-exports); zero behavioral defect; dedicated locality pass. |
| `architecture-tech-lead-3` | Testability seam redesign of the wait loops (injected probes + clock) reshapes the runner interface; policy already pinned by green spy-based tests; reviewer itself classifies it deferrable. |
| `code-simplifier-6` | Seam relocation of the bounded-cause capture into the orchestration-contract kernel is a module-boundary change, out of distill scope; today's two copies are deliberate, documented inlining. |

## Accepted (14) — implemented this round

| ID | Fix |
| --- | --- |
| `silent-failure-hunter-1` | git.ts new-test/assertion projection surfaces unattributable (invalid-patch-path) file counts so the evidence reason distinguishes "no test declarations" from "test evidence could not be projected". |
| `silent-failure-hunter-2` | context-packet-projection outer catch carries `boundedPacketCause` + names the failing operation (index JSON parse / base64 / UTF-8 decode) and the selection kind. |
| `pr-test-analyzer-1` | git-remediation-ordering.test.ts pins the HEAD^{tree} emptiness guard and the empty real-index path guard via scripted spawn. |
| `pr-test-analyzer-2` | completion-check-runner.integration.test.ts pins both post-SIGKILL refusal arms (EPERM after SIGKILL; still-exists after SIGKILL) with a two-stage kill mock. |
| `pr-test-analyzer-3` | Consumer-level pin of `probeGitWithEmptyRetry` (utils/git.ts): scripted execFileSync empty→root recovery and confirmed-empty throw. |
| `pr-test-analyzer-4` | standalone-successor-native.integration.test.ts pins the minted-once wire: registered program equals `JSON.parse(prepared.registrationWire)`. |
| `type-design-analyzer-1` | `readableSpecArtifact` returns a dedicated two-arm result union (`ready`/`not-ready`); call sites narrow on the discriminant. |
| `type-design-analyzer-2` | `parseContextProjectionArguments` adopts the shared value-is-a-flag guard (`--`-prefixed values are absent) with its own refusal at the argument boundary. |
| `architecture-tech-lead-1` | One `specCheckDocuments` parser owned by core/wave-review-authority.ts; state-manager load guard delegates with label-decorated exact refusal prose (boundedByteIterable precedent). |
| `code-simplifier-1` | `runRemediationCheck` single envelope construction; report discriminated by the CommandExecution ADT. |
| `code-simplifier-2` | `structurallyEqual` materializes only tagged byte sequences and reuses the Array arm; the flag parameter and duplicate comparison arm are deleted. |
| `code-simplifier-3` | `observeClosedProcessGroup` drops the never-supplied `group` parameter; the probe call moves into the body. |
| `code-simplifier-4` | `byteGrammarRefusal` becomes an exhaustive switch over `ByteGrammarViolation`. |
| `code-simplifier-5` | `waitForProcessGroupGone` returns `latest` (the rebuild vestige is deleted). |

## Support paths (declared at remediation start)

Computed against the review's authorized scope (100 paths): every in-scope edited file is already authorized
(9 source files + 2 in-scope test files verified with `inspect --lineage`). Files the accepted fixes touch that
are OUTSIDE the frozen scope:

- `.claude/plans/2026-09-21-pr-remediation-round6.md` (this plan)
- `engine/src/core/wave-review-authority.ts` (atl-1 shared-parser home)
- `engine/src/handlers/helpers/task-local-completion.ts` (sfh-1 evidence-reason consumer)
- `engine/tests/utils/git.test.ts` (sfh-1 unattributable-path pins)
- `engine/tests/handlers/helpers/programs/standalone-successor-native.integration.test.ts` (pta-4 wire-seam pin)
- `engine/tests/utils/git-empty-retry.test.ts` (new file, pta-3 consumer retry pin)
- `engine/tests/orchestration/git-remediation-witness.test.ts` (new file, pta-1 guard pins)
- `engine/tests/core/wave-spec-check-documents-grammar.test.ts` (new file, atl-1 shared-grammar pins)

## Validation

Development (not P3 evidence): `npx tsc --noEmit` clean; targeted suites for every touched module green; full
detached `npm run verify` from the repo root (fresh `.loom/completion-reports/verify.junit.xml`).
Registered (P3): fresh remediation run with `sourceRun: review-fix-20260921T054240Z-7bd9a03b`,
`defectFamily: {"kind":"not-required"}`; installation receipt + `not-required` assessment expected.

## Outcome (2026-09-21)

- Full detached `npm run verify` green: **9,038 tests / 0 failures** (junit 2,225,937 B) + **23/23 smokes**.
- Remediation run `remediation-20260921T064526Z-7bd9a03b` reached `done` with
  `verified-index-installed`: effectId `effect:remediation-install:cd67ef136a1b45a78f702e11b4ef4741d049ca92941bc852144cc8ffc93c1e77`,
  indexDigest `40dec804d1d9f8b392476d96f78d2bc8e58ad9602eb6223f7a30a75fd43629a5`,
  witnessDigest `d79c6f4a5953cc7329b5b299201ad488ad1f5666276867317f1f5dda13cc2db3`.
- `defectFamilyAssessment`: `not-required` / `no-surviving-critical-findings` against source result digest
  `fed18591bc0bfa0a58c2547f10801fa1f5de7d0556033f6539bbc13895446875` (0 criticals emitted, 0 surviving, 0 refuted).
- Two runtime-version skew start refusals occurred before the registered run (checkout identity changed by this
  round's edits); both refused pre-mutation and were resolved by user `/reload` — no workaround edits were made.
- Implemented in this round: all 14 accepted advisories (cs-1…cs-5, tda-1, tda-2, sfh-1, sfh-2, pta-1…pta-4, atl-1);
  the 4 deferred advisories remain deferred with published reasons in the disposition policy
  `policy-20260921T060936Z-7bd9a03b` (disposition digest `15ddd29c7a5fd3cd21f702c46f24076c5b4e61d7cc5ca476ddcf6f11c803a25a`).

## Round 6b — the four deferred findings implemented (user override, 2026-09-21)

All four round-6 deferred advisories implemented after the operator said "do deferred":

- **code-reviewer-1** (completion-check-runner.ts): the post-SIGTERM EPERM arm of
  `terminateProcessGroup` now CORRELATES the leader probe. A provably-ours
  leader-alive group (the module's own invariant: while the leader exists the group
  is legitimately ours) escalates to SIGKILL exactly like a plainly surviving group;
  the unconditional no-signal refusal is reserved for the ambiguous leader-reaped
  state (byte-identical message, pinned). New integration test with leader-alive +
  EPERM group probe + SIGKILL escalation.
- **atl-3** (completion-check-runner.ts): the containment policy's group/leader
  probes and wall clock are defaulted narrow ports (`GroupProbe`,
  `LeaderLivenessProbe`, `WallClock`); `waitForProcessGroupGone`,
  `observeClosedProcessGroup`, and `waitForClosedProcessGroup` are exported so
  tests drive the deadline/EPERM-polarity policy with plain closures — no
  `process.kill` spy, no real waiting. New
  `tests/orchestration/completion-check-policy.test.ts` (9 tests).
- **cs-6**: ONE bounded thrown-cause capture now lives in the orchestration-contract
  kernel (`identity.ts`: `boundedThrownCause`, `MAX_THROWN_CAUSE_TEXT_LENGTH`,
  `BoundedThrownCause`), committed to the curated facade. The packet core and the
  successor registration adapter dropped their duplicated copies; the packet-local
  name survives as a re-export for the projection read-model's import edge, and the
  adapters keep byte-identical fallback prose through full subject phrases
  ("successor …"). Pinned by `tests/core/bounded-thrown-cause.test.ts`.
- **atl-2**: the Finding/ReviewRun/Refutation vocabulary moved out of the types.ts
  catch-all into the Finding concept's core modules — leaf shape volume
  `core/findings-shape.ts` (pure, imports only reviewer-contract) owned and
  re-exported by `core/findings.ts`; types.ts re-exports the whole surface so the
  import scope is unchanged. The leaf volume is what keeps
  `orchestration-contract-acyclic` green (types.ts binds its Task fields one-way to
  the leaf; core/findings keeps its type-only Task edge) — the one-file-into-
  findings variant would have joined the schema root into a cycle the pinned
  acyclic invariant forbids. `findings-shape.ts` is declared pure in
  `no-io-in-pure-modules.ts`. Pinned by `tests/core/findings-vocabulary-home.test.ts`.

Two verify-surface violations were caught and fixed during development: the
kernel facade exported the `BoundedThrownCause` type nothing outside imports
(removed from the facade line), and the new shape volume joined no cycle but
needed its pure declaration.

Validation: `engine` typecheck clean; targeted suites green (policy 9, integration
+1, bounded-cause 4, vocabulary-home 2, findings 83, acyclic/public-surface/purity
533). Full detached `npm run verify`: **9,057 tests / 0 failures + 23/23 smokes**.
