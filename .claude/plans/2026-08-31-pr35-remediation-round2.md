# PR #35 remediation — fresh consolidated-head review

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- PR: [#35](https://github.com/peterstorm/loom/pull/35)
- Reviewed head: `50703be8d017ecbde265764d88cb3f2e5973ed1e`
- Base: `origin/main` at `3de455c2f1580c2429d52ae6e286650ec5727392`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260831T140305Z-29438`
- Frozen exact scope: the 122 paths recorded in that run's authoritative `result.json` `scope` array.
- Review totals: 7 reviewers emitted 5 critical and 8 advisory Findings. A three-lens Refutation Panel unanimously upheld all 5 criticals; none were refuted.

## Mandatory surviving criticals

1. `code-reviewer-1` — Review Packet diff collection can execute repository-controlled textconv or external diff drivers.
   - Move packet artifact diffs onto the single hardened Git diff execution boundary in `engine/src/utils/git.ts`.
   - Tracked packet diffs must include `--no-textconv`, `--no-ext-diff`, `--binary`, `--end-of-options`, and a path separator. Untracked packet diffs must preserve patch-only exit-1 acceptance and place an option-shaped path after `--`.
   - Run diff children with a restricted, non-interactive Git environment rather than inherited Git authority.
   - Add real Review Packet CLI regressions proving configured textconv/external drivers never execute while packet patches remain complete.
2. `silent-failure-hunter-1` — `dispatch` resolves derived routing before its capture/cleanup failure boundary, so metadata filesystem faults can skip settlement.
   - Run request-bound capture before derived routing, then catch routing/sidecar observation faults, invoke cleanup, and return one explicit combined error.
   - Make cleanup's own optional reported-agent-type observation fault-tolerant so it still attempts binding, sidecar, pointer, and roster release and reports the observation fault.
   - Add a real ENOTDIR metadata-lookup regression proving the dispatcher invokes cleanup and fails explicitly rather than throwing past the boundary.
3. `comment-analyzer-1` — `run-directory-handle.ts` overstates Darwin immutable writes as descriptor-anchored.
   - State the Linux descriptor guarantee and Darwin proven-path/accepted post-acquisition swap limitation explicitly.
4. `comment-analyzer-2` — `openDirectoryNoFollow` says the Darwin path is safe for child addressing despite the documented swap risk.
   - Replace the absolute guarantee with the exact acquisition-time no-symlink guarantee and post-acquisition caveat.
5. `comment-analyzer-3` — `publishStagedRunFile` says neither name can be redirected on Darwin.
   - Qualify the guarantee by platform: retained-descriptor addressing on Linux; proven pathname and accepted swap risk on Darwin.

## Advisory dispositions

### Accepted

1. `code-simplifier-2` — `contextDigestOf` duplicates `digestOf`'s SHA-256 byte hashing expression.
   - Reuse `digestOf(bytes)` and apply the `ContextDigest` parser/brand once. This is local, behavior-preserving, and reduces the cryptographic expression to one home.

### Deferred

1. `type-design-analyzer-1` — splitting legacy and engine-owned `ReviewRun` into ADT arms remains sound, but requires persisted migration and every review-run reducer to move together.
2. `type-design-analyzer-2` — category-discriminated `ReservedSlot` is a Pi adapter migration spanning constructors, parsing, and settlement.
3. `architecture-tech-lead-1` — snapshotting every Wave readiness observation before the StateManager commit needs a compare-and-swap protocol, not an inline closure tweak.
4. `architecture-tech-lead-2` — duplicates `type-design-analyzer-2`; it is deferred under the same category-ADT migration.
5. `architecture-tech-lead-3` — replacing Wave Gate WeakSet proof capabilities requires a deliberate structural proof-authority redesign across construction and recovery.
6. `code-simplifier-1` — decomposing the 636-line Wave Gate facade is worthwhile but is a lifecycle-module refactor broader than these correctness fixes and must preserve engine-owned recovery sequencing as one dedicated `deepen` change.

### Dismissed

1. `code-simplifier-3` — extracting four tiny test-only patch fixture builders would couple unrelated suites through a helper without reducing production complexity or representable states; local fixtures make each test's evidence shape explicit.

## Refuted-finding audit

No critical Finding was refuted. Every mandatory Finding was upheld by reproduction, intent, and blast-radius.

## Support paths outside frozen review scope

The registered remediation must authorize:

- `.claude/plans/2026-08-31-pr35-remediation-round2.md`

All production and regression-test paths selected above are already inside the frozen 122-path scope.

## Validation

```bash
bun run --cwd engine typecheck
(cd engine && env -u PI_CODING_AGENT bunx vitest run \
  tests/handlers/helpers/quality-programs.test.ts \
  tests/handlers/subagent-stop/dispatch-resilience.test.ts \
  tests/handlers/subagent-stop/cleanup-subagent-flag.test.ts \
  tests/utils/git.test.ts \
  tests/orchestration/no-follow-fs.test.ts \
  --testTimeout=120000 --maxWorkers=4)
bun run --cwd engine test:unit
env -u PI_CODING_AGENT bun run --cwd engine test:smoke
git diff --check
```

## Validation receipt

Validated against the remediated working tree:

- `bun run --cwd engine typecheck` — clean, including unused locals and parameters.
- Focused Git/Review Packet, dispatch, cleanup, and no-follow suites — **172 passed, 1 platform skip, 0 failures**.
- `bun run --cwd engine test:unit` — **230 files, 5941 passed, 1 platform skip, 0 failures**.
- `env -u PI_CODING_AGENT bun run --cwd engine test:smoke` — panel mode 22/22, review panel 19/19, standalone review, all six façade scenarios, Pi resources, and TaskGraph validation 23/23 passed.
- `git diff --check` — clean.

`PI_CODING_AGENT` was unset only for validation subprocesses so fixtures did not inherit this live Pi session's runtime handshake.

## Distill apply-mode receipt

Green baseline: the focused 172-test suite above.

Moves applied:

1. Reused one hardened Git diff executor for existing test-evidence diffs and new Review Packet binary diffs, deleting the packet helper's duplicate status-1 parser and driver-execution policy.
2. Reused `digestOf` inside `contextDigestOf`, leaving one SHA-256 byte expression.
3. Flattened diff-failure diagnostic selection rather than introducing a nested ternary.

Skipped opportunities:

- The `ReviewRun` ADT, `ReservedSlot` ADT, Wave observation snapshot/CAS, WeakSet proof redesign, and Wave facade decomposition all change interfaces or lifecycle seams and remain the dedicated `deepen` work recorded above.
- Cross-suite patch-fixture extraction was dismissed because it adds test coupling without reducing production concepts.
- The Result-to-throw `requiredDiff` translation remains: it is the shell's intentional conversion from typed adapter failure to the helper's established exception boundary, not a pass-through abstraction.
