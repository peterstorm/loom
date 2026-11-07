# ADR-0057: Contract Revision refreshes only untouched skeletons

## Status
Accepted (2026-11-07). Shipped on branch `feat/g2-skeletons` (plan
`.claude/plans/2026-11-02-g2-skeletons.md`, AD-10; spec FR-033, AS-049, AS-050, AS-051, OOS-008; interview Q16d).

## Context
G2 has the engine write signature skeletons at the bound paths of implementation Tasks, and contract stubs
at the contract Task's stop. Each skeleton is generated from one Acceptance Contract's frozen types file and
recorded with the digest of the bytes the engine wrote (ADR-0051). After the freeze, an operator Contract
Revision (`helper revise-contract`) is the one sanctioned way frozen types change. It re-stamps the edited
frozen bytes and sends the current Wave's implemented claimants back to revalidation.

A revision therefore leaves every skeleton of that contract generated from a surface that no longer exists.
Some of those files are still exactly what the engine wrote: no implementer has started on them. Others
already hold implementer work, from a few edits to a finished module. The revised surface may also no
longer declare an alias a binding names, or may declare it as something other than a function type.

The forces pull in different directions:

- **Do not destroy work.** A revision must never overwrite bytes an implementer wrote (Q16d). This is the
  same no-clobber promise the spawn writer makes (FR-011).
- **Do not mislead.** An implementer spawned after the revision must not start from signatures the frozen
  types no longer declare. A skeleton left on the old surface would pass for current, and completion would
  then refuse it against the revised surface.
- **Make divergence visible.** A modified skeleton that now disagrees with the revised types has to be named
  in status and the brief (FR-040), not discovered at completion.
- **Keep revision semantics.** Acceptance Freeze and Contract Revision semantics stay as they are, apart from
  re-validating bindings and refreshing untouched skeletons (OOS-008). A refused revision must touch nothing.
- **Partial failure.** The file writes and the locked State File update cannot be one atomic step.

## Options Considered

1. **Regenerate every skeleton of the revised contract**
   - Pros: After the revision, every bound file matches the revised surface. One code path, with no
     need to tell untouched files from modified ones.
   - Cons: Overwrites implementer work, which Q16d rules out. It breaks the writer's no-clobber
     invariant, so the revision would need a second, unguarded writer. An operator fixing one alias
     could wipe a Wave's worth of implementation.

2. **Leave every skeleton as it is and only re-stamp the types**
   - Pros: Never destroys work, adds no new write path, and changes revision semantics least.
   - Cons: Untouched skeletons keep the old signatures, so implementers spawned later start against a
     surface that no longer exists. Their completion is then refused as `retyped` or `deleted` for
     bytes they never chose. Modified skeletons drift silently, and status has nothing to show.

3. **Refresh untouched skeletons, flag modified ones stale, and name binding problems (chosen)**
   - Pros: No implementer work is ever overwritten, and every file no one has touched follows the revised
     surface. Divergence is recorded per file (`stale: { revision }`) and shown in status and the brief.
     It reuses the content-addressed predicate (INV-4) and the writer's digest-guarded replace (INV-3),
     so neither rule gains a second copy.
   - Cons: A modified skeleton is left for a human to reconcile with the revised surface. The revision
     handler gains a write phase that runs before the lock, so a partial outcome is possible and has to be
     made safe.

4. **Merge the revised signatures into modified skeletons**
   - Pros: Would carry the new surface into in-progress files as well.
   - Cons: Needs a TypeScript and Java source rewriter, well beyond the syntactic reader and generator
     G2 ships (AD-6, AD-7, AD-8). A wrong merge destroys work as surely as a regeneration, and it is
     harder to see. Rejected without being prototyped.

## Decision
**After a revision is known to be admissible, the handler re-resolves the contract's bindings against the
revised types file. It regenerates each untouched skeleton through the writer's guarded replace and flags
each modified one `stale: { revision }`. Every resolution problem is named in the outcome, and the next
spawn's stage two blocks on it. The writes happen before the locked update.**

### Shell: `engine/src/handlers/helpers/revise-contract.ts`

`createReviseContractHandler` runs these steps in order:

1. **Observe.** Read the frozen digests before the lock, as before.
2. **Check admissibility.** Run `reviseAcceptanceContract` once without skeletons. A revision it refuses
   returns at this step and writes no skeleton.
