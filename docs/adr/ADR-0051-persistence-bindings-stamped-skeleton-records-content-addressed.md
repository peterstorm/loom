# ADR-0051: Export bindings are stamped at population, skeleton records carry engine digests, and an untouched skeleton is recognized by content

## Status
Accepted (2026-11-07). Shipped on branch `feat/g2-skeletons` (plan
`.claude/plans/2026-11-02-g2-skeletons.md`, AD-4; interview Q10a and Q13a).

## Context
G2 has the engine write signature skeletons into repository source files. A plan's **Export bindings:**
name which exports of a contract's frozen types file each implementation path must provide. The engine
writes the bound skeleton when a Task spawns, when a contract Task stops (contract stubs), and when a
Contract Revision regenerates it. Several later decisions depend on knowing what the engine wrote:

- **Idempotency (FR-010).** Re-running generation over an untouched skeleton must change 0 bytes.
- **Outcomes (FR-030).** Each non-test `file_list` path gets exactly one outcome. The engine must tell
  `skeleton written` apart from `exists, not skeletonized`, which means telling its own bytes apart from an
  author's.
- **Contract Revision (FR-033).** A revision regenerates only skeletons still byte-identical to what the
  engine wrote. A modified skeleton is left alone and flagged `stale against revised contract`.
- **Crash safety (NFR-021).** Each file is either fully written or absent, and a re-run completes the rest.

FR-031 states the need directly: the engine must keep enough record of each skeleton's engine-written content
to tell an untouched skeleton from a modified one.

Two forces make this harder. First, the bindings come from a plan file that is still editable while the run is
in progress. ADR-0032 settled the same problem for Owner Obligations: the run must not depend on authority
that can still change under it. Second, the file write and the locked State File update that records it
cannot be one atomic step. The writer writes the file (temp file plus link or rename) first, and the locked
record comes after. If the process crashes between the two, or a registration is refused after the write,
the file is on disk with no record of it. A naive "file exists → not ours" rule would then misreport the
engine's own bytes as an author's file and never adopt them.

Running TaskGraphs from before G2 must also load unchanged (Q13a). The new state must therefore be additive and
optional.

## Options Considered

1. **Re-derive bindings from the plan at each use; infer "untouched" from the plan and the generator alone**
   - Pros: No new persisted state. Nothing to migrate, nothing to keep in sync.
   - Cons: The plan becomes mutable authority mid-run. An edit to **Export bindings:** after population would
     silently change which skeletons get written, which signatures a brief freezes, and which completion
     refusals apply. This is the drift ADR-0032 rejected. Without a record of what the engine wrote, a
     Contract Revision cannot tell a file generated from the old surface from an author's file, because the
     canonical bytes for the new surface no longer match either one.

2. **Stamped bindings plus a write-ahead journal of skeleton writes**
   - Pros: Every write is announced before it happens, so recovery after a crash can replay or roll back
     from the journal. An audit trail of intent comes for free.
   - Cons: A second state machine (pending, committed, rolled back) that must itself be crash-safe, parsed,
     and reconciled with disk. It is more state for what a digest already proves: after a crash, the file's
     bytes either equal the bytes the engine would write or they do not. Recovery logic would be a second
     opinion on a question one hash comparison answers.

3. **Stamped bindings, skeleton records with engine digests, and content-addressed recognition (chosen)**
   - Pros: The run reads bindings only from the stamp, so a plan edit is drift that is refused, never
     applied silently. One pure predicate answers "untouched?" for idempotency, outcomes, contract stubs and
     revision. A write whose record was lost is adopted on the next materialization, because its bytes equal
     the canonical bytes. No journal, no recovery path, no new lifecycle.
   - Cons: Recognition by canonical bytes depends on the generator being deterministic. An author who
     deliberately writes exactly the canonical skeleton is counted as the engine. Three new optional
     TaskGraph fields must be parsed and cross-checked at load.

## Decision
**Three additive, optional TaskGraph fields hold the persisted state, parsed and cross-checked by
`engine/src/state-file-wire.ts`. Bindings are stamped once at population. Each skeleton record carries the
digest of the bytes the engine wrote. A file is an untouched engine skeleton exactly when its current bytes
equal that digest or the canonical bytes for the current surface.**

### Fields

- **`export_bindings: readonly ExportBinding[]`**, in plan order, where
  `ExportBinding = { path, contract, exports: NonEmpty<{ name, alias }> }` (`engine/src/core/skeleton/types.ts`).
  - Population (`exportBindingsStamp` in `engine/src/core/task-graph-population.ts`) stamps it from the
    validated plan. It re-runs `validateExportBindings` so that no graph is ever stamped with a binding that
    plan validation would refuse.
  - Before each spawn, the brief shell (`engine/src/orchestration/implementation-brief.ts`,
    `planBindingCheck`) re-reads the recorded plan and calls the pure
    `bindingStampAgreement(plan, stamp)` (`engine/src/core/skeleton/bindings.ts`). If the bindings differ in
    content or order, it refuses the brief, names each added and dropped binding line, and directs the
    operator to re-populate. A graph with no stamp has nothing to drift from. A stamped graph with no
    recorded plan cannot be checked, and the brief says so (`NO_PLAN_TO_CHECK`). A plan that cannot be read refuses.
