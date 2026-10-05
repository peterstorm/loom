# PR #66 partitioned-review remediation

- **Branch:** `feat/grammar-constrained-decoding` (PR #66)
- **Reviewed snapshot:** `2cda3379`, split into ten scope partitions so that every slice's Context Packet stays under the 16 MiB bound. The 50 recorded evidence files (probe recordings, calibration windows) were excluded from review scope: they are audit evidence, not code.
- **Review result:** all ten Standalone Review runs published. 0 surviving criticals, 82 advisories.
- **Disposition:** 81 accepted, 1 dismissed (s01 code-simplifier-3), 0 deferred. Each slice's policy is published as a DECLARED initial revision, except s10. Its policy is a correction (`pr66-s10-disposition-r2`, previous `pr66-s10-disposition` `7630c6c6a5ea`), published after registered remediation refused the symlink design for the shared lint rule.
- **Defect family:** not required (no surviving criticals).

## Review runs and published policies

| Slice | Review run | Result digest | Policy run | Disposition digest |
|---|---|---|---|---|
| s01 | `pr66-s01-emission-core` | `71b08f6b8c7b` | `pr66-s01-disposition` | `38da16b69b9d` |
| s02 | `pr66-s02-pi-adapter` | `cef71e72f9ad` | `pr66-s02-disposition` | `f8d328092bfc` |
| s03 | `pr66-s03-admission-profiles` | `14d4c925a55a` | `pr66-s03-disposition` | `49ec5e540c7c` |
| s04 | `pr66-s04-review-core` | `f2b639b3fa68` | `pr66-s04-disposition` | `e0bdd51694bd` |
| s05 | `pr66-s05-standalone-programs` | `de82a07474b2` | `pr66-s05-disposition` | `1e963f4d1ff3` |
| s06 | `pr66-s06-wave-gate` | `d21b675b94b5` | `pr66-s06-disposition` | `16a8284504fa` |
| s07 | `pr66-s07-orchestration-runtime` | `515c0caf5581` | `pr66-s07-disposition` | `50a3dcdad6db` |
| s08 | `pr66-s08-artifact-workspace` | `3ff92fcb5b74` | `pr66-s08-disposition` | `743922d7beca` |
| s09 | `pr66-s09-calibration-probes` | `2e2f9bf54d54` | `pr66-s09-disposition` | `1a7501a0a274` |
| s10 | `pr66-s10-docs-agents-specs` | `fd647af2437c` | `pr66-s10-disposition-r2` | `51f813e57e87` |

## Advisory dispositions

### s01 — pr66-s01-emission-core

- **type-design-analyzer-1** (`engine/src/core/emission-tool.ts:228`) — **accepted**: IssuedEmissionBinding carries a type-only mint brand applied only by issueEmissionBinding; object literals and spreads no longer type-check, so admitBoundCall's runtime re-verification was removed (@ts-expect-error pins in emission-ingestion.test.ts).
- **type-design-analyzer-2** (`engine/src/core/harness-capture.ts:398`) — **accepted**: The binding check parses the observed request id and compares RequestId brands; malformed and foreign ids get the same wrong-request refusal on both paths. The flat (kind, version) union stays as documented at EmissionSchemaVersion.
- **architecture-tech-lead-1** (`engine/src/orchestration/harness-capture-runtime.ts:792`) — **accepted**: Real FR-009 audit gap confirmed by a failing regression test: an emission-won native successor capture wrote no capture-sources record. CapturePersistence now always runs admit → publish source → write; provenance is a closed CaptureSource union.
- **architecture-tech-lead-2** (`engine/src/core/emission-ingestion.ts:158`) — **accepted**: One admission function, admitIssuedEmissionArguments, canonicalizes then runs the registry gate for both the Pi execute shell and engine selection.
- **architecture-tech-lead-3** (`engine/src/orchestration/harness-capture-runtime.ts:239`) — **accepted**: New pure core/reviewer-emission-route owns eligibility, registration protocol projection and route derivation; the render path (spawn-task) and capture runtime both call it.
- **code-simplifier-1** (`engine/src/core/emission-ingestion.ts:328`) — **accepted**: finalPayloadOf in harness-capture.ts is the only FinalPayload constructor; emission-ingestion reuses it.
- **code-simplifier-2** (`engine/src/core/emission-ingestion.ts:336`) — **accepted**: Hand-rolled createHash calls replaced by sha256Bytes/sha256Hex from the new leaf core/digest module.
- **code-simplifier-3** (`engine/src/core/emission-ingestion.ts:340`) — **dismissed**: Unifying selectCanonicalPayload and selectVerdictSource would add a concept, not remove one: their arm vocabularies differ (payload vs rawJson, reviewer-only refused-call-no-fallback arm), and the reviewer's own note says leave as is unless a third path appears.
- **code-simplifier-4** (`engine/src/core/context-packet-projection.ts:66`) — **accepted**: An attributed helper replaces the three identical try/catch-rethrow blocks in context-packet-projection; a new test pins UTF-8 index attribution.
- **code-simplifier-5** (`engine/src/core/context-packet-projection.ts:112`) — **accepted**: Regex simplified to /^\s*[\[{]/.

### s02 — pr66-s02-pi-adapter

- **type-design-analyzer-1** (`engine/src/utils/read-settled-jsonl.ts:21`) — **accepted**: SettlePolicy is branded and built only through parseSettlePolicy (positive safe-integer attempts, non-negative safe-integer delay); fast-check and rejection tests added.
- **type-design-analyzer-2** (`pi/subagent-result.ts:458`) — **accepted**: New pi/reserved-slot.ts: ReservedSlot is a four-variant union, each carrying at most its own role authority; appliers parse the stored record once and refuse multiple or foreign authorities.
- **type-design-analyzer-3** (`pi/transcript-adapter.ts:31`) — **accepted**: PiMessage is a per-role union; toolResult always carries toolCallId/toolName/isError, and two unreachable runtime guards were deleted.
- **architecture-tech-lead-1** (`pi/implementation-brief-expansion.ts:27`) — **accepted**: expandImplementationBriefMarkers is pure and returns the rewrites; prepareSpawnBatch applies them through a rewriteTask port (Pi dispatches the exact argument object). Property tests prove the input is never mutated.
- **architecture-tech-lead-2** (`pi/extension.ts:2443`) — **accepted**: pi/extension.ts went from 4248 to 586 lines of handler registration; prepareSpawnBatch owns the observe → expand → admit order with ports, and lifecycle, stop, grant, shutdown, readiness and reservation live in their own modules.
- **architecture-tech-lead-3** (`pi/subagent-result.ts:1564`) — **accepted**: pi/subagent-result.ts split into subagent-result-batch (pure parsing), reserved-slot, subagent-settlement (pure locked reducers) and a thin shell; importers updated without re-exports.
- **code-simplifier-1** (`pi/emission-tool.ts:209`) — **accepted**: Local recordOf deleted; the shared isRecord from core/plain-record is used.
- **code-simplifier-2** (`pi/transcript-adapter.ts:43`) — **accepted**: Local isRecord in transcript-adapter deleted in favor of the shared guard.
- **code-simplifier-3** (`pi/emission-tool.ts:63`) — **accepted**: Duplicate core/emission-tool import merged.

### s03 — pr66-s03-admission-profiles

- **silent-failure-hunter-1** (`engine/src/orchestration/implementation-brief.ts:57`) — **accepted**: The brief renderer takes the full SpecIndexAvailability and the refusal appends the specific unavailability reason; it.each covers missing, unreadable, invalid-encoding and unparsed.
- **type-design-analyzer-1** (`engine/src/core/requirement-coverage.ts:439`) — **accepted**: The settled SettledFloor is branded with one constructor deriving count from criticalFindings; persisted JSON is byte-identical.
- **architecture-tech-lead-1** (`engine/src/core/spawn-admission.ts:460`) — **accepted**: DESKTOP_VLLM_ROUTE in model-profiles is the single literal owner; qualification stays separate policy per ADR-0012, and a test pins it to the recorded qualification evidence so a model switch needs requalification.
- **architecture-tech-lead-2** (`engine/src/core/spawn-admission.ts:702`) — **accepted**: One closed EmissionRouteDecision vocabulary; IssuedSpawnEmissionRoute is its non-refused subtype; both translator functions were deleted.
- **architecture-tech-lead-3** (`engine/src/core/spawn-admission.ts:507`) — **accepted**: expectedSpawnEmissionCapability is a pipeline returning a typed SpawnEmissionRefusal; messages are rendered once at the block edge and are byte-identical.
- **code-simplifier-1** (`engine/src/core/task-graph-population.ts:51`) — **accepted**: taskWaves is declared once and reused by taskWaveRosterError.

### s04 — pr66-s04-review-core

- **silent-failure-hunter-1** (`engine/src/core/review-output.ts:266`) — **accepted**: Both broad catches in review-output keep the fixed sentence and append the error class (never the payload-quoting message); tests cover TypeError, RangeError and non-Error throws.
- **type-design-analyzer-1** (`engine/src/core/panel-contract.ts:342`) — **accepted**: PanelCandidate is {lens, path}; the filename is always derived with candidateFilename.
- **architecture-tech-lead-1** (`engine/src/core/standalone-review.ts:1`) — **accepted**: panel-program.ts split into panel-program, panel-authority, persistent-panel, panel-verdict-source and exact-data. standalone-review.ts went from 4027 to about 1680 lines across ten acyclic modules, keeping only the ADR-0010 custody chain.
- **architecture-tech-lead-2** (`engine/src/handlers/helpers/panel-contract.ts:59`) — **accepted**: Panel-contract validation moved into pure core functions (admitPanelRun, admitJudgeVerdict, rankPanelVerdicts); the handler only does I/O, and aggregateVerdicts returns an error instead of throwing.
- **architecture-tech-lead-3** (`engine/src/core/panel-contract.ts:18`) — **accepted**: sha256Bytes/sha256Hex moved to a leaf core/digest module with every importer rewritten; the inline createHash calls in panel modules use it.
- **code-simplifier-1** (`engine/src/core/reviewer-protocol.ts:23`) — **accepted**: One structuralCharacters generator owns the quote/escape rules for both scanners in reviewer-protocol.
- **code-simplifier-2** (`engine/src/handlers/helpers/panel-contract.ts:132`) — **accepted**: Arguments parse once into a discriminated RunScopedRequest; the dead criterion === null branch is deleted.

### s05 — pr66-s05-standalone-programs

- **pr-test-analyzer-1** (`scripts/read-context-packet.ts:14`) — **accepted**: 23 subprocess cases in tests/scripts/read-context-packet-archive.test.ts cover the --archive path; 38 predecessor-archive codec tests with fast-check round-trip and tamper properties.
- **pr-test-analyzer-2** (`engine/src/handlers/helpers/programs/review-authority-bridge.ts:47`) — **accepted**: review-authority-bridge.test.ts covers the absent, non-object and missing-verify throws, the frozen publish/read round trip and malformed/other-session rejections.
- **type-design-analyzer-1** (`engine/src/core/standalone-successor-reviewer.ts:128`) — **accepted**: The successor binding mirror with the as ArtifactDigest cast was deleted; tests derive the binding through the real route and mint.
- **type-design-analyzer-2** (`engine/src/handlers/helpers/programs/review-authority-bridge.ts:28`) — **accepted**: The bridge read path parses every receipt into VerifiedLoomReviewAuthorityReceipt with branded ids and digests, and refuses another session's receipt.
- **architecture-tech-lead-1** (`scripts/read-context-packet.ts:29`) — **accepted**: New pure core/predecessor-archive owns the retained record as a union over its two encodings, shared by writer and reader.
- **architecture-tech-lead-2** (`engine/src/core/standalone-successor-reviewer.ts:86`) — **accepted**: standaloneSuccessorEmissionBinding (no production consumer) was deleted; the registry mint is the only binding constructor.
- **architecture-tech-lead-3** (`engine/src/handlers/helpers/programs/standalone-source.ts:58`) — **accepted**: New pure core/standalone-predecessor-chain holds every walk decision with an immutable traversal; standalone-source only does reads.
- **code-simplifier-1** (`scripts/read-context-packet.ts:39`) — **accepted**: read-context-packet uses CONTEXT_PACKET_MAX_BYTES and a single decodeUtf8; CLI output was verified byte-identical against the original on all 23 cases.
- **code-simplifier-2** (`engine/src/core/standalone-successor-reviewer.ts:122`) — **accepted**: The redundant comment block went with the deleted mirror function.

### s06 — pr66-s06-wave-gate

- **architecture-tech-lead-1** (`engine/src/core/wave-gate-machine.ts:1`) — **accepted**: wave-gate-machine.ts split into wave-gate-checks, wave-completion-suite-readiness, wave-status-facts, wave-gate-preparation, loom-status and task-implementation-dispatch; the proof-minting core stays together behind read-only predicates.
- **architecture-tech-lead-2** (`engine/src/core/wave-gate-registration.ts:41`) — **accepted**: Admission returns an install ADT with a typed predecessor; installWaveGateRegistration folds the abandoned-run supersession in, so StateManager only persists the decision.
- **architecture-tech-lead-3** (`engine/src/handlers/helpers/programs/wave-gate.ts:1`) — **accepted**: programs/helpers.ts was deleted and split into eight cohesive modules; programs/wave-gate.ts is a roughly 230-line resume loop over phase modules, with pure transitions in new core modules.
- **code-simplifier-1** (`engine/src/handlers/helpers/lint-wave-gate.ts:168`) — **accepted**: The dead filterExistingFiles and its tests were deleted after confirming it had no production caller.
- **code-simplifier-2** (`engine/src/handlers/helpers/lint-wave-gate.ts:259`) — **accepted**: lintFiles builds each result in one place; a new test covers the batch path.
- **code-simplifier-3** (`engine/src/handlers/helpers/lint-wave-gate.ts:300`) — **accepted**: A shared engineError builds the WAVE-GATE LINT ENGINE ERROR block; the redundant outer try/catch is gone, and CLI tests pin both handler messages.
- **code-simplifier-4** (`engine/src/core/wave-gate-registration.ts:61`) — **accepted**: isExactReplay and sameRoster are named predicates.

### s07 — pr66-s07-orchestration-runtime

- **code-reviewer-1** (`engine/src/orchestration/standalone-panel-context.ts:9`) — **accepted**: standalone-panel-context imports CONTEXT_PACKET_MAX_BYTES; its view budget is the separately named STANDALONE_PANEL_VIEW_MAX_BYTES.
- **pr-test-analyzer-1** (`engine/tests/orchestration/context-packet-bound.test.ts:46`) — **accepted**: context-packet-bound.test.ts covers every reader moved onto the constant, including read-context-section as a real subprocess.
- **type-design-analyzer-1** (`engine/src/orchestration/standalone-panel-context.ts:8`) — **accepted**: The private LIMIT literal was removed in favor of the shared constant.
- **type-design-analyzer-2** (`engine/src/orchestration/stored-context-packets.ts:24`) — **accepted**: StoredPacketBounds requires both bounds; CONTEXT_PACKET_BOUNDS is the standard pair, and the one unbounded path is an explicit undefined kept for pre-bound blobs.
- **architecture-tech-lead-1** (`engine/src/orchestration/standalone-panel-context.ts:9`) — **accepted**: The bound now has one owner: stored-context-packets.
- **architecture-tech-lead-2** (`engine/src/orchestration/run-directory-handle.ts:1105`) — **accepted**: The doc comment is back above publishSectionBlobs; oversizeStoredPacket finds the oversize section from the packet itself.
- **code-simplifier-1** (`engine/src/orchestration/run-directory-handle.ts:1105`) — **accepted**: The stranded comment was moved (same fix as architecture-tech-lead-2).
- **code-simplifier-2** (`engine/src/orchestration/standalone-panel-context.ts:9`) — **accepted**: The duplicate literal was removed (same fix as code-reviewer-1).
- **code-simplifier-3** (`engine/src/orchestration/run-directory-handle.ts:1205`) — **accepted**: readStandaloneSuccessorContext defaults to CONTEXT_PACKET_MAX_BYTES.

### s08 — pr66-s08-artifact-workspace

- **silent-failure-hunter-1** (`engine/src/utils/artifact-baseline.ts:361`) — **accepted**: Restore rules are pure in core/runtime-baseline-restore and return a typed refusal carrying every parse error; the shell surfaces it instead of silently returning an empty map.
- **type-design-analyzer-1** (`engine/src/core/reviewed-workspace.ts:58`) — **accepted**: Reviewed-workspace scope and artifact paths are parsed canonical ReviewPaths.
- **type-design-analyzer-2** (`engine/src/core/reviewed-workspace.ts:86`) — **accepted**: reviewedWorkspaceObservation returns DomainResult and the throwing head-sha helper was removed; the shell converts at the boundary.
- **type-design-analyzer-3** (`engine/src/core/artifact-baseline.ts:88`) — **accepted**: ArtifactBaseline<Scheme> is the parsed type, so changedDeclaredArtifacts no longer re-parses its input.
- **architecture-tech-lead-1** (`engine/src/utils/artifact-baseline.ts:195`) — **accepted**: Digest schemes are type-tagged (declared-artifact vs repository-change); cross-scheme comparison fails at compile time, and digests are unchanged.
- **architecture-tech-lead-2** (`engine/src/utils/artifact-baseline.ts:60`) — **accepted**: git-leaves.worktreeVisibleLeaves is the single enumerator for snapshots and the reviewed workspace; a test pins the digest bytes.
- **architecture-tech-lead-3** (`engine/src/utils/artifact-baseline.ts:364`) — **accepted**: utils/artifact-baseline.ts was deleted and split into declared-artifact-snapshot, repository-change-baseline, runtime-baseline-restore, attempt-baseline and git-leaves.
- **architecture-tech-lead-4** (`engine/src/core/reviewed-workspace.ts:113`) — **accepted**: The reviewed-workspace core returns Either; the frozen-source codec moved to core/wave-frozen-source.
- **code-simplifier-1** (`engine/src/utils/artifact-baseline.ts:246`) — **accepted**: baselineByPath is a Set.
- **code-simplifier-2** (`engine/src/utils/artifact-baseline.ts:86`) — **accepted**: capturedArtifactBaseline is the one dedupe-and-freeze step.
- **code-simplifier-3** (`engine/src/utils/artifact-baseline.ts:201`) — **accepted**: snapshotRepositoryArtifact uses early returns; the same bytes are hashed.
- **code-simplifier-4** (`engine/src/handlers/helpers/reviewed-workspace.ts:153`) — **accepted**: The reviewed-workspace shell uses the shared enumerator and leaf reader; error messages are unchanged.

### s09 — pr66-s09-calibration-probes

- **code-reviewer-1** (`scripts/run-model-calibration.ts:358`) — **accepted**: recordWindow writes the closed window record before deriving the blinded packet; a rubric failure is a returned Result, and a test proves the window record survives it.
- **silent-failure-hunter-1** (`probes/emission-qualification/probe.mjs:520`) — **accepted**: Malformed SSE chunks are recorded per phase and reported as errors; probe.mjs exits nonzero when report.errors is non-empty. Covered by probe-analysis.test.mjs.
- **pr-test-analyzer-1** (`calibration/grammar-constrained-decoding/pilot-dispatch.ts:442`) — **accepted**: piArmDispatch takes an injected launcher; pilot-dispatch.test.ts drives the real readiness verifier and the extraction arm through fakes.
- **pr-test-analyzer-2** (`probes/emission-qualification/probe.mjs:-`) — **accepted**: fixture-manifest.test.ts proves fixtures/manifest.json is byte-identical to the pure generator's output.
- **type-design-analyzer-1** (`calibration/grammar-constrained-decoding/pilot-core.ts:352`) — **accepted**: Observations are a per-arm discriminated union, and the emission-arm acceptance is split by source; contradictory observations are refused under test.
- **type-design-analyzer-2** (`calibration/grammar-constrained-decoding/pilot-core.ts:822`) — **accepted**: MeasuredCell is branded and built only by measureCell from the same pairs; a @ts-expect-error test pins it.
- **comment-analyzer-1** (`calibration/grammar-constrained-decoding/README.md:147`) — **accepted**: The README quotes the real npm test script; it was run and passes 92/92.
- **architecture-tech-lead-1** (`scripts/run-model-calibration.ts:430`) — **accepted**: New pure pilot-retention module over a WindowStore port; the calibration script is only the filesystem adapter.
- **architecture-tech-lead-2** (`scripts/run-model-calibration.ts:96`) — **accepted**: Corpus-calibration pure logic moved to calibration/corpus-calibration.ts with tests, including a property test.
- **code-simplifier-1** (`calibration/grammar-constrained-decoding/pilot-dispatch.ts:124`) — **accepted**: selectPayload uses an accepted() helper.
- **code-simplifier-2** (`calibration/grammar-constrained-decoding/pilot-dispatch.ts:159`) — **accepted**: The inline structural annotation was replaced by the engine's EmissionToolSpec type.
- **code-simplifier-3** (`calibration/grammar-constrained-decoding/pilot-dispatch.ts:216`) — **accepted**: The registry parser's canonical output is reused, so bytes are parsed once; a test proves both arms canonicalize identically.

### s10 — pr66-s10-docs-agents-specs

- **architecture-tech-lead-1** (`.pi/linter/rules/inv-1-no-strict-require-constraint.json:-`) — **accepted**: .claude/linter/rules holds the canonical INV-1 rule; .pi/linter/rules carries a byte-identical regular-file copy, and project-lint-rules.test.ts asserts the same rule set, regular-file byte parity, and identical loaded rules for both harnesses. A symlink was rejected because registered remediation refuses to install symlinked paths.

## Implementation

The fixes were made on eleven isolated worktree branches with disjoint file ownership, then merged onto the feature branch. Conflicts were resolved toward each split's new owner modules, with no re-export shims. One preparatory commit (`deb5514f`) moved the digest helpers into the leaf `core/digest` module, so the parallel branches shared one hashing owner.

One real defect surfaced during the work: the FR-009 accepted-source record was missing for native successor captures won by the emission tool. It is fixed, with a regression test that failed before the fix.

## Validation

- `cd engine && npm run typecheck`
- `cd engine && npx vitest run --testTimeout=30000` (373 files, 10554 passed, 1 skipped on the merged tree)
- `npm run verify` (typecheck → full Vitest → all six smokes)
