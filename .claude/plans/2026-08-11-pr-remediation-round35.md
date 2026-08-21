# PR Remediation — Round 35

## Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Review scope:** immutable 318-path scope in `.claude/reviews/review-and-fix-runs/run.9CSvc3hfpY/session.json`
- **Standalone review run:** `.claude/reviews/review-and-fix-runs/run.9CSvc3hfpY`
- **Authoritative adjudication:** `.claude/reviews/review-and-fix-runs/run.9CSvc3hfpY/result.json`
- **Adjudicated totals:** 17 critical findings reviewed; 14 survived; 3 refuted; 3 advisories.
- **Accepted advisory:** `type-design-analyzer-4` (positive Wave number boundary).
- **Deferred advisories:** `pr-test-analyzer-3` and `architecture-tech-lead-3` because their request/slot portions overlap refuted critical findings; surviving correlator and no-follow behavior is covered by the critical fixes below.

## Remediation order

### 1. Close the engine-owned orchestration façade

**Findings**

- `code-reviewer-1` — `engine/src/handlers/helpers/orchestration.ts:44` — no production entry point creates or drives a run.
- `architecture-tech-lead-2` — `engine/src/handlers/helpers/orchestration.ts:150` — resume/submit/decide do not invoke lifecycle reduction or effect reconciliation.

**Fix**

- Add a versioned, parsed run-program registration artifact and a program-kind registry for architecture, refutation, Wave Gate, standalone review, and remediation.
- Implement `orchestration start` and `orchestration remediate`; make `resume`, `submit`, and `decide` load immutable authority, strictly parse the event/checkpoint prefix, replay the registered typed reducer, apply at most one typed input, execute eligible closed `EffectIntent`s through `createEffectRunner`, persist event/checkpoint/receipt evidence, and return exactly one validated `ExternalAction`.
- Keep historical helper formats as read-only compatibility adapters; do not rewrite old runs.
- Add CLI lifecycle tests for start, interrupted resume, transcript submission, advisory decision, remediation start, idempotent replay, malformed registration, and exactly-one-action output.

**Validation**

```bash
bun run --cwd engine typecheck
(cd engine && bunx vitest run tests/handlers/helpers/orchestration.test.ts tests/orchestration/fugue-program-runtime.test.ts)
```

### 2. Publish and consume native harness correlators through anchored run authority

**Findings**

- `code-reviewer-2` — `engine/src/orchestration/harness-capture-runtime.ts:99` — production never persists required correlators.
- `architecture-tech-lead-1` — same production reachability defect.
- `silent-failure-hunter-1` — `engine/src/orchestration/harness-capture-runtime.ts:100` — unreadable/malformed correlator authority becomes silent `no-reservation`.
- `pr-test-analyzer-2` — `engine/src/orchestration/harness-capture-runtime.ts:49` — request/correlator discovery lacks no-follow swap coverage.

**Fix**

- Add a parsed `HarnessCorrelatorBinding` value and fixed `RunDirHandle` operations to record and resolve native correlators under descriptor-anchored, no-follow access.
- Make spawn publication persist the native correlator binding against the exact reserved request before a completion can be accepted; reject conflicting/replayed mappings.
- Move correlator/request/transcript discovery behind `RunDirHandle`; distinguish a genuinely absent native id (`no-reservation`) from unreadable/malformed run authority (`rejected`).
- Read issued authority once per capture and carry that immutable snapshot through binding and write.
- Add production-path Pi/Claude capture tests without hand-written `correlators.json`, plus malformed and symlink/swap rejection tests. Do not change the two refuted request-file/slot-directory policies.

**Validation**

```bash
(cd engine && bunx vitest run tests/orchestration/orchestration-acceptance.test.ts tests/orchestration/no-follow-fs.test.ts tests/orchestration/publication-faults.test.ts)
```

### 3. Enforce exact stored request authority at transcript publication

**Finding**

- `code-reviewer-3` — `engine/src/orchestration/run-directory-handle.ts:499` — capture trusts caller authority after checking only request-id existence.

**Fix**

- Parse the stored request through `parseAgentRequestAuthority` and require canonical structural equality with the supplied authority before selecting a transcript path.
- Preserve separate diagnostics for absent, unreadable/malformed, and mismatched reservation authority.
- Add tests proving request-id reuse cannot change slot, attempt, model, context, Skill, harness binding, or output slot.

**Validation**

```bash
(cd engine && bunx vitest run tests/orchestration/publication-faults.test.ts tests/orchestration/orchestration-acceptance.test.ts)
```

### 4. Anchor journal locking and strictly parse event history

**Findings**

- `code-reviewer-4` — `engine/src/orchestration/run-directory-handle.ts:345` — append lock follows a swapped `events` symlink.
- `code-reviewer-5` — `engine/src/orchestration/run-directory-handle.ts:356` — anchored `readEvents` casts schema-invalid JSON.

**Fix**

- Replace the path-string `withLock` call with an events-directory descriptor-anchored lock/claim primitive; retain the directory descriptor across sequence allocation and exclusive event publication.
- Export/reuse the strict `parseProgramEventRecord` parser.
- Verify event filename sequence/dedup against record fields, uniqueness, sorted contiguous sequence from zero, and reject gaps/duplicates/schema drift before replay.
- Add symlink-swap, malformed-event, filename mismatch, duplicate sequence, and gap tests while preserving concurrent append ordering/idempotency tests.

