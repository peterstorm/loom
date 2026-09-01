# PR #35 remediation — round 12

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Reviewed committed head: `e30cd0fcf08ea0cfba6eea86c0713cb77abd4404`
- Base: `origin/main` at `3de455c2f1580c2429d52ae6e286650ec5727392` (contained)
- Initial Review Run Directory: `review-20260901T080807Z-8486` (lost when validation removed ignored run evidence; never reconstructed)
- Blocked remediation preserving that loss: `remediation-20260901T091936Z-5443`
- Authoritative recovery Review Run Directory: `review-20260901T092117Z-31872`
- Recovery result digest: `a7a778ff401d9f41d6eb4bb79c8d2ef856fe49ad8fa6521d39ee934372d59b57`
- Final staging Review Run Directory: `review-20260901T100153Z-19048`
- Final result digest: `965b9c0fcfef5fc538a6f956c774337d89485dfd9210158a8eeec3a270f1d3d4`
- Final frozen scope: the 140 paths listed in that run's `result.json`
- Final outcome: 1 surviving critical Finding, 16 advisories, 0 refuted critical Findings

The final review examined the validated dirty source containing both earlier review remediations. It is the sole source authority for registered staging.

## Initial-review remediations retained in the recovery scope

1. Pi spawn-admission rollback now retires successful grant, roster, and pointer cleanup independently and retains exact remaining authority in the parent session aggregate for shutdown retry.
2. Claude capture converts only explicit transcript-read and transcript-JSON errors into terminal refusals; unknown payload-reader defects throw without tombstoning request authority.
3. Partial-promotion documentation now acknowledges post-precheck rename failures.
4. External port throws are caught before pure receipt reconciliation; reconciler defects cannot be relabeled as retriable adapter I/O.
5. State File mode and Context Packet payload-byte comments state only guarantees the code proves.
6. Wave workspace-observation handling uses one parse-style pure helper.
7. The duplicated Pi extension test fixture is shared at file scope.

## Mandatory surviving critical Finding

### Settle exact implementation authority when per-result application crashes

`pi/extension.ts` cleaned transient result reservation state before applying each successful implementation result. If `applyImplementationPiResult` then threw, the per-result catch only logged the exception; the modern Task could remain executing until age-based recovery despite exact failure authority being in hand.

Fix:

