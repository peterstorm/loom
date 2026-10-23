# ADR-0038: Isolation via one detached worktree per Invariant

## Status
Accepted (2026-10-23). Shipped with the G5b owner-enforcement feature
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, FR-015, FR-016, SC-004; plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-8; interview Q2c, Q2d, Q3a).

## Context
G5b's owner verification proves that an owned Invariant's matrix test kills mutants of its owner module. Doing
that means rewriting the owner file up to 24 times per Invariant and running the matrix test against each
rewrite. The Wave Gate runs this against the reviewed workspace: HEAD plus the Wave's uncommitted changes,
untracked files and deletions. If a mutant were written into that workspace, a crash, timeout or killed
process could leave mutated bytes in the code under review. Even a clean restore would invalidate the
workspace digest the completion suite is keyed on. FR-015 requires every mutant to run in an isolated copy
and the real workspace to stay byte-identical. SC-004 makes that observable.

The isolated copy has to be exact. A copy that loses uncommitted Wave work tests the wrong bytes. It also has to
be cheap enough to set up once per owed Invariant on every Wave Gate. And it has to be able to run the
project's test command. For TypeScript projects that means reaching `node_modules`, which can be very large
and must never be written through.

The mutation run also needs a command. The operator already freezes an `affectedRunner` in the schema-2
verification manifest (`.loom/verification-manifest.json`), which writes a JUnit report and runs inside
process-group containment. Adding a second runner key, or taking command text from the plan, would widen the
trust surface. The manifest is operator-frozen precisely so that plans cannot choose commands.

## Options Considered

1. **One detached `git worktree` per Invariant, overlaid with the reviewed workspace's uncommitted state, `node_modules` symlinked (chosen)**
   - Pros: the worktree shares the repository's object store, so a checkout is cheap and exact at HEAD. The
     overlay comes from `git status --porcelain=v2 -z --untracked-files=all`, so changed, untracked-not-ignored
     and deleted paths all match what is under review. One worktree per Invariant spreads the setup cost over
     the baseline and all mutants. Symlinking `node_modules` avoids copying dependencies.
   - Cons: it depends on `git worktree` and writes worktree registration into the shared `.git` admin
     directory. A crash between add and remove can leave a stale registration until the next
     `git worktree prune`. Ignored files other than `node_modules` (local build outputs, generated code,
     `.env`) are not carried over. The symlinked `node_modules` is shared and writable at the filesystem
     level, so isolation of dependencies relies on test runners not writing there.

2. **Full `cp -r` of the repository into a temp directory**
   - Pros: there is no dependency on Git worktree mechanics, and ignored files come along too.
   - Cons: it is slow, and it copies `node_modules` and build caches, which can be gigabytes. It also copies
     whatever junk is in the tree. The cost is paid per Invariant on every gate.

3. **A temp directory of tracked files only (`git archive` / checkout of HEAD)**
   - Pros: it is cheap and deterministic.
   - Cons: it loses the Wave's uncommitted work, which is exactly what is being verified. Mutants would be
     tested against the wrong owner and the wrong matrix test. Rejected outright.

4. **Mutate in place in the real workspace and restore afterwards**
   - Pros: there is no copy at all, and it is the fastest option.
   - Cons: it directly violates FR-015. A crash or kill mid-mutant leaves mutated code under review. It also
     races any parallel writer. Not viable.

5. **A dedicated `mutationRunner` key in the verification manifest** (for the command axis, not the copy axis)
   - Pros: the mutation command could be tuned separately from affected-test selection.
   - Cons: it is a manifest schema change with no gain, because the frozen `affectedRunner`, given one file,
     already runs exactly the matrix test (interview Q3a). Rejected.

## Decision
**Each owed, non-exempt Invariant's baseline and mutants run in one detached `git worktree` of HEAD. The worktree
is overlaid with the reviewed workspace's uncommitted state and has `node_modules` shared by symlink. Commands
run through the frozen `affectedRunner`, and the real workspace digest is checked before and after.**

**Workspace shell: `engine/src/orchestration/owner-mutation-workspace.ts`**, entry point `withMutationWorkspace(spec, use)`:
- `open` makes a directory with `mkdtemp` under the OS temp dir (`loom-owner-mutation-*`), outside the
  repository. It then runs `git worktree add --detach <dir> HEAD`.
- `overlay` lists every path from `git status --porcelain=v2 -z --untracked-files=all` and makes that path
  in the worktree match the real workspace. It copies the file's bytes, recreates a symlink, copies a
  directory, or deletes a path that the real workspace deleted.
- `shareNodeModules` symlinks `node_modules` for the repository root and for the runner's `cwd`, when those
  directories exist in the real workspace and not in the worktree. It records the links it creates so they
  can be unlinked without being followed.
- `runWithOwner(ownerText, execute)` handles one run. It deletes the runner's report path, so a stale report
  cannot vouch for this run. It writes the mutant over the owner file when `ownerText` is non-null, runs
  `execute`, and restores the owner's original bytes in `finally`. The owner file is the only file it
  rewrites.
- `remove` handles teardown. It unlinks the `node_modules` links, then runs
  `git worktree remove --force <dir>`, removes the directory, and runs `git worktree prune`. This runs after
  `use` on both paths, success and throw.
- Failures to set up the worktree (mkdtemp, worktree add, overlay, link, non-canonical root) are returned as
  the typed infrastructure failure `worktree-failed`, and `use` never runs on them. A failure to remove the
  worktree after a successful `use` is also returned as `worktree-failed`. If `use` throws, the worktree is
  removed and the throw is rethrown. When that removal fails too, the rethrown error's message names both the
  throw and the cleanup leftover, and carries the original throw as its `cause`, so a leaked worktree is
  always diagnosable.

