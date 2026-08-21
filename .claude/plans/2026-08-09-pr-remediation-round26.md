# PR Remediation — Standalone Review Round 26

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Reviewed HEAD:** `1b7f849071b52ca3716977d221e532bd715199d3` (`main` merge base `eda64237336193dac66843323b4c69dd4bafcd32`)
- **Exact scope:** the union of unstaged, staged, untracked, and `main...HEAD` changed paths at review time. The worktree and index were clean with no untracked files, so this is exactly the immutable 240-path `result.json.scope` list.
- **Diff:** 240 files changed; 42,591 additions, 2,934 deletions; 151 TypeScript, 78 Markdown, 5 shell, 4 JSON, and 2 extensionless paths.
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.rekaIy7Cie`
- **Adjudication:** 3 criticals survived the reproduction/intent/security panel; 0 criticals were refuted. Thirteen advisory records are accepted as ten concrete fixes; three comment-marker records duplicate their location-bearing counterparts and are remediated by the same edits. Two test advisories are deferred because both focused suites pass reliably in the reviewed checkout.

## Surviving critical fixes

### 1. Bind historical recovery to an engine-issued Review Packet registry

- **Source:** `code-reviewer-1`; `code-reviewer`; `engine/src/handlers/helpers/reconcile-implementation-proof.ts:121`
- **Claim:** `reconcile-implementation-proof` accepts self-authenticating, operator-authored Review Packets as task write-attribution evidence.
- **Fix:** Add a parsed, immutable per-task issued-packet registration containing task id, canonical packet path, packet id, base/head SHA, and exact packet scope. Atomically append it when `review-packet create` writes and binds a packet. During recovery, require an exact registration match before accepting any packet attribution; reject legacy/unregistered or mismatched packets. Preserve current cumulative-byte semantics only after provenance is established.
- **Regression:** Extend the real packet CLI test to assert registration, extend task-graph boundary tests for malformed registrations, and prove recovery rejects an otherwise internally valid forged/unregistered packet while accepting an exactly registered packet.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/helpers/quality-programs.test.ts tests/handlers/helpers/reconcile-implementation-proof.test.ts tests/state-manager.test.ts tests/handlers/validate-task-graph.test.ts`

### 2. Fail implementation spawn closed when repository evidence is unavailable

- **Source:** `silent-failure-hunter-1`; `silent-failure-hunter`; `engine/src/core/validate-task-execution.ts:218`
- **Claim:** Implementation spawn validation allows tasks to run when Git/repository state cannot be proven, so `executing_tasks` and artifact baselines are silently skipped.
- **Fix:** Introduce a typed repository-context result that captures an exact root and HEAD or a contextual infrastructure error. Once an active graph and valid implementation task binding exist, block unless that context is proven. Move the state/filesystem/Git orchestration out of the functional-core task-execution module into a shared imperative-shell module; keep parsing, ownership, gate decisions, and baseline state transforms pure.
- **Regression:** Cover a non-repository and unborn repository with active task graphs and require an actionable block; retain lazy `LOOM_STATE_PATH`, happy-path registration, and retry-baseline behavior.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/pi-extension-review-events.test.ts tests/utils/git.test.ts`

### 3. Enforce panel-compatible Finding identity at the state boundary

- **Source:** `type-design-analyzer-1`; `type-design-analyzer`; `engine/src/core/findings.ts:346`
- **Claim:** Stored `Finding.id` values with colon or whitespace pass the load boundary but produce `WaveFindingId`s that `parseFindingBriefJson` rejects, making affected critical findings unadjudicable.
- **Fix:** Add one Finding-id parser/smart constructor for the no-colon/no-whitespace identity grammar and use it both when minting identities and when parsing stored findings. Reject incompatible persisted ids before they can enter `TaskGraph`; retain the existing derived `${agent}-${ordinal}` spelling.
- **Regression:** Add stored-finding and task-graph tests for colon/whitespace rejection plus a valid derived-id round trip into a panel brief.
- **Validation:** `cd engine && npm run test:unit -- tests/core/findings.test.ts tests/core/review-panel.test.ts tests/state-manager.test.ts tests/handlers/validate-task-graph.test.ts`

## Accepted advisories

### 4. Support staged deletions in Review Packet creation

- **Source:** `code-reviewer-2`; `code-reviewer`; `engine/src/handlers/helpers/review-packet.ts:96`
- **Claim:** `review-packet create` rejects staged deletions because it checks current index tracking rather than baseline tracking.
- **Fix:** Determine historical presence from the packet base commit. Permit an absent current path when it existed at `baseSha`, emit the baseline-to-deletion binary diff, and retain `postimage: null`; continue rejecting paths absent from both baseline and worktree.
- **Regression:** Add a real CLI staged-deletion packet test.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/helpers/quality-programs.test.ts tests/core/review-packet.test.ts`