3. **Refresh.** `refreshRevisedSkeletons(root, graph, contractId)` does the skeleton work:
   - It takes the contract's stamped `export_bindings` and its `skeletons` records. With neither, the
     result is `NO_SKELETON_REVISION`.
   - `canonicalContractSkeletons` resolves the bindings against the revised types file on disk (stage two)
     and generates the canonical bytes for each binding that resolves. Each problem, such as a vanished or
     retyped alias, is collected as a `SkeletonProblem`.
   - `observeSkeletonPaths` reads each recorded path as a `PathObservation` (`absent`, or `present` with the
     current and canonical digests).
   - The pure `planSkeletonRevision(records, observations, skeletons)` assigns one action per record:
     - **absent**: nothing. The next registration regenerates the file (FR-032).
     - **modified** (`isUntouchedSkeleton` is false): `stale`. The bytes stay as they are.
     - **untouched**, and the bytes already equal the revised canonical bytes: `re-record`.
     - **untouched**, with a revised skeleton available: `refresh`, with `expectedSha256` set to the
       current digest.
     - **untouched**, but the binding no longer resolves: nothing. The binding problem carries the cause.
   - A `refresh` calls `refreshSkeleton(root, path, expectedSha256, bytes, frozen)`
     (`engine/src/orchestration/skeleton-writer.ts`). It replaces the file only while its bytes still digest
     to `expectedSha256`, by renaming a prepared temp file over the target. Otherwise it refuses with
     `modified`, `absent` or `not-a-regular-file`. A `modified` refusal means the file was edited between
     observation and write, so it is treated like any modified file: its path joins `modified` and its
     record is flagged `stale: { revision }` in the same commit. Any other refusal becomes a
     `SkeletonProblem`. Frozen paths and symlinked ancestors are refused as they are for every writer entry
     point.
   - The function returns a `SkeletonRevision { refreshed: SkeletonRecord[]; modified: string[];
     bindingProblems: SkeletonProblem[] }`. It writes files but commits nothing.
4. **Commit.** `manager.updateAndReturn` runs `reviseAcceptanceContract(locked, request, observations,
   skeletons)`, which decides admissibility again under the lock.
5. **Report.** `revisionOutcomeMessage` writes the revision line to stderr, then one line per item:
   - `skeleton refreshed <path> from the revised types`;
   - `skeleton <path>: stale against revised contract (modified, left as it is)`;
   - `skeleton binding problem: … ; the next spawn's stage two blocks on it`.

### Core: `engine/src/core/contract-revision.ts`

`reviseAcceptanceContract` takes the `SkeletonRevision` as an optional argument, defaulting to
`NO_SKELETON_REVISION`, and commits it in the same graph update as the revision:

- `revisedSkeletonRecords` sets `stale: { revision }` on the record of each modified path.
  `installSkeletonRecords` then installs the refreshed records (`origin: "revision"`, the new `engineSha256`
  and `typesSha256`, `stale: null`), keeping one record per path in path order.
- The `RevisedContract` outcome gains `refreshed`, `staleSkeletons` and `bindingProblems`.
- Nothing else about a revision changes (OOS-008).

### Invariants honored

- **INV-3 (one writer).** Every skeleton byte is written through `skeleton-writer.ts`. The revision uses only
  the digest-guarded `refreshSkeleton`, never an unguarded write.
- **INV-4 (one recognition rule).** "Untouched" is decided only by `isUntouchedSkeleton` in
  `engine/src/core/skeleton/outcomes.ts`. The current bytes equal either the recorded `engineSha256` or the
  canonical bytes for the current surface.
- **Ordering.** Writes come first, then the locked update. If the update is refused, or the process crashes
  after a refresh, the file holds canonical bytes for the revised surface. Content-addressed recognition
  (ADR-0051) adopts them on the next materialization rather than reporting `exists, not skeletonized`.
- **Stage two still blocks (AS-051).** The revision does not drop or rewrite a binding whose alias vanished.
  The stamp is unchanged, so the next spawn's stage two re-resolves it against the revised types and blocks,
  naming the missing alias. The skeleton-bindings-unresolved blocker in status shows the same problem.
- **Visibility (FR-040).** `engine/src/core/skeleton/status.ts` renders a stale record as
  `stale against revised contract <CT> (revision <n>)`, and both status and the brief show it.

## Consequences

**Positive:**
- A revision can never destroy implementer work. The guarded replace re-checks the digest when it writes,
  so even a file edited between observation and write is refused, not overwritten, and its record is flagged
  stale.
- Implementers spawned after a revision start from the revised signatures whenever no one has touched the
  file (AS-049). This avoids completion refusals for signatures they never chose.
- Divergence is recorded per file with the revision number that caused it (AS-050). Operators see in status
  and the brief which modified files must be reconciled, before the Wave Gate.
- No new rules. Recognition, writing, stage two and status reuse their single owners, and the revision only
  adds a pure planner (`planSkeletonRevision`) and one shell step.
- Re-running a revision is idempotent. An untouched file already holding the revised canonical bytes is only
  re-recorded, with zero bytes changed.

**Negative:**
- A stale skeleton stays stale until a human reconciles it. The engine neither merges nor regenerates it, and
  completion then judges it against the revised surface.
- The revision handler now writes repository files before its locked update. A refused update or a crash
  leaves refreshed bytes with old records. Recognition by content makes this safe, but it relies on the
  generator staying deterministic (AD-8, ADR-0055).
- An untouched skeleton whose binding no longer resolves keeps its old bytes until the binding problem is
  fixed, by a further revision or by re-population. Spawns of that Task are blocked in the meantime.
- A refresh refused at write time for any reason other than a concurrent edit (`absent`,
  `not-a-regular-file`, or an I/O failure) is reported only as a binding problem in the outcome. The record
  keeps its old digest until the next observation decides it. A concurrent edit (`modified`) is flagged stale
  at once.
- A revision of a contract with many bound paths does more I/O than before: one observation and possibly one
  write per recorded skeleton.
