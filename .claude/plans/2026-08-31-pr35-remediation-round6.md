# PR #35 remediation — round 6

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Base: `origin/main` at `3de455c2f1580c2429d52ae6e286650ec5727392`
- Reviewed head: `42df4d507aaddb63ff9d38bdc381d47d111941f3`
- Standalone Review Run: `review-20260831T185939Z-28550`
- Frozen scope: the exact 128 paths in that run's authoritative `result.json`
- Result digest: `7965c9a85a073d6eed56b784d163917dc04446a85175bf9dbd67227771347c11`
- Findings: 10 surviving criticals, 17 advisories, 0 refuted criticals

## Surviving criticals — mandatory fixes

### 1. Final spec-check footer authority fails open

Findings:

- `code-reviewer-1`: malformed later footer preserves an earlier pass.
- `silent-failure-hunter-1`: a later footer without `SPEC_CHECK_CRITICAL_COUNT` preserves an earlier pass.
- `pr-test-analyzer-1`: the omitted-count partition is not covered.
- `comment-analyzer-4`: the parser comment claims verdict-terminated selection while tested behavior selects a final incomplete footer.

Fix:

- Partition transcript evidence at the final concrete `SPEC_CHECK_WAVE` footer start before reading findings, counts, or verdict.
- Parse only that final footer; an omitted/malformed count or missing verdict therefore reconciles to `EVIDENCE_CAPTURE_FAILED` and cannot borrow earlier markers.
- Correct the parser contract comment to describe final-footer selection and optional verdict termination.
- Add regressions for omitted and malformed later markers.

### 2. Review Packet remote base is guessed

Finding: `code-reviewer-2`.

Fix:

- Treat only a successfully resolved `refs/remotes/origin/HEAD` symbolic ref as remote-default-branch authority.
- Remove the `main` default when that symbolic ref is absent; without `task.start_sha`, fail closed.
- Add a real Git fixture where `origin/main` exists but `origin/HEAD` does not.

### 3. Maven terminal evidence crosses invocation boundaries

Finding: `silent-failure-hunter-2`.

Fix:

- Recognize Maven invocation starts and prevent a terminal from completing a tally from an earlier invocation.
- Emit zero-test/failing evidence for a completed Maven invocation with no tally so it supersedes stale passing or incomplete evidence.
- Add example and property regressions for incomplete-run → later no-test build ordering.

### 4. A later incomplete Vitest invocation is invisible

Finding: `silent-failure-hunter-3`.

Fix:

- Recognize Vitest `RUN v…` invocation starts.
- When the latest invocation begins after the latest numeric `Tests` summary and emits no summary, produce explicit incomplete-run failure evidence.
- Add example and property regressions proving stale passes cannot survive a later summary-less invocation.

### 5. TypeScript method declarations mint new-test evidence

Finding: `comment-analyzer-1`.

Fix:

- Refuse incomplete/multiline candidate expressions that cannot prove a matching invocation close.
- Recognize return-annotated method/interface/overload suffixes, including `test(): void {}` and `test(): void;`, as declarations rather than runner calls.
- Update the declaration-detection comment and add positive/negative diff regressions.

### 6. Malformed recovery guards are reclaimed by age

Finding: `comment-analyzer-2` (intent lens refuted, reproduction and security upheld).

Fix:

- Publish recovery guards only after their complete owner token is written, using a prepared sibling and an exclusive hard-link publication step.
- Treat a malformed canonical recovery token as corruption that cannot prove abandonment; never reclaim it by elapsed time.
- Retain dead-PID reclamation for well-formed guards and update the protocol documentation.
- Add malformed-token, dead-owner, and unexpected-liveness-probe regressions.

### 7. Wave spec-check authority comment understates immutable authority

Finding: `comment-analyzer-3` (intent lens refuted, reproduction and security upheld).

Fix:

- Distinguish semantic Requirement Completion Claims from the complete content-addressed scope: `completionAnchors` alone define completion obligations, while every serialized field participates in packet/batch integrity and request identity.

## Advisory dispositions

### Accepted

1. `silent-failure-hunter-4` — malformed/unreadable higher-priority agent metadata must not fall through to lower-priority authority. Stop at the first existing candidate and surface its fault.
2. `silent-failure-hunter-5` — `ESRCH` means dead and `EPERM` means alive; unexpected liveness-probe errors must surface rather than silently becoming “alive.”
3. `comment-analyzer-5` — define `fixedContext` as fixed for one request lineage/retry, not identical across every request in a batch.
4. `comment-analyzer-6` — qualify the Pi applier module contract: protected-state and repository observations use ports, while phase/spec-check paths directly observe explicitly supplied filesystem artifacts.
5. `comment-analyzer-7` — document that staged-artifact cleanup is attempted and cleanup failures can leave inert staged files reported in the typed failure.
6. `code-simplifier-1` — share one private latest-position verdict reducer across Vitest and Maven after the correctness fixes.
7. `code-simplifier-2` — share one canonical recovery artifact-identity projection across current and legacy Review Packet recovery.

