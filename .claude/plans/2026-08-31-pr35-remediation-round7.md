# PR #35 remediation — round 7

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Base: `origin/main` at `3de455c2f1580c2429d52ae6e286650ec5727392`
- Reviewed head: `7961719f6b05d455e2210aa6fa0fe4160abbf092`
- Standalone Review Run: `review-20260831T201813Z-17220`
- Frozen scope: the exact 130 paths in that run's authoritative `result.json`
- Result digest: `f761f621a28ae6c2edfdcf5847c802c6a4659db0fee82ec492bde6ed47afd6ee`
- Findings: 5 surviving criticals, 19 advisories, 1 refuted critical

## Surviving criticals — mandatory fixes

### 1. Standard Maven terminals are rejected

Finding: `code-reviewer-1`.

Fix:

- Recognize canonical Maven `[INFO] BUILD SUCCESS` and `[INFO] BUILD FAILURE` terminal lines in addition to the already-supported unprefixed transcript form.
- Preserve invocation ordering and stale-run supersession.
- Add realistic prefixed success and failure regressions.

### 2. Inline prose can impersonate spec-check count markers

Finding: `code-reviewer-2`.

Fix:

- Anchor critical count, high count, verdict, and wave extraction to complete marker lines inside the authoritative final footer.
- Add a regression proving an inline prose mention cannot satisfy an omitted concrete count marker.

### 3. Corrupt binding authority can collapse into one valid binding

Finding: `silent-failure-hunter-1` (intent lens refuted; reproduction and security upheld).

Fix:

- Keep `readBindings` as the diagnostic/liveness projection used by existing callers, but make `soleActiveBinding` inspect the classified authority directly and return `null` whenever any row is malformed.
- Preserve stale-binding behavior and active-roster exactness.
- Add a regression with one valid row, one malformed row, and the matching sole active roster entry.

### 4. Prepared recovery-guard publication failure is not pinned

Finding: `pr-test-analyzer-1`.

Fix:

- Add a real anchored-filesystem regression that forces exclusive prepared-leaf publication to fail before canonical linking.
- Prove the canonical recovery guard never appears and the stale lock remains untouched.

### 5. Wave scope identity comment overstates direct batch-epoch inputs

Finding: `comment-analyzer-1` (security lens refuted; reproduction and intent upheld).

Fix:

- Document the actual identity chain: serialized scope directly affects Context Packet identity, while complete TaskGraph authority affects `batchEpoch` transitively through `authorityDigest`.
- Do not change the already content-addressed authority derivation.

## Advisory dispositions

### Accepted

1. `pr-test-analyzer-2` — directly cover the explicit `EPERM`-means-alive liveness branch with a real stale-lock recovery observation and a scoped `process.kill` seam already used by the suite.
2. `type-design-analyzer-1` — reject duplicate Context Packet labels across fixed and variable sections; labels are lookup identity and `.find` must never choose among duplicates.
3. `comment-analyzer-3` — correct the Review Packet hash-brand JSDoc: parser minters validate digest shape; only content-owning parse paths can reverify bytes.
4. `comment-analyzer-4` — describe tally group 1 as the decisive count, not universally the executed-test count.
5. `comment-analyzer-5` — describe generic runner ordering as later matching summaries, not proven invocation boundaries.
6. `comment-analyzer-6` — state that `attributeFindings` mints new identities while persisted parsers rehydrate existing identities.
7. `comment-analyzer-7` — remove the state-manager test comment that restates the following `Array.from` expression.
8. `code-simplifier-1` — consolidate repeated Wave Context Packet read/decode/corruption handling in one private helper while preserving request-specific diagnostics.
9. `code-simplifier-2` — hoist the duplicated adjacent Pi Review Run fixture factory.
10. `code-simplifier-3` — replace Pi subagent-result implementation-history prose with its current responsibility and diagnostic-return contract.

### Deferred

