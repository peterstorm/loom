# PR #66 delta review remediation (2026-10-07)

- **Branch:** `feat/grammar-constrained-decoding`
- **Reviewed scope:** the deepen-pass delta `0ef5f5c1..6d25b0a5`, every changed hunk. It was partitioned into 16 registered
  standalone reviews (`raf-pr66-delta-d01` … `raf-pr66-delta-d16`). Each review carried the engine-enforced read obligation
  (ADR-0022, Reviewer Protocol v4).
- **Review roster:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, architecture-tech-lead
  (deepen) and code-simplifier (distill). comment-analyzer joined where the slice touched comments or docs.
- **Model:** sonnet.
- **Read coverage:** every admitted reviewer read every frozen diff page. Two reviewers were refused for unread pages and
  passed on their bounded retry: d10 code-simplifier and d15 architecture-tech-lead.

## Review result

| Partition | Surviving criticals | Refuted criticals | Advisories |
|---|---|---|---|
| d01–d16 | 0 | 0 | 105 |

There are no surviving criticals, so there is no Declared Repair Group and no Historical RED, and
`defectFamily` is `{ "kind": "not-required" }`.

## Advisory dispositions — published (P5, DECLARED)

All 105 advisories are **accepted**. Each slice's complete ordered inventory was published through
`start standalone-disposition` as an initial revision, in policy runs `raf-pr66-delta-dNN-policy` (d01–d16). Each was confirmed
`standalone-disposition-published`. Two decisions carry specific reasons:

- **d11/architecture-tech-lead-4: accepted in part.** The claim that the spawn-task render needs only `runDirectory` and
  `readProgramRegistration` is false: `spawn-task.ts` also reads the successor context, context, published requests,
  protocol resolution, frozen diff and panel view. The `src` seam is kept. The test defect is fixed: real run directories
  in fixed durable states replace the hand-cast partial `RunDirHandle` fakes.
- **d15/architecture-tech-lead-2: accepted.** The shallow `pi/agent-directory.ts` is deleted. Its rule is now one pure core
  resolver, `engine/src/core/pi-agent-directory.ts`, shared by the extension, model-routing-context and validate-agent-model.
  This also removes the HOME-unset divergence between the three former copies.

## Implementation (eight isolated workstreams, merged)

| WS | Commit | Area |
|---|---|---|
| W1 | 4807160a | Calibration pilot. Pure `pilot-binding.ts`; checked case inputs (`caseInputOf`, branded key); lazy corpus load, so preflight-refused and `--preflight-only` windows retain their record; suites for `pilot-quality.ts` and `pilot-window.ts`. |
| W2 | 7e08304c | Engine core. `ArtifactBaselineScheme` is an unforgeable class brand; `issueEmissionBinding` narrows kind and version itself, which also fixes a `__proto__`/`constructor` descriptor crash; new `malformed-spawn-input` PolicyError kind; `isIssuableProfile` takes a parsed program; the CONTEXT.md Payload Producer entry is added. |
| W3 | ac969c85 | New pure `persistent-panel-program.ts` kernel, tested with a third program; core `nextPanelProgramAction` replay; one `settleAndRecordPanelAttempt`; the predecessor port returns bytes plus a section reader, and the core derives the record from verified bytes. |
| W4 | a6b28873 | One hardened Git execution policy for every `gitOutput` consumer, including ls-files leaf listing; a typed spec-check transcript read (missing, unreadable, corrupt-final-turn, delivered) and a shared bounded Claude transcript reader; a branded `WaveResumeContext`; an explicit `ReadCoveragePlan` ADT. |
| W5 | 0cdc0dbd | One `RegistryCell` discriminated union derived from `EMISSION_TOOL_SPECS`; one parse-result unwrap; per-suite panel publication stores; the catalog route is pinned by a vitest setup file instead of an import side effect. |
| W6 | 6dd821c1 | A shared `runLauncherBarrier` and `withBarrierResources`; the shipped `verifyReadiness` now runs on a real child through `rpcReadinessClient`; a named `registerLoomEmissionReadiness` seam; ADR-0020 is repointed at the split startup suites. |
| W7 | 05c3fcce | A single owner for the readiness protocol (`pi/emission-readiness-protocol.ts`); a branded `ReservedSlot`; a direct Trusted Review Witness suite; invalid-registration diagnostics are surfaced. |
| W8 | f90c3b28 | The roster is claimed before `markActive`; witness binding is a ledger claim; the SpawnClaims ledger is total; settlement releases through the admission-rollback ledger; the rpc-child bus has a sequence cursor. |

Integration fixes made after merging:

- The two parallel witness suites are kept as separate files: `trusted-review-witness.test.ts` (W7) and
  `trusted-review-witness-ledger.test.ts` (W8).
- The W5/W6 fixture conflicts are resolved (commit 97286beb).
- The program vocabulary moves into the import-free leaf `core/orchestration-contract/programs.ts`. This breaks the
  `model-profiles` ↔ `artifacts` cycle introduced by W2's signature.
- `pi-agent-directory.ts` receives its reviewed per-module `node:path`/`node:url` grant.

## Not in scope, reported

- **W4 observation (unreviewed, not part of this delta's findings):**
  - `utils/repository-change-baseline.ts` still runs `git diff --name-only` in the real repository.
  - It now uses the hardened environment, but repository-local clean filters can still run during the index refresh.
  - The real fix moves those diffs into the shadow directory.
- **W8:** `session-shutdown.ts` keeps its own cross-tool-call release loop. Neither advisory named it.
- **Test timeouts:** the machine-purity parser-to-SAX grant `it.each` (30 s) and the cold extension-factory imports in
  `agent-directory.test.ts` (30 s). Both are load-induced timeouts at the 5 s default and both were also observed on the
  untouched baseline.

## Validation

- `npm run verify` from the repository root (typecheck plus the full unit and smoke suites).
- Registered remediation: `start remediation` from a delta slice whose frozen head is `6d25b0a5`. Every changed path outside
  that slice's frozen scope is passed as a `supportPath`, with `defectFamily: {"kind":"not-required"}`.
