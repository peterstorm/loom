# PR #35 Remediation Plan — Round 10

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Base: `origin/main` at `3de455c2f1580c2429d52ae6e286650ec5727392`
- Reviewed head: `3df057f0c2ef24da61aa6a649b672bfb7048f9cf`
- Review Run Directory: `review-20260901T050739Z-1572`
- Review result digest: `2ef8de208327c789052c24c8b81fd27b3c55835f3ea40b841f2b422e1ffcc83b`
- Scope: all 136 paths frozen by the registered Standalone Review, including documentation changes.

## Mandatory surviving critical Findings

1. `code-reviewer-1` and `silent-failure-hunter-1` — `pi/extension.ts`: a failed rollback after child roster publication discards the session/Agent authority required for shutdown retry.
   - Persist the exact child authority as `roster-cleanup-pending` when immediate compensation fails.
   - Prove the public shutdown event retries and retires that debt after the fault clears.

2. `silent-failure-hunter-2` — `pi/extension.ts`: result-time pointer success can delete a spawn reservation while sibling roster cleanup failed.
   - Track successful token, roster, and pointer cleanup independently during result settlement.
   - Retain only failed roster/pointer/grant authority; delete a reservation only when all its cleanup debt is empty.
   - Prove successful pointer release cannot erase failed roster-removal authority and shutdown retries it.

3. `comment-analyzer-1` — `engine/src/orchestration/effect-runner.ts`: the module comment overstates receipt-backed idempotency across the execution-to-receipt crash window.
   - Document the actual guarantee: a durable matching receipt prevents replay, while adapter execution before receipt persistence can be retried and therefore requires operation-level reconciliation/idempotency.

4. `comment-analyzer-2` — `engine/src/orchestration/harness-capture-runtime.ts`: `terminalizeCaptureRejection` can throw when `rejectCapture` throws or rejects despite its never-throw contract.
   - Convert thrown marker-persistence faults into `retriable-failure` while preserving the original refusal and infrastructure diagnostic.
   - Add direct regression coverage for a rejected persistence promise.

## Advisory dispositions

### Accepted

1. `pr-test-analyzer-1` — add deterministic, root-independent public Pi shutdown coverage using the existing session-registry I/O seam; retain permission tests as platform integration coverage.
2. `type-design-analyzer-6` — replace nullable `WaveSpecCheckDocumentAuthority` fields with an absent/present discriminated union so mismatched path/digest states are unrepresentable after parsing.
3. `comment-analyzer-3` — correct `currentRepoRoot` documentation to say resolution is memoized by environment/cwd key, not fresh on every call.
4. `comment-analyzer-4` — correct `readWaveReviewContext` documentation: `absent` also covers no packet matching the requested digest.
5. `code-simplifier-2` — centralize dispatch's exact cleanup-then-error composition in a private helper without changing cleanup order, wording, or public interface.

### Deferred

1. `pr-test-analyzer-2` — deterministic RunDirHandle close-fault tests require the planned anchored-filesystem capability seam; global filesystem mocks would obscure descriptor authority.
2. `pr-test-analyzer-3` — deterministic shadow-Git cleanup faults likewise require a narrow cleanup capability; global `node:fs` mocks would weaken the security boundary under test.
3. `type-design-analyzer-1` — Task review lifecycle ADT is a persisted TaskGraph schema migration spanning codecs, historical graphs, and StateManager transitions.
4. `type-design-analyzer-2` — legacy versus engine-owned Review Run discrimination is the same persisted-schema migration and must be atomic with its consumers.
5. `type-design-analyzer-3` — Pi review-attempt authority needs a coordinated parser/reservation/application migration rather than an inline type-only change.
6. `type-design-analyzer-4` — Reserved Slot role discrimination requires a full reservation parser and result-routing migration.
7. `type-design-analyzer-5` — Wave Gate lifecycle evidence should be replaced by the dedicated Lifecycle Machine projection in a focused migration, not another local type layer.
8. `architecture-tech-lead-1` — extracting Wave Gate aggregate commands from StateManager is a dedicated FC/IS migration with property tests and persistence-shell rewiring.
9. `architecture-tech-lead-2` — a pure Pi session runtime reducer is a worthwhile but broad cross-callback capability-aggregate migration.
10. `architecture-tech-lead-3` — one Pi result-application facade changes public seams and test imports; defer to a dedicated Public Surface migration.
11. `code-simplifier-4` — splitting `runUpdateTaskStatus` safely requires its planned authority/settlement deepening; local extraction now would distribute ordering knowledge.

### Dismissed

1. `code-simplifier-1` — a generic orchestration scenario builder would hide scenario-specific proof and TaskGraph authority. Existing repetition is deliberate until invariant-enforcing domain fixtures exist.
2. `code-simplifier-3` — ADR-0005 explicitly retains per-program Wave Gate control flow and names its stage functions as the test surface; a stage split based only on length would re-litigate that accepted decision without new contract divergence.

## Refuted Finding audit

The registered Refutation Panel refuted no critical Findings. Reproduction, intent, and security unanimously upheld four Findings; reproduction and security upheld `silent-failure-hunter-2` while intent was uncertain. All five remain mandatory.

## Validation receipt

- Focused Pi lifecycle, harness capture, Wave authority, StateManager load-guard, and dispatch suites: **5 files, 307 passed, 0 failures**.
- Post-distill exact cleanup-debt regressions: **5 passed**; TypeScript and unused-code gates remained clean.
- `bun run --cwd engine typecheck`: passed, including unused locals and parameters.
- Final authoritative `env -u PI_CODING_AGENT bun run --cwd engine test:unit`: **231 files, 6009 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke`: panel mode 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check`: clean.

`PI_CODING_AGENT` was unset only inside validation subprocesses so fixtures did not inherit this live Pi session's runtime handshake.

## Distill apply-mode receipt

Green implementation baseline: **231 files, 6009 passed, 1 platform skip**.

Move applied:

1. Centralized the private `retainSpawnCleanupDebt` invariant: a spawn reservation is deleted only when both roster and pointer cleanup debt are empty. Three duplicated map-update branches now cross one policy without changing effect order or public interfaces. Five direct cleanup-debt regressions and type/unused gates remained green.

Opportunities deliberately skipped:

- RunDirHandle and shadow-Git cleanup fault injection remain coupled to deferred capability ports; no global filesystem mocks were introduced.
- Task review state, Review Run, Pi review attempt, Reserved Slot, and Wave lifecycle ADTs remain coordinated persisted-authority migrations.
- StateManager Wave transitions, the Pi session aggregate reducer, and unified Pi result application require dedicated interface migrations.
- `resumeWaveGateFacade` remains per-program lifecycle policy under ADR-0005; no length-driven stage framework was introduced.
- `runUpdateTaskStatus` was not split without its authority/settlement migration.
- The orchestration scenarios remain explicit until invariant-enforcing domain fixtures can replace generic structural setup without hiding authority.