**Runner shell: `engine/src/orchestration/owner-verification-runner.ts`**, entry point `runOwnerVerification(input)`:
- If any owed obligation is non-exempt and `manifest.affectedRunner` is undefined, the result is
  `unavailable` with `runner-missing`. Population also refuses such a plan up front, with
  `owner-verification-runner-missing` in `engine/src/core/task-graph-population.ts`, next to the contract
  JUnit refusal.
- `observeWorkspace()` is called before the first obligation and again after the last. The suite helper
  binds it to `observeCurrentWaveWorkspace`. If either observation fails or throws, or the two digests
  differ, the result is `unavailable` with `real-workspace-changed` (SC-004).
- It never throws, by construction. Repository reads are total: `readRepositoryText` returns a file the
  filesystem refuses as the `repository-file-unreadable` failure, never as absence and never as a throw. The
  obligation runs are guarded between the two digest observations, so a step that throws anyway becomes
  `unavailable` with `unexpected-error` and the after-run digest is still compared (a changed workspace
  outranks it). An outermost guard turns anything else into `unexpected-error`; it can only fire before the
  first observation or after the comparison, when no run is left unchecked.
- The command for each obligation is `matrixTestCommand`. It is built by `affectedRunnerCheck(runner,
  [matrixTest])`, with the validated repo-relative matrix test as the only file, and re-authorized with its
  timeout clamped by `mutantTimeoutMs`. No command text ever comes from the plan.
- Each run goes through `runProjectCommandAt(check, worktreeRoot)` in
  `engine/src/orchestration/completion-check-runner.ts`. That is the Wave check's process-group runner,
  exported in a form that takes the repository root. The command's `cwd` and report path therefore resolve
  inside the worktree.
- `runPlan` runs the baseline unmutated first. Only when the baseline is green does it run each mutant in
  plan order. The first infrastructure outcome ends the run for that Invariant.
- `mutationEvidence` wraps `withMutationWorkspace` in a `try`. A throw from inside the worktree, such as a
  failed owner restore, becomes that Invariant's `worktree-failed` verdict. It never counts as a kill.

**Suite boundary: `engine/src/handlers/helpers/wave-completion-suite.ts`**, function `ownerVerificationObservation`:
- It calls `runOwnerVerification` through the injectable `RunOwnerVerification` port.
- It keeps a last-resort `try/catch` for the injected port. Any throw becomes `unavailable` with
  `unexpected-error` ("owner verification threw before it decided: ..."). That blocks the Wave Gate as
  infrastructure (FR-016). The workspace check is not skipped on that path: `runSuiteChecks` compares the
  workspace digest after every check, the owner check included.

The operator-facing description, the `worktree-failed`, `real-workspace-changed`, `repository-file-unreadable` and
`unexpected-error` remedies, and the
prerequisite runner are documented in `docs/operations.md` under "Owner verification blocks a Wave Gate (G5b)".
Behavior is covered by `engine/tests/orchestration/owner-mutation-workspace.test.ts` (AS-016, AS-017) and
`engine/tests/orchestration/owner-verification-runner.test.ts`.

## Consequences

**Positive:**
- Mutants never touch the real workspace. The before/after digest proves this on every run instead of
  assuming it, and a violation blocks rather than passing silently.
- The copy is exact for the Git-visible state under review, including deletions and untracked files. Coverage
  and mutation therefore judge the Wave's bytes, not HEAD's.
- Setup is cheap. The shared object store means a checkout and not a clone, `node_modules` is not copied, and
  one worktree serves the baseline and up to 24 mutants of an Invariant.
- The trust surface does not grow. The command is the operator-frozen `affectedRunner` under the same
  process-group containment as other Wave checks, with no manifest schema change and no plan-sourced
  command text.
- Every isolation failure is a named, typed infrastructure failure with a documented remedy. None of them
  can be mistaken for a kill.

**Negative:**
- The first shipped runner kept "never throws" only as a doc comment: `readRepositoryText` rethrew unexpected
  fs errors from `coverage` and `planMutation`, the suite helper recorded the throw as `worktree-failed` (a
  misnomer outside the worktree), and on that path the runner's after-digest check never ran; a cleanup
  leftover after a throwing `use` was discarded. The G5b cleanup pass closed all three (see the runner shell
  above). What remains: `unexpected-error` is deliberately coarse. It names the step and the error but does
  not tell an engine defect from an unanticipated exception; the detail carries the difference.
- Isolation covers only Git-visible state. Ignored files other than `node_modules` (generated sources, local
  config, build output) are missing from the worktree. A matrix test that depends on them fails its
  baseline there, and this shows up as a red baseline or a runner failure, not as an isolation diagnostic.
  The digest check observes the same Git-visible state, so writes to ignored paths in the real workspace are
  outside what SC-004 proves.
- The `node_modules` symlinks are read-only by convention, not by permission. A test runner that writes into
  `node_modules` (cache directories, for example) writes through to the real workspace's dependencies.
- Mutation cost scales linearly. Each owed Invariant runs (1 baseline + up to 24 mutants) × the per-run limit
  in series, and there is no parallelism across Invariants or mutants.
- The feature depends on `git worktree` being available. It also briefly adds a registration under the
  shared `.git`, which an operator inspecting `git worktree list` mid-gate will see.