### 5. Make Pi transcript adaptation reject malformed tool evidence

- **Source:** `silent-failure-hunter-2`; `silent-failure-hunter`; `pi/transcript-adapter.ts:40`
- **Claim:** Pi transcript adaptation silently drops or fabricates tool-call identifiers for malformed tool evidence instead of surfacing a transcript schema error.
- **Fix:** Parse tool-call/result evidence into a discriminated result. Require content arrays, non-empty tool call/result ids, tool names, and Bash command strings where needed; never synthesize empty identifiers. At the Pi completion shell, surface the exact schema error, clear execution ownership, leave proof pending, and persist an actionable failure reason rather than treating malformed evidence as an empty transcript.
- **Regression:** Cover missing call id, result id, tool name, Bash command, and malformed content while preserving valid anti-spoofing pairing.
- **Validation:** `cd engine && npm run test:unit -- tests/pi-test-evidence.test.ts tests/pi-extension-review-events.test.ts`

### 6. Distinguish absent Pi caches from unreadable caches

- **Source:** `silent-failure-hunter-3`; `silent-failure-hunter`; `pi/resources.ts:148`
- **Claim:** Pi resource cache readiness swallows all filesystem errors as `not ready`, hiding why a cache is rebuilt or quarantined.
- **Fix:** Return a typed readiness result. Treat only `ENOENT` and structural/integrity mismatch as not-ready; surface `EACCES`, `EIO`, `ENOTDIR`, and other infrastructure failures with the cache path before any quarantine/rebuild.
- **Regression:** Cover a missing digest root as not-ready and a deterministic `ENOTDIR` lookup as an explicit readiness error.
- **Validation:** `cd engine && npm run test:unit -- tests/pi-resources.test.ts`

### 7. Distinguish missing calibration revisions from Git infrastructure failure

- **Source:** `silent-failure-hunter-4`; `silent-failure-hunter`; `engine/src/handlers/helpers/model-calibration.ts:38`
- **Claim:** Calibration validation classifies every `git cat-file` failure as a missing revision.
- **Fix:** Parse Git object-probe failures into missing-object versus infrastructure-error outcomes using status/stderr. Aggregate genuine missing revisions, but return the contextual Git error immediately for missing Git, non-repositories, permission failures, or corruption.
- **Regression:** Cover present, missing-object, and infrastructure-error classifications.
- **Validation:** `cd engine && npm run test:unit -- tests/scripts/run-model-calibration.test.ts tests/core/model-calibration.test.ts`

### 8. Remove stale source-line anchors from architecture-panel tests

- **Sources:** `comment-analyzer-1` and duplicate marker record `comment-analyzer-4`; `comment-analyzer`; `engine/tests/panel-config.test.ts:80`
- **Claim:** Stale source-line anchors will rot and should be replaced with stable behavior references.
- **Fix:** Describe the `PHASE_AGENT_MAP` lookup invariant without pinning implementation line numbers.
- **Validation:** `cd engine && npm run test:unit -- tests/panel-config.test.ts`

### 9. Remove the stale advance-phase source-line anchor

