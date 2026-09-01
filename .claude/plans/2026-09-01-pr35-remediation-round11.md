# PR #35 remediation — round 11

Date: 2026-09-01
Branch: `fix/deterministic-task-completion-post-merge`
Base authority: `origin/main` at `3de455c2f1580c2429d52ae6e286650ec5727392`
Reviewed head: `e1efa6dd2d5d4bab170a304706aa944f8426d771`
Review Run Directory: `review-20260901T070503Z-27345`
Authoritative result digest: `3c17e2ee5f1adc9d973d41f0b78fb1836b1449ee1ae766189959172e61c88a99`
Scope: all 137 paths frozen by the registered Standalone Review, including documentation changes.

## Surviving critical findings — mandatory

1. **`silent-failure-hunter-1` — corrupt machine-binding authority can look empty during cleanup**
   - Introduce an explicit parsed/corrupt binding-authority projection at the `SessionRegistry` port.
   - Make `cleanup-subagent-flag` refuse unbind attribution when any persisted row is malformed, name the binding file, preserve the corrupt authority, continue independent sidecar/pointer/roster cleanup, and return an actionable error.
   - Add production-adapter and cleanup regressions for malformed-only and mixed valid/malformed files.

2. **`type-design-analyzer-1` — Context Packet parser accepts undeclared top-level properties omitted from identity**
   - Reject every top-level property outside the exact Context Packet schema before rebuilding canonical identity.
   - Add an example and a fast-check property proving any injected undeclared key is rejected without changing valid packet round trips.

3. **`comment-analyzer-1` — staged-promotion parser accepts a broader suffix than its generator**
   - Enforce the exact 24-character lowercase hexadecimal publication id emitted by `stageArtifactSet`.
   - Update parser-authority fixtures and add malformed-shape examples/property coverage.

4. **`comment-analyzer-2` — `specCheckSlotAuthority` absence documentation excludes modern invalidation**
   - Correct the field documentation to include both historical epochs and modern task-attempt invalidation/reissuance.

5. **`comment-analyzer-3` — partial-promotion documentation overstates low-level read safety**
   - Correct both promotion comments: filesystem remnants are inert only as publication authority because no successful result/Effect Receipt exists; low-level artifact reads are not receipt-gated and callers must consume artifact references only from successful publication authority.

## Advisory dispositions

### Accepted

1. **`pr-test-analyzer-1`** — add a root-independent Pi integration test with two grants where one revocation succeeds and one fails through an `EISDIR` token-file substitution; prove only failed authority survives and shutdown retries it.
2. **`comment-analyzer-4`** — correct recovery-tomb wording: the pre-unlink re-read narrows the race and revalidates token content but cannot prove the pathname’s inode at `unlinkSync`.
3. **`comment-analyzer-5`** — remove refactoring history from `pi/reserved-results.ts`; retain the positional-reconciliation and pure-functional-core rationale.
4. **`code-simplifier-1`** — after a green implementation baseline, centralize the identical anchor-close/error-precedence sequence used by the two no-follow wrappers in one private finisher; preserve ordering and external interfaces.

### Deferred

1. **`pr-test-analyzer-2`** — deterministic RunDirHandle anchor-close injection requires the accepted narrow consumer-owned anchored-filesystem capability; adding a global filesystem mock would hide the security invariant.
2. **`pr-test-analyzer-3`** — deterministic shadow-Git administration cleanup injection requires a narrow cleanup capability; global fs mocking would weaken the real boundary.
3. **`type-design-analyzer-2`** — `PiReviewAttemptAuthority` is persisted compatibility state; its legacy/modern ADT requires coordinated parser, reservation, and application migration.
4. **`type-design-analyzer-3`** — phase-specific transition typing requires a closed current-phase/next-phase command model across `advance-phase` and StateManager, not a local cast or duplicated table.
5. **`architecture-tech-lead-1`** — a pure Pi session aggregate/reducer is a broad multi-callback authority migration with durable recovery implications.
6. **`architecture-tech-lead-2`** — extracting Wave Gate commands from StateManager is a dedicated FC/IS persistence migration.
7. **`architecture-tech-lead-3`** — decomposing RunDirHandle into consumer-owned capabilities changes many interfaces and fixtures; perform as a dedicated deepening while preserving ADR-0004 anchoring.
8. **`code-simplifier-2`** — splitting `runUpdateTaskStatus` safely must accompany its authority and settlement deepening; a length-only extraction would merely redistribute context.

### Dismissed

1. **`code-simplifier-3`** — no stage framework or length-driven split for `resumeWaveGateFacade`: ADR-0005 records that this sequence is per-program policy and its named step functions are the test surface. No newly reported duplicated computation justifies reopening that decision.

## Refuted-finding audit

No critical finding was refuted. The Context Packet finding received one intent refutation, but reproduction and security upheld it, so it survives the panel threshold and is mandatory.

## Validation receipt

- Focused binding-authority, cleanup, Context Packet, publication, and Pi cleanup passes: **173 passed**, followed by **97 passed** after closing nested section-field authority.
- `bun run --cwd engine typecheck`: passed, including unused locals and parameters.
- Green implementation baseline: **231 files, 6015 passed, 1 platform skip, 0 failures**.
- Post-distill no-follow/publication suites: **130 passed, 1 platform skip**; typecheck and unused-code gates remained clean.
- Final authoritative `env -u PI_CODING_AGENT bun run --cwd engine test:unit`: **231 files, 6015 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke`: panel mode 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check`: clean.

`PI_CODING_AGENT` was unset only inside validation subprocesses so fixtures did not inherit the live Pi runtime handshake.

## Distill apply-mode receipt

Green baseline: **231 files, 6015 passed, 1 platform skip**.

Move applied:

1. Added one private `finishAnchoredOperation` helper for the identical anchor-close/error-precedence sequence in `withAnchoredDirectoryLock` and `withOpenedDirectoryNoFollow`. Effect order, thrown values, aggregate-error behavior, and public interfaces are unchanged. Direct coverage remained green at 130 passed plus one platform skip.

Opportunities deliberately skipped:

- RunDirHandle and shadow-Git cleanup fault injection remain coupled to deferred narrow capability ports; no global filesystem mocks were introduced.
- Pi review-attempt and phase-transition ADTs remain coordinated persistence/command migrations.
- Pi session authority, StateManager Wave Gate commands, and RunDirHandle capability decomposition require dedicated interface migrations.
- `runUpdateTaskStatus` was not split without its authority/settlement deepening.
- `resumeWaveGateFacade` remains per-program policy under ADR-0005; no length-driven stage framework was introduced.