**Validation**

```bash
(cd engine && bunx vitest run tests/orchestration/publication-faults.test.ts tests/orchestration/fugue-program-runtime.test.ts)
```

### 5. Confine staged artifacts and reconcile before publication

**Finding**

- `type-design-analyzer-1` — `engine/src/orchestration/run-directory-handle.ts:106` — arbitrary relative paths can escape `artifacts/` before post-publication reconciliation.

**Fix**

- Replace raw `relativePath: string` construction with a parsed artifact-relative path/fixed artifact slot that rejects absolute paths, empty/dot/traversal components, backslash aliases, and duplicate normalized destinations.
- In `EffectRunner`, bind each staged artifact to its corresponding intent `ArtifactRef`, verify slot, digest, and byte length before any filesystem side effect, and derive the final path from the validated intent.
- Retain descriptor-anchored staging/promotion and add traversal, wrong-slot, wrong-digest, wrong-length, and duplicate-destination tests proving zero protected-file mutation.

**Validation**

```bash
(cd engine && bunx vitest run tests/orchestration/publication-faults.test.ts tests/orchestration/remediation-faults.test.ts)
```

### 6. Make semantic retry capture identity attempt-specific

**Finding**

- `type-design-analyzer-2` — `engine/src/core/harness-capture.ts:186` — slot-only duplicate tracking blocks the canonical attempt-2 recovery request.

**Fix**

- Introduce a parsed capture key containing slot id and semantic attempt (or exact output slot) and use it in `bindCapture` and run-directory discovery.
- Reject duplicate publication of the same attempt while permitting the engine-issued attempt-2 request after attempt 1.
- Add pure binding tests and real run-directory tests for attempt-1 duplicate refusal and attempt-2 acceptance.

**Validation**

```bash
(cd engine && bunx vitest run tests/orchestration/orchestration-acceptance.test.ts tests/core/orchestration-contract.property.test.ts)
```

### 7. Gate Claude and Pi state mutation on authenticated capture

**Findings**

- `silent-failure-hunter-5` — `engine/src/handlers/subagent-stop/capture-orchestration-result.ts:144` — Claude request-bound capture rejection exits successfully and legacy routing continues.
- `type-design-analyzer-3` — `pi/extension.ts:188` — Pi erases capture outcome and can apply unbound result evidence.
- `pr-test-analyzer-1` — `pi/extension.ts:1108` — Pi `tool_result` bridge has no request-bound publication integration proof.

**Fix**

- Return the typed `CaptureOutcome` from Pi capture instead of `Promise<void>`; for a result that claims engine-owned run authority, require `captured` before review/spec/task evidence can mutate protected state. Preserve no-op behavior for genuinely unrelated agents.
- Make Claude capture rejection/crash under explicit run binding a `HookResult.error`; dispatch must still run cleanup but skip every legacy state-mutating route for that result.
- Add Pi tool-result and Claude SubagentStop integration tests for captured, unrelated, rejected, and crashed outcomes; prove cleanup runs and protected state remains unchanged on rejection.

**Validation**

```bash
(cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/handlers/subagent-stop/dispatch-resilience.test.ts tests/orchestration/orchestration-acceptance.test.ts)
```

### 8. Enforce positive Wave numbers at DAG boundaries (accepted advisory)

**Finding**

- `type-design-analyzer-4` — `engine/src/orchestration/dags/wave-gate-operations.ts:49` — DAG schemas admit wave zero.

**Fix**

- Introduce/reuse the canonical positive Wave-number parser and change every Wave DAG input schema from nonnegative to positive.
- Add route tests rejecting zero/negative/non-integer values and accepting one.

**Validation**

```bash
(cd engine && bunx vitest run tests/orchestration/fugue-operation-dags.test.ts)
```

## Refuted Findings (not fixing)

### `silent-failure-hunter-2`

- **Claim:** unreadable/malformed request reservation files are silently dropped.
- **Intent lens:** `readIssuedRequests` intentionally includes only parsed immutable reservations; mapped omissions become audited `unknown-request` rejection.
- **Security lens:** malformed reservation authority cannot authorize a transcript write and is audited through binding rejection.
- **Disposition:** do not change this policy. Tests added for surviving correlator/no-follow findings must not convert this into a different semantic policy.

### `silent-failure-hunter-3`

- **Claim:** unreadable transcript slot directories are treated as uncaptured.
- **Intent lens:** the current comment explicitly documents this classification as deliberate.
- **Security lens:** exclusive no-follow transcript publication still rejects an existing attempt file or unsafe slot directory.
- **Disposition:** do not change the refuted slot-directory policy; only make capture keys attempt-specific for the separate surviving retry finding.

### `silent-failure-hunter-4`

- **Claim:** Pi standalone capture failure continues as successful publication.
- **Intent lens:** standalone capture is deliberately audit-only and must not abort unrelated evidence processing.
- **Security lens:** standalone results short-circuit before task-state mutation.
- **Disposition:** preserve standalone task-state isolation. The surviving Pi fix gates state-mutating non-standalone review/spec/task routes, not the refuted standalone behavior.

## Full validation

```bash
bun run --cwd engine typecheck
bun run --cwd engine test:unit
bun run --cwd engine test:smoke
```

Stage only the audited remediation path set plus this plan; never stage `.claude/reviews/review-and-fix-runs/`.
