# ADR-0007: A facade publishes a curated Public Surface, not the union of its volumes

## Status
Accepted

## Context

The orchestration shared kernel (`engine/src/core/orchestration-contract/`) is
4,582 lines split into sub-domain volumes behind one facade. Two defects in that
arrangement were found by a deepen session (2026-08-18), and they share a cause.

**The volumes were cyclic.** `roster ↔ completion`, `publication ↔ completion`,
and `publication ↔ actions` each imported the other. Every back-edge carried
only an error or diagnostic *type* — `SemanticPayloadDiagnostic`,
`AcceptedAgentResultError`, and `actionFailure`/`outputSlotCollision`/
`ExternalActionError` — against forward edges of 9 to 20 symbols. An error type
is referenced by everything that can fail, so declaring it beside the operation
that raises it points an edge backwards. A cycle means neither volume can be read
or tested without the other, and "volumes" that cannot be separated are one
module in several files.

**The facade republished everything.** `index.ts` re-exported the union of the
volumes' exports: 142 symbols, of which **76** were used by production, **14**
only by tests, and **52** by nothing outside the kernel at all.

The second defect is the interesting one, because it explains a class of rot
rather than an instance. A volume exports a symbol so that volumes above it can
use it. That is an internal relationship and says nothing about whether callers
outside the kernel need it. Re-exporting the union erases the difference — and
`tsc` cannot restore it, because an exported symbol with no importer is invisible
to the compiler, which assumes an external consumer exists. `noUnusedLocals`
catches dead *locals*; nothing catches dead *exports*.

That blind spot is not hypothetical here. A distill pass over the same branch
removed 40 exported symbols that were referenced nowhere in the repository,
including twelve pure aliases and three "machine facade" objects whose doc
comments named consumers that did not exist. None of them were visible to the
build.

## Options Considered

1. **Leave it; sweep periodically.** A deepen or distill session finds the dead
   exports every few months.
   - Pros: no new mechanism
   - Cons: the sweep is the only detector, so rot is bounded by how often someone
     looks; it had already reached 40 symbols plus 52 facade entries

2. **Encode the volume layering as lint boundary rules.**
   `linter/programmatic/no-cross-boundary-imports.ts` supports per-module
   allow/deny prefixes and resolves relative imports.
   - Pros: enforced on every edit, fail-closed, consistent with **Checkable
     Invariant**
   - Cons: rule selection is first-match-wins, so a 10-node DAG needs 10 rules
     each duplicating the `engine/src/core/` allowlist; it encodes an *ordering*
     that must be hand-maintained, and adding a volume means editing the rules

3. **Assert the properties as tests.** One test for acyclicity, one for the
   public surface.
   - Pros: expresses the property rather than a hand-maintained ordering, so
     adding a volume needs no change; no duplication of the boundary allowlists;
     runs in CI and at the Wave Gate
   - Cons: not enforced per-edit the way a lint rule is, so a violation surfaces
     at test time rather than at write time

## Decision

**Move shared error and diagnostic types beneath the volumes that raise them,
and assert both properties as tests.**

`engine/src/core/orchestration-contract/errors.ts` is a new leaf volume owning
the error vocabulary shared across volumes. It imports only `identity` and
`bytes`, so it cannot close a cycle. Moving five symbols into it made the volume
graph a DAG.

`index.ts` now publishes a **curated Public Surface** — 90 symbols, not 142 —
and its header states the rule: adding a symbol means committing to it as kernel
API. Dropping a re-export removes nothing; the volume still exports the symbol to
its siblings.

Two tests enforce this, and both were verified to fail when the property is
broken:

- `tests/core/orchestration-contract-acyclic.test.ts` asserts the volume graph
  is acyclic and names the exact cycle paths when it is not. It additionally
  pins that `errors.ts` imports only `identity` and `bytes`.
- `tests/core/orchestration-contract-public-surface.test.ts` asserts every
  symbol on the facade has a consumer outside the kernel.

Option 2 remains available and is not foreclosed: if per-edit enforcement is
wanted later, the boundary rules can encode the DAG the test already guarantees.

## Consequences

- Failing the public-surface test is a decision point, not a deletion order:
  either a caller needs the symbol (add the caller) or the kernel does not
  publish it (drop the re-export).
- `Public Surface` is now a term in `CONTEXT.md`, with the relationship "a
  module's Public Surface is curated, and every symbol on it has a consumer
  outside that module".
- The rule is enforced for the orchestration shared kernel and the
  `handlers/helpers/programs` façade. Program helper tests import owning volumes
  directly, while the façade publishes only parent caller operations. The
  broader engine-wide export inventory remains unsolved; extending the check
  repo-wide still needs a marked internal surface so correct test seams are not
  mistaken for Public Surface commitments.
- `engine/src/core/orchestration-contract/index.ts` is the worked example. A
  future facade should start curated rather than start as a barrel.
