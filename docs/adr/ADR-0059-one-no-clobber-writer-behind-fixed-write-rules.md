# ADR-0059: One no-clobber writer behind fixed write rules

## Status
Accepted (2026-11-07). Shipped by the G2 skeletons run (plan `.claude/plans/2026-11-02-g2-skeletons.md`, AD-12;
interview Q9a, Q11a, Q4a; owner of INV-3). Related: ADR-0048 (skeletons materialize per Task inside the shared
spawn reservation) and ADR-0055 (canonical skeleton bytes are deterministic and unformatted).

## Context
With G2, the engine writes source files into the user's repository for the first time. Earlier, everything it
wrote lived under `.loom/` or `.claude/`. Three entry points now write into the source tree:

- **Spawn.** `skeleton-materialization.ts` writes a spawning Task's missing skeletons inside the spawn
  reservation. It also refreshes untouched skeletons whose frozen surface has changed.
- **Contract stop.** `contract-stub-materialization.ts` writes and refreshes contract stubs when the contract
  Task stops.
- **Contract Revision.** `skeleton-revision.ts`, run by `revise-contract.ts`, refreshes untouched skeletons after
  an operator revises a types file.

Every one of these writes must obey the same safety promises:

- The engine never modifies a file that already exists (FR-011).
- It never writes outside the repository root or to an unsafe path (NFR-010).
- It never writes a frozen path, meaning a types file or an acceptance test (NFR-011).
- A failure part-way through never leaves a partially written file (NFR-021).
- A retry keeps whatever is on disk (FR-032).
- Every expected failure is reported as an outcome, never as a crash (FR-045).

These writes run while sibling Agents may be working in the same worktree. A file can therefore appear, change,
or have an ancestor swapped for a symlink between any check and the write itself. A plain "exists? then write"
check is not enough.

The rules are also the riskiest code G2 adds. If one entry point clobbers a hand-edited file or follows a
symlink out of the repository, the user loses work or the engine writes outside the checkout. The plan makes
the owned invariants mutation-verified (INV-3, with a matrix test). That proof is only cheap if the rule exists
in exactly one place.

## Options Considered

1. **One writer module with two operations, `createSkeleton` and `refreshSkeleton`, and the rules inside it (chosen)**
   - Pros:
     - The safety rules are written, tested and mutation-verified once, in
       `engine/tests/orchestration/skeleton-writer.matrix.test.ts` and `skeleton-writer.test.ts`.
     - All three callers get the same refusals and the same atomicity for free.
     - Results are a closed union, so each caller has to handle `exists`, `refused` and `io-failed`
       explicitly.
     - It reuses the anchored no-follow primitives in `no-follow-fs.ts` that the engine already trusts for its
       own state files.
   - Cons:
     - Callers depend on one module, which concentrates risk there.
     - The API is fixed at two operations, so any new kind of write (delete, rename) has to be added to the
       writer rather than written at the call site.
     - INV-3 is `advisory`: no lint rule stops a future module from calling `writeFileSync` on a source path.
       Review and the matrix enforce it.

2. **`writeFileSync` (or `writeFileSync` with `flag: "wx"`) at each call site**
   - Pros:
     - Fewest lines, no new module.
     - `wx` alone gives create-only semantics.
   - Cons:
     - Three copies of the safety rules (path canonicality, frozen-path check, symlinked-ancestor walk,
       digest-guarded refresh), which can drift apart.
     - `wx` follows symlinked ancestors and writes in place, so a crash can leave a truncated file and break
       NFR-021.
     - Mutation-verifying one site proves nothing about the other two.

3. **A shared validation helper, with each call site doing its own I/O**
   - Pros:
     - Path and frozen-path refusals live in one place.
     - Each caller keeps control of its own write.
   - Cons:
     - The rules that matter most (no-follow, link-not-overwrite, digest-before-rename, cleaning up the
       temporary name) are I/O rules, not path rules, so they would still be copied three times.
     - Validating first and writing later is exactly the check-then-act gap this decision exists to close.

## Decision
**`engine/src/orchestration/skeleton-writer.ts` is the only module that puts engine bytes into a repository
source file. It exports `createSkeleton(root, path, bytes, frozen)` and
`refreshSkeleton(root, path, expectedSha256, bytes, frozen)`. Both apply the same fixed write rules and return a
closed result union.**

- **Result type.** `SkeletonWriteResult = written{sha256} | exists | refused{reason} | io-failed{message}`. The
  refusal reasons form a closed union, `SkeletonWriteRefusal`:
  - `not-repo-relative`
  - `frozen-path`
  - `symlinked-ancestor`
  - `not-a-regular-file`
  - `absent`
  - `modified`

  The writer never throws to its callers. Any operating-system error becomes `io-failed` with the OS message.
  There is no retry (Q4a): a failure is reported and a later run completes the rest (NFR-021, FR-032).
  `renderSkeletonWriteResult` turns a result into a one-line diagnostic for refusal output.
