# PR #35 remediation — round 5

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Frozen head: `be586e8e495d6f187343b063b852d4c5a40a7457`
- Base/current `origin/main`: `3de455c2f1580c2429d52ae6e286650ec5727392`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260831T173826Z-6376`
- Authoritative result: `.claude/reviews/review-and-fix-runs/review-20260831T173826Z-6376/result.json`
- Exact reviewed scope: the 127 paths frozen in that authoritative result, including documentation.

## Mandatory surviving criticals

1. **`code-reviewer-1` — an earlier Maven success can authorize a later incomplete run.**
   - Parse Maven tallies and terminal build markers in transcript order.
   - Require each zero-failure tally to have a later terminal marker; an absent marker is an explicit non-passing incomplete verdict, never discarded evidence.
   - Add pass-then-incomplete and ordered multi-run regressions plus properties for complete and incomplete Maven output.

2. **`silent-failure-hunter-1` — a malformed later Vitest summary can preserve a stale pass.**
   - Recognize numeric Vitest `Test(s)` summary candidates separately from `Test Files` output.
   - Convert a malformed candidate into an explicit failed verdict so it supersedes earlier evidence rather than disappearing.
   - Add a pass-then-trailing-pipe regression and a property that arbitrary valid failures made incomplete still cannot preserve a pass.

3. **`comment-analyzer-1` — spec-check parsing extends the selected block through EOF.**
   - Bound the selected concrete machine footer from its concrete Wave marker through its first subsequent concrete verdict marker.
   - Treat a later incomplete footer as incomplete instead of borrowing an earlier verdict, and ignore trailing finding/override markers outside the selected footer.
   - Keep attributable manual override inside that exact footer, before its terminal verdict, and add block-isolation regressions.

4. **`comment-analyzer-2` — artifact promotion comments promise filesystem atomicity the implementation intentionally does not provide.**
   - Preserve the receipt-gated behavior pinned by the existing partial-promotion test.
   - Correct both comments to state that predictable conflicts are refused before rename, unexpected partial finals remain inert without a receipt, and publication authority is all-or-none even though filesystem promotion is not.

## Advisory dispositions

### Accepted

1. **`code-reviewer-2` / `code-simplifier-2` — verdict ordering rescans prefixes quadratically.**
   - One sound defect reported twice. Store each regex match's absolute position directly in `RunnerVerdict`; delete `lineOf`.

2. **`silent-failure-hunter-2` — shadow Git cleanup can replace the primary error.**
   - Preserve operation/setup failure and cleanup failure together with `AggregateError`; surface cleanup alone when it is the only failure.

3. **`silent-failure-hunter-3` — Run Directory anchor close failures escape typed results.**
   - Route all Run Directory anchor releases through the existing guarded-close primitive.
   - Convert close-only and operation-plus-close failures back into `RunDirectoryError`, preserving the primary diagnostic and never throwing from `DomainResult` operations.

4. **`silent-failure-hunter-4` — roster `existsSync` suppresses inspection faults.**
   - Read directly under the existing lock, treat only `ENOENT` as absence, and propagate every other fault before append.

5. **`silent-failure-hunter-5` — call-start `existsSync` can discard existing stamps after a hidden fault.**
   - Read directly under the existing lock, treat only `ENOENT` as absence, and preserve the explicit corrupt-content recovery for bytes that were actually read.

6. **`silent-failure-hunter-6` — Review Packet base silently falls back to `HEAD^`.**
   - Keep `task.start_sha` authoritative when present and a proven remote default branch as the only derived base.
   - Fail closed when neither exists rather than guessing a one-parent history that can omit task changes. Add a no-remote/no-start regression.

7. **`silent-failure-hunter-7` — Darwin capability-probe cleanup can replace the probe failure.**
   - Preserve probe and cleanup failures together using the same explicit primary/cleanup composition as the shadow Git boundary.

8. **`pr-test-analyzer-1` — linked-worktree fixture does not prove linked-index authority.**
   - Stage a linked-worktree-only file and prove `diffFilesStaged` reads the linked worktree's index, not the primary index.

9. **`pr-test-analyzer-2` — skipped/todo-only Vitest branches lack coverage.**
   - Add example/property coverage proving any non-zero skipped/todo-only summary is recognized zero-test evidence and cannot pass.

10. **`type-design-analyzer-4` — non-finite `acceptedResults` can make lifecycle projection non-terminating.**
    - Reject values that are not non-negative safe integers before replay. Add arbitrary invalid-number coverage.

11. **`code-simplifier-3` — Start/Stop wrappers restate the shared parsed union.**
    - Alias both event-specific exported names to `ParsedSubagentLifecycleInput` while preserving public names and behavior.

### Deferred

1. **`type-design-analyzer-1` — `ReviewRun` legacy/exact ADT.**
   - Sound, but requires an atomic persisted State File parser/migration and all review lifecycle writers/readers to adopt the new union.

2. **`type-design-analyzer-2` — `PiReviewAttemptAuthority` legacy/exact ADT.**
   - Sound, but requires a Pi wire-authority migration across reservation, capture, and historical recovery.

3. **`type-design-analyzer-3` — category-discriminated `ReservedSlot`.**
   - Sound, but changes reservation construction and settlement for implementation, reviewer, and spec-check categories together.

4. **`architecture-tech-lead-2` — split the wide `RunDirHandle` port and add a fake.**
   - Sound deepening, but it changes the main orchestration seam and every caller/test adapter. Do it as one capability-port migration, not alongside close-error remediation inside the current interface.

5. **`architecture-tech-lead-3` — split the Pi extension imperative shell.**
   - Sound deepening, but requires moving lifecycle registries and extension wiring behind new real seams with production and test adapters.

### Dismissed

1. **`architecture-tech-lead-1` / `code-simplifier-1` — extract `resumeWaveGateFacade` phases.**
   - ADR-0005 explicitly adjudicated this shape: the sequence is program-essential policy, the shared mechanics already live below it, and named step functions are the intended test surface. Neither finding identifies a duplicated computation shared by another program, so extraction would reintroduce the rejected shallow driver framework or private pass-throughs.

2. **`code-simplifier-4` — general orchestration test fixture builder.**
   - The repeated-looking blocks encode materially different proof, review-status, Finding-history, and capture-authority arrangements in security regressions. A broad override-driven fixture would move those invariants out of each test and make invalid combinations easier to construct, failing the reader and state-space tests.

## Refuted-finding audit

No critical met the panel's refutation threshold. The artifact-promotion documentation finding was refuted by the intent lens because partial filesystem promotion is deliberately receipt-gated and tested, but reproduction and security upheld the mismatch between observable partial finals and the “all or none” wording; it therefore survives and is mandatory. The Maven, Vitest, and spec-check findings were unanimously upheld by reproduction, intent, and security.

## Support paths outside frozen scope

Register at remediation start:

- `.claude/plans/2026-08-31-pr35-remediation-round5.md`

All production and regression paths planned above are already inside the frozen review scope.

## Validation

```bash
bun run --cwd engine typecheck
(
  cd engine
  env -u PI_CODING_AGENT bunx vitest run \
    tests/handlers/update-task-status.test.ts \
    tests/handlers/subagent-stop/update-task-status.property.test.ts \
    tests/handlers/store-spec-check-findings.test.ts \
    tests/orchestration/no-follow-fs.test.ts \
    tests/orchestration/publication-faults.test.ts \
    tests/orchestration/orchestration-acceptance.test.ts \
    tests/handlers/helpers/quality-programs.test.ts \
    tests/handlers/subagent-start/mark-subagent-active-roster.test.ts \
    tests/machine/call-start.test.ts \
    tests/core/wave-completion-readiness.test.ts \
    tests/handlers/complete-wave-gate.test.ts \
    tests/parsers/parsers.test.ts \
    tests/utils/git.test.ts \
    --testTimeout=120000 --maxWorkers=4
)
bun run --cwd engine test:unit
env -u PI_CODING_AGENT bun run --cwd engine test:smoke
git diff --check
```

Unset `PI_CODING_AGENT` only in validation subprocesses that launch fresh Pi-aware CLI processes, so they do not inherit this live session's runtime handshake.

## Validation receipt

Validated against the remediated working tree:

- `bun run --cwd engine typecheck` — clean, including unused locals and parameters.
- Focused evidence, spec-check, filesystem, publication, Review Packet, roster, lifecycle, parser, Git, Pi adapter, and historical-improvement suites — **908 passed, 1 platform skip, 0 failures**.
- `bun run --cwd engine test:unit` — **230 files, 5984 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke` — panel mode 22/22, review panel 19/19, standalone review, all six façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check` — clean.

The first full-unit run correctly exposed two stale fixture contracts (one Pi spec-check footer and one Maven transcript ordering assumption); both were corrected and the complete unit command was rerun green. `PI_CODING_AGENT` was unset only for validation subprocesses so fresh Pi-aware fixtures did not inherit this live session's runtime handshake.

## Distill apply-mode receipt

Green baseline: the implementation-focused suite completed with **762 passed and 1 platform skip** before the final two full-suite fixture updates.

Move applied:

1. Made `withOwnedAnchor` branch exhaustively on returned versus thrown operation outcomes, deleting the logically unreachable post-settlement branch while preserving primary/close error composition. The 184 directly covering filesystem, publication, and orchestration tests remained green with one platform skip.

Opportunities deliberately skipped:

- `ReviewRun`, Pi attempt/reservation authority, the wide `RunDirHandle` port, and Pi extension shell decomposition remain the dedicated persisted/interface deepening migrations dispositioned above.
- `resumeWaveGateFacade` extraction remains rejected by ADR-0005; no shared computation was identified that belongs in an existing deep helper.
- The broad orchestration fixture builder remains rejected because it would hide materially different authority arrangements behind override bags.