### Deferred

1. `pr-test-analyzer-2` — close-only and operation-plus-close RunDirHandle fault injection requires the focused anchor/capability port that is part of the dedicated RunDirHandle deepening; adding a test-only seam or filesystem mock now would worsen the reviewed god port.
2. `pr-test-analyzer-3` — deterministic shadow-Git cleanup fault injection requires an injectable temporary-administration capability; global `node:fs` mocking would test implementation details and is deferred with that shell seam.
3. `pr-test-analyzer-5` — deterministic Darwin probe-close fault injection requires a platform probe capability and Darwin execution; it is deferred to that adapter migration rather than adding a Linux-only mock assertion.
4. `type-design-analyzer-1` — changing `WaveSpecCheckDocumentAuthority` to a discriminated union changes persisted TaskGraph and packet schemas and requires an atomic parse/migration rollout.
5. `type-design-analyzer-2` — changing `PiSpawnReservation` to lifecycle-specific variants spans reservation creation, durable recovery, and result application; it belongs in the dedicated Pi authority migration.
6. `architecture-tech-lead-1` — extracting the Pi spawn transaction is a dedicated compensation/port migration with property-tested rollback, not a local review fix.
7. `architecture-tech-lead-2` — splitting the 20-plus-method `RunDirHandle` requires focused capability projections and real in-memory fakes across consumers.
8. `architecture-tech-lead-3` — injectable Pi runtime configuration and a session-owned witness registry require a composition-root migration and extension-instance isolation tests.
9. `architecture-tech-lead-4` — deleting the Context Packet compatibility re-export requires an atomic import migration across eleven production and test consumers outside the reviewed module; defer it with the broader curated-surface migration rather than broadening this security remediation into unreviewed orchestration programs.

### Dismissed

1. `pr-test-analyzer-4` — the claimed roster-read gap is already pinned by `mark-subagent-active-roster.test.ts`: it plants a directory at the existing `.active` path, exercises the resulting EISDIR read failure through the public start handler, and proves no pointer or machine capability is published. No duplicate test is added.

## Refuted-finding audit

No critical finding met the two-lens refutation threshold. `comment-analyzer-2` and `comment-analyzer-3` each received one intent-lens refutation, but reproduction and security upheld both; both remain mandatory.

## Planned files outside frozen scope

The plan and `engine/tests/review-round6-core-regressions.test.ts` are outside the frozen scope and must be registered as remediation support paths. All other implementation and regression paths are already in the frozen review scope.

## Validation receipt

- Focused spec-check, runner evidence, Review Packet, Git test counting, agent metadata, recovery-guard, publication, and Pi adapter suites: **15 files, 644 passed, 1 platform skip, 0 failures**.
- `bun run --cwd engine typecheck`: clean, including unused locals and parameters.
- Final `bun run --cwd engine test:unit`: **231 files, 5994 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke`: panel mode 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check`: clean.

The first post-distill full rerun hit one unrelated shared-directory concurrency flake in `upgrade-spec-trace.test.ts`; that suite passed 16/16 in isolation, and the exact full command was rerun to the final green receipt above. `PI_CODING_AGENT` was unset only inside validation subprocesses so test fixtures did not inherit this live Pi session's runtime handshake.

## Distill apply-mode receipt

Green baseline: **231 files, 5994 passed, 1 platform skip** before simplification.

Move applied:

1. Removed the one-call `mavenVerdictKind(executed, failed)` wrapper after failure had already been resolved into a separate verdict arm. The call site now represents only its two legal states (`zero` or `passed`); 212 directly covering tests and the final complete suite remained green.

Opportunities deliberately skipped:

- The persisted Wave document and Pi reservation ADTs, Pi spawn transaction, RunDirHandle capability projections, Pi composition root, and cleanup fault-injection seams remain the dedicated deepening migrations dispositioned above.
- Context Packet compatibility-surface deletion remains deferred because it requires an atomic eleven-caller migration outside this review's implementation scope.
- No further local extraction reduced concepts or representable states without obscuring runner invocation boundaries or anchored-filesystem security invariants.
