# Defect-family: orchestration stale-flow baseline — plan

## Architecture

Four engine moves — Move 1 alone leaves the no-edits stale flow wedged (the cumulative filter still drops committed work); Move 2 alone leaves the stale baseline; Move 3 closes the reopen ripple the planning-time stamps introduced; Move 4 makes reviewer payload rejection diagnostics runtime-independent.

### Move 1 — the planning-time proof boundary per Task

`engine/src/core/task-graph-population.ts`: `TaskGraphPopulationCommand` gains `proofBaselines?: ReadonlyMap<string, readonly DeclaredArtifactBaseline[]>` + `populationRevision?: string` (optional, backward compatible). `sanitizeTask` stamps `artifact_baseline` + `start_sha` from the command. Handler `engine/src/handlers/helpers/populate-task-graph.ts` captures from GIT at HEAD via `captureDeclaredArtifactBaselineAtRevision(root, headSha, file_list)` + `git.observeExactHead`, degrading to absent when Git unavailable. `registerTaskExecutionBaseline` already prefers `task.artifact_baseline`/`task.start_sha` — no dispatch change needed. The graph is created at planning BEFORE any work exists → the boundary always predates production → the wedge is unrepresentable.

### Move 2 — the settlement sees the proof boundary

`engine/src/core/implementation-application.ts`: `buildTaskLocalByteObservation`'s cumulative becomes `prior ∪ attributedAttempt ∪ proof.changed` (3 lines). Oracle's `filesModified` (`cumulativeProofArtifactChanges = proof.changed ∩ cumulative`) sees ALL task production; `collectNewTestEvidence(cumulativeFiles)` sees the proof-baseline changes' test declarations. Normal flow unchanged (`proof.changed ⊆ cumulative` — the child's parser-proven edits).

### Move 3 — the reopen guard distinguishes planning provenance from progress

`engine/src/handlers/helpers/reopen-completed-wave.ts`: `hasLaterWaveTaskProgress` must not treat population-time proof-boundary stamps as task progress. `sanitizeTask` stamps `start_sha` + `artifact_baseline` on every roster Task before any work exists, so a later-wave pending Task carrying only those stamps is still "wholly untouched": the completed-wave reopen recovery path must accept it. Dispatch-level evidence (attempt baselines, `attempt_artifact_baseline`, attempts, results, packets) still refuses. Tests: the property roster drops the start-SHA/artifact-baseline refusal triggers; a production-shaped stamped pending Task (both stamps present) is eligible for reopening.

### Move 4 — runtime-independent reviewer-payload rejection diagnostics

The engine CLI runs under bun, whose `JSON.parse` errors carry no position — a V8-message-based location is dead code under bun/JSC. `engine/src/core/reviewer-protocol.ts`: `parseBoundedReviewerJson`'s catch arm probes the payload with the `jsonc-parser` strict `visit` parse (same flags as `uniqueMembers`: `disallowComments`, disallow trailing comma, disallow empty content), reporting the FIRST error code, offset, line, column (via `printParseErrorCode`), with a real UTF-8 `byteOffset` (encoding the prefix with `TextEncoder`). Message shape: `Reviewer payload must be exactly one strict JSON object. Parse error: <code> at position <offset> (line <line>, column <column>)` (+ ` at path ...` when a path is known) `(byte <N>)`. `renderReviewerPayloadDiagnostic(failure, payloadByteLength)` appends `(payload N bytes; validate the emitted JSON with JSON.parse before finalizing)` for payloads at or below the guidance threshold, or `(payload N bytes; keep the final JSON under 8500 bytes — compress re-verification reasons…)` above it. `REVIEWER_PAYLOAD_LIMITS.retryGuidanceBytes: 8_500` in `engine/src/core/reviewer-contract.ts`. Wiring: `resolveIssuedTaskReviewFindings`'s evidence-failed arm in `engine/src/core/review-output.ts` renders the diagnostic. Tests: `engine/tests/core/reviewer-protocol.test.ts` (position, multibyte offset, rendered guidance); `engine/tests/handlers/helpers/orchestration.test.ts` pin update (`toBe` → `toContain` + "Parse error:"); `engine/tests/linter/programmatic/machine-purity.test.ts` sentinel grants `["visit","printParseErrorCode"]`.

### Spec canonicalization

`.claude/specs/defect-family/spec.md` is the canonical feature spec: FR-001/FR-002 plus acceptance scenarios AS-001–AS-004 (the wave's planned completion owners), glossary and exclusions as authored. The plan roster below claims every requirement so the wave's spec-alignment floor has no unclaimed owners.

Moves 1 and 2 implement the spec: Move 1 is FR-001 (AS-001, AS-002) and Move 2 is FR-002 (AS-003, AS-004). Moves 3 and 4 are supporting changes outside the spec. No FR, AS or OOS entry covers them, and the spec is not their source of authority. Move 3 is a consequence of FR-001: without it, the population-time stamps FR-001 requires would make the completed-wave reopen guard refuse an untouched later-wave Task. Move 4 is an unrelated reviewer-protocol diagnostic fix, delivered in the same Task. Its behavior is pinned by the tests named in Move 4, not by spec scenarios. Spec-to-plan traceability therefore holds for FR-001/FR-002 only. A spec-alignment check should not read Moves 3 and 4 as specified behavior.

## Task roster

| Task | Agent | Wave | Spec anchors | Declared artifacts |
| --- | --- | --- | --- | --- |
| T1 — deterministic orchestration stale-flow fix (Moves 1–4 + canonical spec) | code-implementer-agent | 1 | FR-001, FR-002, AS-001, AS-002, AS-003, AS-004 | `engine/src/core/task-graph-population.ts`, `engine/src/core/implementation-application.ts`, `engine/src/handlers/helpers/populate-task-graph.ts`, `engine/src/handlers/helpers/reopen-completed-wave.ts`, `engine/src/core/review-output.ts`, `engine/src/core/reviewer-contract.ts`, `engine/src/core/reviewer-protocol.ts`, `engine/tests/core/task-graph-population.test.ts`, `engine/tests/core/implementation-application.test.ts`, `engine/tests/handlers/reopen-completed-wave.test.ts`, `engine/tests/core/reviewer-protocol.test.ts`, `engine/tests/handlers/helpers/orchestration.test.ts`, `engine/tests/linter/programmatic/machine-purity.test.ts`, `.claude/specs/defect-family/spec.md`, `.claude/plans/defect-family.md` |

## Tests

- Population stamps baselines + first dispatch preserves them (`engine/tests/core/task-graph-population.test.ts`).
- Stale-flow settlement credits committed production (`engine/tests/core/implementation-application.test.ts`; fixture builders: `attemptBaseline`/`currentAttemptScope`/`proofBaseline`/`currentProofScope`/`parserModifiedPaths`/`priorAttributedPaths`/`repositoryChangedPaths`/`siblingOwnedPaths`; helpers `baseline(path, value)`, `taskFixture`, `observedBytes`).
- Reopen eligibility ignores population-time stamps and refuses true progress (`engine/tests/handlers/reopen-completed-wave.test.ts`).
- Reviewer-payload rejection diagnostics carry position/byte offset and guidance (`engine/tests/core/reviewer-protocol.test.ts`, pins in `orchestration.test.ts` and `machine-purity.test.ts`).