- **`skeletons: readonly SkeletonRecord[]`**, sorted by path, no path twice. Each record holds:
  - `path`, `contract`, `language` (`typescript` | `java`);
  - `origin` (`spawn` | `contract-stub` | `revision`);
  - `engineSha256`, the raw-bytes digest of the bytes the engine wrote (FR-031);
  - `typesSha256`, the digest of the types file the skeleton was generated from;
  - `stale`, which is `null` or `{ revision }` (FR-033).

  At load, the wire parser refuses a record whose path `export_bindings` does not bind, whose contract
  differs from the binding's, or whose path `skeletonLanguageOf` does not accept as a skeleton target.
  On re-population, `carriedSkeletons` keeps only the records whose path the new stamp still binds to the
  same contract. The bytes on disk outlive population, so dropping such a record would misreport an untouched
  skeleton.
- **`task.skeleton_outcomes: readonly { path, outcome: SkeletonOutcome }[]`**, recorded at each registration
  (FR-030) and parsed per Task against that Task's `file_list`. Once the stamp and records are parsed, the
  wire checks each outcome against them: `skeleton-written` has its record in `skeletons` (origins are not
  compared, because a Contract Revision re-origins a refreshed record); `unsupported-language` is bound
  and `skeletonLanguageOf` gives its path exactly that reason; `no-bound-exports` and
  `contract-has-no-types-file` are unbound; and a graph with no `export_bindings` stamp records no outcome.

The canonical `TaskGraph` and `Task` in `engine/src/types.ts` declare all three fields. Their value types
live in the leaf `engine/src/core/skeleton/persisted.ts`, which imports nothing from `types.ts`, so the
declaration closes no import cycle; the wire parser proves them at load.

### Content-addressed recognition (INV-4)

`isUntouchedSkeleton(record, currentSha, canonicalSha)` in `engine/src/core/skeleton/outcomes.ts` is the single
owner of the rule:

> A present file is an untouched engine skeleton exactly when its current sha256 equals the record's
> `engineSha256`, or equals the sha256 of the canonical bytes the generator produces for the current surface.
> A missing file never is.

Every consumer calls this one predicate and none restates it:

- `skeletonOutcomesOf`, which derives the outcomes;
- spawn materialization (`engine/src/orchestration/skeleton-materialization.ts`);
- contract-stub materialization (`engine/src/orchestration/contract-stub-materialization.ts`);
- the Contract Revision refresh (`engine/src/orchestration/skeleton-revision.ts`). It regenerates an
  untouched skeleton from the revised types file and flags a modified one stale.

Shells observe each path as a `PathObservation`: either `absent`, or `present` with the current digest and
the canonical digest. The pure core decides from that observation alone.

### Ordering invariant

Writes go first, and the locked State File update comes after. If the update is refused or the process
crashes after the write, the file still holds the canonical bytes. The next materialization recognizes them
and adopts the file instead of reporting `exists, not skeletonized`. NFR-021 crash safety and FR-010
idempotency are therefore one rule, not a journal plus a recovery path.

## Consequences

**Positive:**
- Plan edits cannot change a running graph silently. Binding drift is refused before the brief is
  rendered, the same fail-closed stamping pattern as ADR-0032, so operators have one mental model.
- Crash recovery, idempotency, outcome derivation and revision-time staleness all reduce to one pure,
  property-testable predicate with one owner. Its consumers cannot disagree about what "untouched" means.
- No journal, no pending-write state and no recovery code path. Only one interleaving can be partial (file
  written, record missing), and it heals itself on the next run.
- The fields are additive and optional, so TaskGraphs from before G2 load unchanged and simply write no
  skeletons. Brief rendering says so explicitly ("populated before export bindings were stamped").
- `typesSha256` and `stale` let status and briefs explain why a skeleton is stale against a revision without
  re-deriving history.

**Negative:**
- Recognition by canonical bytes assumes the generator is deterministic and byte-stable for a given surface
  and bindings (AD-8). A generator change that alters canonical bytes makes earlier untouched skeletons
  without a matching record look modified. The `engineSha256` arm covers recorded writes, but not
  unrecorded ones.
- An author who hand-writes exactly the canonical skeleton is indistinguishable from the engine. This is
  accepted because the outcome is the same either way: the bytes are what the engine would have written.
- Any binding change, even a reorder, requires re-populating the TaskGraph. Re-population drops records for
  bindings that are gone, and a skeleton file left behind for a dropped binding then reports as
  `exists, not skeletonized`.
- The wire parser gains cross-field checks between records and the stamp. A hand-edited State File that
  breaks them fails to load instead of degrading.
- The persisted skeleton value types must stay in the dependency-free leaf `core/skeleton/persisted.ts`:
  moving one into a module that imports `types.ts` would reopen the cycle the canonical declaration avoids.