- **Shared rules (`guarded`).** These run in order, before any byte is written:
  1. The path must be canonical and repository-relative: forward slashes, matching `normalizePlanPath`, not
     absolute, no drive letter, no empty, `.` or `..` segment. Otherwise `not-repo-relative` (NFR-010).
  2. The path must not equal any normalized path in `frozen`, the set of paths covered by the Acceptance
     Freeze. Otherwise `frozen-path` (NFR-011).
  3. The repository root is resolved, then every ancestor below it is checked with `lstat`, following no link.
     A symlinked ancestor is `symlinked-ancestor`. A missing ancestor means everything below it is absent and
     will be created.
  4. The parent directory is opened one component at a time through the anchored no-follow primitives
     (`openDirectoryNoFollow`, `openChildDirectoryNoFollow`). Missing directories are created on the way, and
     an `EEXIST` from `mkdir` is tolerated because the directory is then opened no-follow. A component swapped
     for a link after the walk therefore makes the write fail rather than redirect it.
- **Create (FR-011).** Any existing leaf, of any kind, is `exists`. Otherwise:
  - The bytes go to a prepared, uniquely named file (`.<leaf>.loom-skeleton-<pid>-<time>-<rand>`) in the
    anchored parent, with mode `0644`.
  - The prepared file is published with `link(prepared, target)`. `link` never overwrites, so a file that
    appeared after the walk returns `EEXIST`, which `linkFailureResult` maps to `exists`.
  - The prepared name is removed whatever happens. If only that removal fails after the link published the
    bytes, the result stays `written` and names the prepared name left behind (`leftover`); after any other
    result it is `io-failed`, naming both.
- **Refresh.** A missing leaf is refused as `absent`, and a non-regular leaf as `not-a-regular-file`. Otherwise:
  - The replacement is prepared first: the bytes go to a prepared name beside the target, with mode `0644`.
  - Only then are the current bytes read no-follow through the anchored parent and digested, immediately
    before the publish.
  - If the digest is not `expectedSha256`, the result is `modified`. That digest is the engine's own recorded
    skeleton digest (ADR-0055), so a file a human or Agent has touched is never replaced, including one
    touched while the replacement was being prepared.
  - On a match, `rename(prepared, target)` publishes the bytes. The prepared name is removed as for create,
    with one difference: a `modified` refusal whose prepared name cannot be removed stays `modified`,
    naming the prepared name left behind (`leftover`), so the Contract Revision still settles the path stale
    (ADR-0057) instead of reporting a write failure.
- **Leftovers are notes.** `writePlanned` carries a `written` result's leftover with the record it leaves
  (`PlannedWrite.recorded.leftover`), and every caller surfaces it without blocking: registration prints
  `[loom] skeleton note: …` on stderr, the contract stop adds a `note:` line to its stop note, and the
  revision lists it in its outcome as `skeleton note: …` (`renderLeftPreparedName`).
- **Atomicity (NFR-021).** Bytes only ever appear under the target name through one `link` or one `rename`, so
  each file is either complete or absent.
- **Ownership (INV-3).** The writer is the owner module. Its sibling entry points are
  `skeleton-materialization.ts`, `contract-stub-materialization.ts` and `skeleton-revision.ts` (run by
  `revise-contract.ts`), all through `writePlanned` in `skeleton-refresh.ts`. They call only
  these two functions and contain no `writeFileSync`, `renameSync` or `linkSync` on a skeleton path. Each
  caller decides create versus refresh from its pure plan (the skeleton record and its `expectedSha256`) and
  turns the result into its own outcome.

## Consequences

**Positive:**
- The never-clobber, never-frozen and never-outside-the-repo rules are proven once, and the INV-3 matrix covers
  every sibling entry point. A mutation in the writer fails the matrix instead of slipping through one of three
  hand-written copies.
- Concurrent sibling Agents cannot cause a clobber. A file that appears during registration is reported as
  `exists`, and a symlink swapped in after the walk fails the anchored open rather than redirecting the write.
- A crash or I/O error never leaves a truncated skeleton. A re-run regenerates only what is missing (FR-032),
  and each failure reaches the operator as a typed outcome (FR-045).
- The closed result union makes callers handle each case, and gives status and refusal diagnostics one shared
  wording.

**Negative:**
- Refresh compares the digest and then renames, as two steps; POSIX has no compare-and-rename. The guard is
  placed as late as it can be (after the replacement is prepared, right before the rename), so the window
  that remains is the interval between the digest read returning and the rename taking effect, with no I/O
  in it but the rename itself. An edit that lands exactly there (in place or by replacing the name) would be
  overwritten. This is accepted because a refresh only targets files whose bytes still equal the engine's
  own output. Closing it would need an atomic exchange (`renameat2(RENAME_EXCHANGE)`) with a verified swap
  back, which Node does not expose, or file locking the engine does not use for source files.
- INV-3 is advisory. Nothing mechanical prevents a future module from writing a source file directly. The rule
  is kept by review, by this ADR and by the module's header comment.
- No retry means a transient I/O error, for example a full disk, makes the user run the step again rather than
  having the engine recover on its own.
- The no-follow walk refuses any symlinked ancestor, including legitimate in-repo symlinked directories that
  some monorepos use. Bindings under such directories cannot be skeletoned and surface as
  `symlinked-ancestor`.
- Create leaves a `0644` file and new directories with `0755`. It does not inherit or copy the permissions of
  neighbouring files.