1. `pr-test-analyzer-3` — deterministic RunDirHandle close-only and operation-plus-close injection still requires consumer-owned capability projections; global filesystem mocking would reinforce the reviewed god port.
2. `pr-test-analyzer-4` — deterministic shadow-Git operation-plus-cleanup failure injection requires a temporary-administration capability; global `node:fs` mocking would test implementation detail.
3. `type-design-analyzer-2` — `WaveSpecCheckDocumentAuthority` ADT migration changes persisted TaskGraph and Context Packet schemas and requires atomic compatibility parsing.
4. `type-design-analyzer-3` — `PiReviewAttemptAuthority` variant migration spans reservation, durable recovery, and settlement and belongs in the dedicated Pi authority migration.
5. `architecture-tech-lead-1` — Pi spawn compensation extraction requires a dedicated transaction module and failure-at-every-acquisition property suite.
6. `architecture-tech-lead-2` — decomposing `RunDirHandle` requires consumer-owned capability ports and real in-memory fakes across multiple callers.
7. `architecture-tech-lead-3` — replacing locked arbitrary observations with TaskGraph compare-and-swap requires a state persistence protocol migration.
8. `architecture-tech-lead-4` — Pi configuration and trusted-review witnesses require an extension-instance composition-root migration and isolation tests.
9. `architecture-tech-lead-5` — deleting the Context Packet compatibility re-export requires an atomic consumer import migration and curated-surface update.

### Dismissed

None.

## Refuted-finding audit

`comment-analyzer-2` was refuted by reproduction and intent. Its own JSDoc already states that missing or unparsable legacy/corrupt `reserved_at` values remain immediately eligible when no Agent is active, matching implementation. It is recorded and not changed.

Two surviving findings received one-lens refutations but did not meet the two-lens threshold:

- `silent-failure-hunter-1`: intent considered skip-and-log deliberate; reproduction/security proved ambiguous authority can still be granted.
- `comment-analyzer-1`: security observed transitive TaskGraph coverage; reproduction/intent upheld that the direct-participation wording is inaccurate.

## Planned files outside frozen scope

Only this plan is outside the frozen review scope and must be registered as a remediation support path. All implementation and regression files are already in the authoritative scope.

## Validation receipt

- Focused runner-evidence, spec-check, ledger, Context Packet, anchored recovery/liveness, Wave façade, Pi integration, Review Packet, and StateManager suites: **11 files, 576 passed, 1 platform skip, 0 failures**.
- Post-distill exact Wave packet-recovery regression: **1 passed**; TypeScript and unused-code gates remained clean.
- `bun run --cwd engine typecheck`: passed, including unused locals and parameters.
- Final `env -u PI_CODING_AGENT bun run --cwd engine test:unit`: **231 files, 6001 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke`: panel mode 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check`: clean.

`PI_CODING_AGENT` was unset only inside validation subprocesses so fixtures did not inherit this live Pi session's runtime handshake.

## Distill apply-mode receipt

Green implementation baseline: **231 files, 6001 passed, 1 platform skip**.

Move applied:

1. Compressed the Wave candidate roster's context type from the complete tri-state read result to the already-proven `absent | loaded` subset. The private read helper is now the sole place where `corrupt` can exist; downstream recovery cannot represent a rejected context. The exact packet-recovery regression and type/unused gates remained green.

Opportunities deliberately skipped:

- RunDirHandle and shadow-Git cleanup fault injection remain coupled to the deferred capability-port migrations; no global filesystem mocks were introduced.
- Persisted Wave document and Pi review-attempt ADTs remain atomic schema migrations, not local cleanup.
- Pi spawn compensation, TaskGraph compare-and-swap, RunDirHandle decomposition, Pi composition-root ownership, and Context Packet compatibility deletion remain the dedicated deepenings dispositioned above.
- No additional local simplification reduced concepts or representable states without obscuring parser invocation boundaries or anchored-filesystem authority.
