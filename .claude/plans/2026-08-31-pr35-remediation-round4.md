# PR #35 remediation — round 4

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Frozen head: `b80ee273b512f2af5101aced2b209c8260e7432a`
- Base/current `origin/main`: `3de455c2f1580c2429d52ae6e286650ec5727392`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260831T161544Z-19015`
- Authoritative result: `.claude/reviews/review-and-fix-runs/review-20260831T161544Z-19015/result.json`
- Exact reviewed scope: the 124 paths frozen in that result, including documentation.

## Mandatory surviving criticals

1. **`code-reviewer-1` — mixed Vitest summaries can preserve a stale pass.**
   - Replace independent Vitest pass/fail line recognition with one pure parser for the complete `Tests …` summary.
   - Treat any non-zero `failed` segment as failure, a non-zero `passed` segment without failures as pass, and skipped/zero-only summaries as zero-test evidence.
   - Add a property covering arbitrary non-zero mixed failures and an explicit pass-then-mixed-failure regression.

2. **`silent-failure-hunter-1` — `isTrackedAt` catches status 1 from two distinct operations.**
   - Interpret status 1 only inside the exact `ls-files --error-unmatch` call.
   - Keep shadow-authority discovery and every other failure in the typed unavailable arm.
   - Add a real fake-Git regression where `rev-parse` exits 1 and prove it is not reported as untracked.

3. **`comment-analyzer-1` — Run Directory identity comment overstates Linux guarantees.**
   - Document that each Linux operation is descriptor-anchored only after acquisition and that a pathname replacement between operations can redirect a later acquisition.

4. **`comment-analyzer-2` — phase-artifact fallback comment overstates unreadable-file fallback.**
   - State that fallback applies only when the recorded plan field is absent or names a missing file; all other access failures fail closed.

## Advisory dispositions

### Accepted

1. **`pr-test-analyzer-1` — linked-worktree shadow Git coverage.**
   - Sound and practical. Add a real `git worktree add` fixture proving the linked worktree index and common object store produce tracked diff and tracking evidence.

2. **`pr-test-analyzer-2` — SHA-256 shadow Git coverage.**
   - Sound and practical. Add a conditional real `git init --object-format=sha256` fixture and exercise diff/tracking through the shadow boundary.

3. **`type-design-analyzer-5` — passing `TestEvidence` permits empty evidence.**
   - Sound and local to the mandatory parser fix. Model `TestEvidence` as a readonly union whose `passed: true` arm carries parser-minted non-empty evidence; preserve the existing runtime wire shape.

4. **`code-simplifier-1` — duplicate Start/Stop hook parsers.**
   - Sound and complete in scope. Extract one event-labelled internal lifecycle-input parser while preserving both public wrappers, types, and exact diagnostics. Add parser parity tests.

5. **`code-simplifier-2` — reservation lookup nested ternary.**
   - Sound and local. Replace it with an exhaustive switch over `ReservationLookup.kind`.

6. **`code-simplifier-3` — patch-path trailing-tab nested ternary.**
   - Sound and local. Normalize the token with a guarded assignment.

7. **`code-simplifier-4` — duplicate refutation fixture builder.**
   - Sound and test-only. Delete the fixed-upheld wrapper and invoke the parameterized builder directly.

### Deferred

1. **`silent-failure-hunter-2` — shadow-directory cleanup can mask the primary failure.**
   - The claim is sound, but a complete change needs one tested resource-scope/error-composition contract rather than an untestable point catch around `rmSync`. Defer with the Run Directory close finding so both imperative shells use the same policy.

2. **`silent-failure-hunter-3` — anchored-directory close can mask primary failures.**
   - Sound but cross-cutting: at least ten close sites have different acquisition/operation shapes. Migrate them with the shared tested cleanup contract above rather than changing error identity and ordering piecemeal in this remediation.

3. **`type-design-analyzer-1` — `ReviewRun` legacy/exact ADT.**
   - Sound, but requires a persisted State File parser, migration, and all review lifecycle callers to change atomically.

4. **`type-design-analyzer-2` — `PiReviewAttemptAuthority` legacy/exact ADT.**
   - Sound, but requires a Pi wire-authority migration across capture and historical recovery, not a local remediation.

5. **`type-design-analyzer-3` — category-discriminated `ReservedSlot`.**
   - Sound, but changes reservation construction and settlement across implementation, reviewer, and spec-check lifecycles.

6. **`type-design-analyzer-4` — `WaveGateLifecycleEvidence` ordered-state ADT.**
   - Sound, but requires redesigning the persisted evidence projection and replay tests as one Lifecycle Machine migration.

7. **`architecture-tech-lead-1` — extract the Pi spawn transaction.**
   - Sound deepening, but the six-capability transaction and compensation protocol needs an explicit design and migration; it is not a bounded bug fix.

8. **`architecture-tech-lead-2` — inject Pi runtime configuration.**
   - Sound deepening, but changes the extension registration seam and import contract across Pi integration tests.

9. **`architecture-tech-lead-3` — delete the Context Packet pass-through.**
   - Sound under ADR-0007, but callers of the compatibility path include production and test files outside the frozen review scope. Perform it as a dedicated Public Surface migration rather than partially redirecting reviewed callers.

### Dismissed

None.

## Refuted-finding audit

No critical finding was refuted by the panel threshold. `silent-failure-hunter-1` was refuted by the security lens because current fixed `rev-parse` probes normally use status 128, but reproduction and intent upheld the broader catch-scope defect; it therefore survives and is mandatory. `comment-analyzer-2` was uncertain under the security lens because the implementation fails closed, but reproduction and intent upheld the documentation mismatch.

## Support paths outside frozen scope

Register these at remediation start:

- `.claude/plans/2026-08-31-pr35-remediation-round4.md`
- `engine/src/parsers/parse-subagent-lifecycle-input.ts`
- `engine/tests/parsers/parsers.test.ts`

## Validation

```bash
bun run --cwd engine typecheck
(
  cd engine
  env -u PI_CODING_AGENT bunx vitest run \
    tests/handlers/update-task-status.test.ts \
    tests/handlers/subagent-stop/update-task-status.property.test.ts \
    tests/pi-test-evidence.test.ts \
    tests/pi/subagent-result.test.ts \
    tests/utils/git.test.ts \
    tests/handlers/helpers/quality-programs.test.ts \
    tests/parsers/parsers.test.ts \
    tests/orchestration/publication-faults.test.ts \
    tests/handlers/helpers/orchestration.test.ts \
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
- Focused verdict, Pi evidence, Git authority, parser, publication, quality-program, and orchestration suites — **530 passed, 0 failures**.
- `bun run --cwd engine test:unit` — **230 files, 5972 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke` — panel mode 22/22, review panel 19/19, standalone review, all six façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check` — clean.

`PI_CODING_AGENT` was unset only for validation subprocesses so fresh Pi-aware fixtures did not inherit this live session's runtime handshake.

## Distill apply-mode receipt

Green baseline: the focused 530-test suite above.

Move applied:

1. Parsed the complete Vitest segment list into one all-valid immutable value before verdict classification, removing nullable members and repeated validation from the reducer. The 199 directly covering verdict/Pi tests stayed green.

Opportunities deliberately skipped:

- Cleanup error composition, persisted authority ADTs, Pi spawn/config seams, and Context Packet Public Surface deletion remain the dedicated deepening migrations dispositioned above.
- Further factoring of the two real Git repository fixtures would hide their materially different linked-worktree and object-format setup.
- The Start/Stop public wrappers remain intentionally separate: callers keep event-specific names and diagnostics while the shared internal parser owns all duplicated mechanics.
