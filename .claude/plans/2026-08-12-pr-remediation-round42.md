# PR Remediation Plan — 2026-08-12 (round 42)

**Branch:** `feat/architecture-panel-mode-plan`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.N2UqSTmsJ`
**Scope:** 318-path canonical changed-path union (96 commits vs origin/main, clean worktree)
**Adjudication:** 0 surviving criticals, 0 refuted criticals, 23 advisory entries = **15 unique advisories, ALL accepted by operator** (2026-08-12).

## Surviving critical findings

None. No refutation panel was required; the façade finalized the clean aggregate (result.json published atomically, digest `04260f7c416fa7733d8d9ec252d1aec1303309cf4e8ec0c98a990122ae356923`).

## Accepted advisories and concrete fixes

| ID | Finding | Concrete fix |
|----|---------|--------------|
| A1 | `panel-program.ts:257` bare catch discards cause | Bind `error` in the catch and append `error instanceof Error ? error.message : String(error)` to the static message |
| A2 | `orchestration-programs.ts:702` `reviewerText` launders UTF-8 decode failure | Introduce typed `decodeReviewerTranscript(bytes, role)` returning `{ok:false, message}` with the decoder's cause; Phase A / Phase C surface the decode-failure message directly as the slot problem instead of routing prose through the marker scanner |
| A3 | `standalone-review.ts:1156` second `resolveReviewFindings` with silent unreachable `continue` | Refactor `standaloneTranscriptProblems` into an admission result that RETURNS the parsed findings; `aggregateCanonicalTranscripts` parses exactly once and pushes admitted drafts; the double-parse + silent-continue branch is deleted |
| A4 | `fugue-generated-integrity` "zero coverage" (largely refuted: 255-line suite exists) | Add the ONE missing regression case: LINE-ANCHORED probe — a mid-line doc-comment occurrence of the marker prefix is not a corrupted stamp, while a line-started malformed stamp still fails closed |
| A5 | `panel-kernel.ts:454` `parseCriteriaSet` rejection branches untested | Direct unit tests: duplicate criterion, unexpected criterion, missing criterion, length mismatch, empty expected, non-distinct expected |
| A6 | `types.ts` Task base fields / `wave_gates` mutable; `parseTaskGraph` aliases raw JSON | Make Task `id/description/agent/wave/status/depends_on` `readonly`; `wave_gates: Readonly<Record<string, WaveGate>>`; `parseTaskGraph` installs fresh frozen task objects/array and a fresh frozen wave-gates record instead of aliasing parsed JSON |
| A7 | `TaskTestResult` / `ProofTestResult` duplicated unions | `export type TaskTestResult = ProofTestResult` (types.ts already imports `TaskProof` from proof-obligations; type-only, no cycle); `taskEvidenceError` delegates to `parseTaskTestResult` preserving message shape (`path` carries the task index prefix) |
| A8 | `pi/extension.ts:482` `PiSpawnReservation.items` boolean pair admits `{true,true}` | Replace `implementation`/`standalone` booleans with `kind: TaskExecutionSpawn["kind"]`; update both construction sites (tool_call guard + `recoverPiSpawnReservation`) and all consumers (1214, 1226, 1324, 1331, 1509) |
| A9 | `findings.ts:242` "The ONLY constructor of `Finding`" overstated | Reword to "The ONLY place Finding identity is MINTED" (matching the module header's precise wording) |
| A10 | `findings.ts:211–240` `nextOrdinal` JSDoc omits `resolved` param | Document the `resolved` parameter: resolved/remediated findings hold retired ordinals for the same high-water-mark reason refuted ones do |
| A11 | Two persistence generations coexist; legacy readers in active files | New `engine/src/core/legacy-archive.ts` — single documented archive module with deprecation horizon; MOVE `aggregateLegacyStandaloneReview`, `parseAdjudicatedStandaloneReview` + `HistoricalStandaloneReviewResult`, `findLegacyWaveGateCompletionReplay`, `translateLegacyPanelJournal` (+ shared private helpers) into it; source modules keep `@deprecated` re-export facades so existing import sites/tests remain valid |
| A12 | `wave-gate-machine.ts:25` imports runtime values from catch-all `types.ts` | New `engine/src/core/wave-gate-model.ts` holding `WaveGate`, `newWaveGate()`, `TaskTestResult` (as `ProofTestResult` alias), `testResultPassed()`; `types.ts` re-exports; `wave-gate-machine.ts` imports from the core module (runtime arrow leaves types.ts) |
| A13 | `orchestration-contract.ts` 4,308-line god module, 141 exports | Split into sub-domain volumes under `engine/src/core/orchestration-contract/` (identity, bytes, artifacts, roster, publication, diagnostics, actions, effects, + facade `index.ts` re-exporting the full surface). File-internal arrows must stay acyclic; property suites verify behavior preservation |
| A14 | `orchestration-programs.ts` 2,917-line facade god module | Extract per-program drivers into `engine/src/handlers/helpers/programs/` (standalone.ts, wave-gate.ts, remediation.ts) plus shared recovery/git helpers; `orchestration-programs.ts` becomes routing/re-export facade |
| A15 | Core boundary blanket `node:` allowlist | Extend `BoundaryRule` with per-file node allowlist (`nodeAllow`); remove bare `node:` from the core allowlist; enumerate every core module's exact `node:*` needs (crypto/path/fs/util) so any future I/O import in `core/` is an explicit reviewed exception |

Refuted-finding audit: none — no critical findings were emitted by any reviewer.

## Validation commands

```bash
cd /home/peterstorm/dev/claude-plugins/loom
bun test <targeted files per wave>          # per-file runs (full-suite concurrency flakes pin identical 23-failure baseline)
bun test                                    # full suite; compare failures against /tmp/baseline-failures.txt (must not add)
bun x tsc --noEmit -p engine/tsconfig.json 2>/dev/null || npx tsc --noEmit   # typecheck as performed by reviewer baseline
```

Baseline note: full-suite `bun test` currently reports 23 pre-existing failures (Pi-extension review-events tests collide under parallel load; one deterministic `phase_artifacts: %j` 5s timeout). All pass when run per-file. Remediation must not add failures beyond this baseline.

## Out of scope

- A4's "zero coverage" premise (refuted by existing 255-line suite) — only the missing line-anchor regression is added.
- Pre-existing flaky/timeout tests not named by any accepted advisory.