- In the per-result crash boundary, detect an exact reserved implementation slot.
- Under the current session State File lock, apply `settleUnavailableImplementation` with that exact Implementation Attempt authority and a typed observation instant.
- Preserve stale/already-settled authority idempotently; report settlement failures without suppressing the original application error.
- Add an integration regression proving an exit-0 reserved implementation whose application update throws becomes infrastructure-blocked, leaves `executing_tasks`, and records an immutable settlement receipt.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-2` — broad Pi capture catch.** Removed the catch spanning parsing, durable capture, and audit output. Typed capture outcomes remain values; unknown post-commit defects now reach the per-result crash boundary rather than becoming a misleading retriable capture failure.
2. **`pr-test-analyzer-1` — partial multi-grant admission rollback.** Added a real-filesystem regression proving one failed revocation survives while its successful sibling is retired before shutdown retry.
3. **`pr-test-analyzer-2` — admission roster cleanup debt.** Added a regression proving a failed roster removal remains in session cleanup authority and shutdown retries it.
4. **`pr-test-analyzer-3` — admission pointer cleanup debt.** Added a malformed pointer-registry regression proving pointer rollback debt survives and shutdown retries it after repair.
5. **`code-simplifier-2` — repeated dual-channel failure construction.** Added `processingFailure` and reused it wherever one diagnostic is both logged and returned as a processing error.
6. **`code-simplifier-3` — mutable failed-review disposition.** Replaced mutable fallback assignment with an exhaustive switch over every `FailedReviewApplication` variant.

### Deferred

1. **`pr-test-analyzer-4` — RunDirHandle close-fault injection.** Requires a narrow owned-anchor capability seam and real fake; global filesystem mocks would obscure no-follow invariants.
2. **`pr-test-analyzer-5` — shadow-Git cleanup fault injection.** Requires an injectable temporary-administration cleanup capability.
3. **`type-design-analyzer-1` — `ExactImplementationSettlement` ADT.** Changes the settlement interface and all shell renderers; dedicated authority migration.
4. **`type-design-analyzer-2` — `PiReviewAttemptAuthority` ADT.** Persisted/recovery authority migration spanning spawn and result reconciliation.
5. **`type-design-analyzer-3` — `ReviewRun` Wave authority ADT.** Protected-state schema and migration work across StateManager, review reducers, and recovery.
6. **`architecture-tech-lead-1` — pure Wave Gate aggregate commands.** Broad StateManager command/repository deepening.
7. **`architecture-tech-lead-2` — consumer-owned Run Directory capabilities.** Broad interface-segregation migration across consumers and fakes.
8. **`architecture-tech-lead-3` — Pi session lifecycle reducer.** Broad aggregate migration across callbacks and effect feedback.
9. **`code-simplifier-1` — extract missing-reservation reconciliation.** Coupled to the deferred Pi session reducer; mechanical extraction risks hiding effect order.
10. **`code-simplifier-4` — standalone prompt test fixture.** Test-only readability cleanup with no authority or correctness impact; defer to a dedicated fixture pass rather than widen this security remediation.
11. **`code-simplifier-5` — packet-base rejection fixture.** Test-only cleanup in an unrelated quality-program suite; defer to its fixture pass.

### Dismissed

1. **`silent-failure-hunter-3` — unknown FileWrite `via`.** Intentional conservative compatibility behavior: absent legacy `via` maps to tool, while every unknown present value maps to shell, which cannot advance a guarded write and still vetoes/demotes downstream. The exact behavior is documented and pinned in `ledger.test.ts`.
2. **`silent-failure-hunter-4` — malformed TestRun reports.** Intentional fail-closed demotion: an invalid report becomes `null`, so it can never vouch for a trusted pass while the TestRun remains audit-visible. Treating conservative evidence demotion as ledger absence would reduce compatibility without increasing authority safety.

## Refuted-Finding audit

No critical Finding was refuted. The intent lens refuted the recovery critical because age-based stale-attempt recovery exists, but reproduction and security upheld it: exact current authority can settle immediately and should not leave avoidable availability debt.

## Validation plan

1. Focused Pi admission/shutdown, result-application crash, Claude capture, effect runner, Wave readiness, and `pi/subagent-result` suites.
2. `bun run --cwd engine typecheck`, including unused-code gates.
3. Final authoritative `env -u PI_CODING_AGENT bun run --cwd engine test:unit`.
4. `env -u PI_CODING_AGENT bun run --cwd engine test:smoke`.
5. `git diff --check`.
6. Run one final registered all-scope review after validation if validation removes ignored Review Run evidence again; staging must use a surviving immutable review run.
7. Confirm `origin/main` remains contained, the installed package Runtime Revision matches disk, and the real Git index is empty before remediation.

`PI_CODING_AGENT` is unset only in validation subprocesses so fixtures do not inherit the live Pi runtime handshake.

## Final-review mandatory comment correction

`effect-runner.ts` described `createEffectRunner` as the sole intent execution/receipt path, but standalone finalization directly publishes `result.json`, records its receipt, and reconciles it after both fresh exclusive writes and byte-identical collisions. The JSDoc now names that explicit standalone-specific alternative and its idempotency protocol.

## Final-review advisory dispositions

Accepted:

1. Added a dual-failure regression proving both result-application and fallback-settlement errors remain visible while a sibling still settles.
2. Corrected `piAllSlotsFailedNote` documentation: a surviving sibling removes only the all-slot signature, not every possible partial infrastructure fault.
3. Corrected Claude capture documentation: orchestration authority is Run-Directory-only, while payload observation also reads the externally located transcript.

Deferred:

1. Shadow-Git cleanup fault injection and RunDirHandle wrapper close-fault injection require dedicated narrow capability seams.
2. `ExactImplementationSettlement`, `PiReviewAttemptAuthority`, and `ReviewRun` ADTs require coordinated interface or persisted-authority migrations.
3. Wave Gate commands, Run Directory capability projections, and the Pi session reducer remain dedicated deepenings.
4. `resumeWaveGateFacade`, `runUpdateTaskStatus`, and SubagentStart lifecycle decomposition remain order-sensitive dedicated refactors.
5. Broad Pi event builders are test-only cleanup and would hide scenario-specific authority in this remediation.

Dismissed:

1. Replacing Pi’s two local reviewer classifiers with `engine/src/config.ts` would pull the configuration/filesystem shell into `pi/subagent-result.ts` and `pi/reserved-results.ts`. Their `agentsOfKind("reviewer")` projections stay pure and derive from the same Agent Catalog source.

## Validation receipt

- Focused initial Claude capture/publication: 151 passed.
- Pi extension integration progression: 133 passed, then 137 passed after cleanup/crash fixes, then **138 passed** after dual-failure coverage.
- Pi result applier suite: **71 passed**.
- Wave readiness post-distill suite: **14 passed**.
- Typecheck and unused-code gates: passed after every implementation group.
- Authoritative full unit suite after production remediation: **231 files, 6021 passed, 1 platform skip, 0 failures**.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.

## Distill apply-mode receipt

Moves applied:

1. Parsed Wave workspace authority once through a private `DomainResult` helper.
2. Shared the duplicated Pi extension fixture.
3. Added `processingFailure` for identical log/error outcomes.
4. Replaced mutable failed-review disposition with an exhaustive switch.

Skipped: all interface-changing ADTs/capability seams, ADR-0005’s per-program Wave driver, order-sensitive large-handler splits, and broad test builders that hide authority differences.