- **Sources:** `comment-analyzer-2` and duplicate marker record `comment-analyzer-5`; `comment-analyzer`; `engine/tests/handlers/subagent-stop/advance-phase.test.ts:354`
- **Claim:** The comment hardcodes an outdated source line.
- **Fix:** Keep the behavior explanation and remove the numeric source anchor.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/subagent-stop/advance-phase.test.ts`

### 10. Use current advisory terminology in the reviewer contract

- **Sources:** `comment-analyzer-3` and duplicate marker record `comment-analyzer-6`; `comment-analyzer`; `commands/review-pr.md:174`
- **Claim:** The Machine Summary rubric mixes legacy `important + suggestion` wording with the current advisory contract.
- **Fix:** Define `ADVISORY_COUNT` directly as the number of advisory findings and keep the itemized output contract unchanged.
- **Validation:** `cd engine && npm run test:unit -- tests/review-agent-contract.test.ts tests/runbook-contract.test.ts`

### 11. Isolate GitHub issue I/O behind a typed port

- **Source:** `architecture-tech-lead-1`; `architecture-tech-lead`; `engine/src/handlers/helpers/complete-wave-gate.ts:397`
- **Claim:** GitHub side effects are embedded as private `execSync` string commands instead of a typed port.
- **Fix:** Add a narrow synchronous GitHub issue port for body read/edit/comment, implement it with `execFileSync` argv arrays, and inject it into exported shell functions so tests use a plain fake. Preserve non-blocking notification and durable-fallback behavior.
- **Regression:** Unit-test checkbox editing, summary posting, and fallback behavior through an in-memory fake; assert repository names are passed as one argv value rather than shell text.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/complete-wave-gate.test.ts`

### 12. Move task-execution I/O out of the functional core

- **Source:** `architecture-tech-lead-2`; `architecture-tech-lead`; `engine/src/core/validate-task-execution.ts:7`
- **Claim:** Task execution validation keeps filesystem, Git, `StateManager`, and baseline-capture I/O inside the core module.
- **Fix:** Implemented with critical fix 2: retain only pure classification/decision/ownership/baseline transforms in core and move orchestration to the shared handler shell used by Claude Code and Pi.
- **Validation:** `cd engine && npm run typecheck && npm run test:unit -- tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/pi-extension-review-events.test.ts`

### 13. Freeze exported agent-policy sets

- **Source:** `architecture-tech-lead-3`; `architecture-tech-lead`; `engine/src/config.ts:248`
- **Claim:** Exported mutable Sets can invalidate policy assumptions after module-load checks.
- **Fix:** Construct `IMPL_AGENTS`, `KNOWN_AGENTS`, `UTILITY_AGENTS`, `REVIEW_SUB_AGENTS`, `REVIEW_AGENTS`, and `EXECUTE_AGENTS` with the existing runtime `frozenSet` helper and expose them as `ReadonlySet`s.
- **Regression:** Extend config tests to require ordinary `add`, `delete`, and `clear` mutation attempts to throw without changing membership.
- **Validation:** `cd engine && npm run test:unit -- tests/panel-config.test.ts tests/review-panel-config.test.ts`

## Deferred advisories

### `pr-test-analyzer-1` — no-session reviewer-ingestion test

Not accepted. `tests/handlers/subagent-stop/store-reviewer-findings.test.ts` passes all 18 cases in the reviewed checkout, including “says so when no task graph exists for the session.” The claimed stale passthrough assertion is not present at the cited behavior boundary.

### `pr-test-analyzer-2` — standalone review default timeout

Not accepted. `tests/handlers/helpers/standalone-review.test.ts` passes all 21 cases in 4.45 seconds total; the cited end-to-end case takes about 720 ms in isolation. The reviewer’s one full-suite timeout passed on rerun and does not establish a deterministic coverage defect.

## Refuted Findings (not fixing)

None. `result.json.refuted_critical_findings` is empty. The intent lens cast one refutation vote on `code-reviewer-1`, reasoning that historical recovery is a documented sanctioned path, but reproduction and security upheld the missing provenance boundary; the finding survived the 2-of-3 threshold and remains mandatory.

## Full validation

1. `cd engine && npm run typecheck`
2. `cd engine && npm test`
3. `git diff --check`
4. Verify the staged path set exactly matches the audited remediation allowlist plus this plan.
