# ADR-0069: The Contract Task's Wave review judges the contract surface

## Status
Proposed (2026-11-12). Implements the roster half of Q3 of the deterministic-implementation plan's Q-track
(the plan design review is ADR-0070). Extends ADR-0047; follows the packet-section pattern of ADR-0039.

## Context
An Acceptance Contract's types file is the surface every dependent Task implements against. Its Contract Task
writes it, the contract Wave's gate freezes it, and from then on a change takes an operator Contract Revision.
Type-design and architecture findings about those declarations (illegal states the types admit, primitives
standing in for domain concepts, a module that is the wrong shape, one policy left for several exports to
re-decide) are reported today at PR review, after every dependent has built on them.

The review that could catch them earlier already exists: the Contract Task's Wave review runs before any
dependent starts, because claimants and binding holders depend on the Contract Task and a dependency must be
`completed`. Two things kept it from doing the job:

- **The architecture reviewer is not there.** The Wave review roster is the base five, which includes
  `type-design-analyzer`, and `architecture-tech-lead` joins only when the Task touches an owned Invariant's
  family (ADR-0047).
- **Nothing tells the reviewers what they are looking at.** The packet of a Contract Task reads like any other
  Task's. Reviewer guidance is frozen archived text (ADR-0039), so it cannot say it either.

Constraints, all inherited: slot authority is positional and slot ids do not hash the roster (ADR-0047);
packets that need nothing new keep their exact bytes; reviewer guidance and the impact rubric are frozen; the
roster and a packet section that justifies it must come from one derivation.

## Options Considered

1. **A second reason for the architecture lens, with its own packet section (chosen).**
   - Pros: reuses the six-reviewer roster, its slot identities and its whole comparison machinery. The section
     reaches only the two roles that judge a surface. No new gate, phase or State File field.
   - Cons: the roster now has two reasons, so the selector can no longer take a boolean. One more reviewer per
     contract with a types file.

2. **A separate contract review before the contract Wave Gate.**
   - Cons: a new program or gate state with its own issuance, capture and recovery, to run at the same moment
     the Wave review already runs. Dependents are already blocked until the Contract Task completes.

3. **`architecture-tech-lead` on every Wave Task.**
   - Cons: ruled out by ADR-0047 for cost and for changing every in-flight run's roster.

4. **Issue the section to every reviewer of the Contract Task.**
   - Cons: changes four more packets' bytes to tell the silent-failure, test, comment and general reviewers
     something outside their lens.

5. **Keep `waveReviewRoster(ownerMapped: boolean)` and add a second boolean parameter.**
   - Cons: two positional booleans a caller can swap, and a third reason would be a third. The roster would
     still not say why it is six.

6. **Edit the archived reviewer guidance.**
   - Cons: frozen (ADR-0039), and generic text cannot name this plan's contract, types file or bindings.

## Decision

### 1. The architecture lens has a closed set of reasons
`engine/src/core/agent-catalog-projections.ts`:

- `ArchitectureLensReasons = { ownerMap: boolean; contractSurface: boolean }`. Every reason is a required
  field, so a new reason does not compile until every caller answers it.
- `waveReviewRoster(reasons)` answers `ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS` (the base five with
  `architecture-tech-lead` appended last) when any reason holds, else `BASE_WAVE_REVIEW_AGENTS`. A Task with
  both reasons has six reviewers, not seven.
- The roster constant is renamed from `OWNER_MAPPED_WAVE_REVIEW_AGENTS`: the owner map is now one of two
  reasons for it.

### 2. Which Tasks write a contract surface
`reviewedContractSurfaces(contracts, bindings, taskId)` in `engine/src/core/contract-surface-section.ts` is the
one selection: one `ReviewedContractSurface` per Acceptance Contract whose `contractTask` is the Task and whose
`types.kind` is `file`, carrying the contract's id, title and statement, the types file path, and the stamped
export bindings that name that contract, in plan order. A contract declaring `**Types file:** none` has no
surface. A Task that is the Contract Task of several contracts gets one surface per contract.

### 3. The derivation
`waveTaskReviewDerivation` in `engine/src/core/wave-review-authority.ts` stays the one presence-to-roster
derivation. It now returns the Task's owner-map obligations and its contract surfaces, and the roster picked by
whether each is non-empty. Contract surfaces are derived for schema-2 registrations only, as the owner map is.
Packet issuance renders both sections from that result, so a section and the roster cannot disagree.

### 4. The section
`renderContractSurfaceSection(planFile, surfaces: NonEmpty<ReviewedContractSurface>)` is pure. The section's
label is `contract-surface`. It says the Task is the Contract Task and that dependents implement against its
types file; lists each contract's id, title, statement, types file, `<plan file>#CT-n` and bound exports; and
ends with the fixed `CONTRACT_SURFACE_RULE`: judge representable illegal states, primitive obsession, module
shape and seams, and duplicate policy across the bound exports; a defect is cheapest before the freeze; the
existing severity rules and the Refutation Panel apply unchanged.

It is added to `fixedContext`, after the owner map, only for a Task subject whose role is in
`CONTRACT_SURFACE_ROLES = ["type-design-analyzer", "architecture-tech-lead"]`. That constant is typed
`satisfies readonly WaveReviewRole[]`, and a test asserts each role is on the architecture-lens roster.

Byte identity: a schema-1 registration, a graph without contracts, a contract without a types file, every Task
other than the Contract Task, the Contract Task's other four roles and the spec-check subject all issue the
bytes they issued before. Slot and request ids of the base five are unchanged, and so is the batch epoch.

### 5. A Review Run installed before the lens keeps its roster
A Contract Task's Wave Gate may be in flight when an engine with this ADR first runs. ADR-0047 let that case
fail closed. Here the derivation reads the Task's installed Review Run: when its `expected_agents` equal the
roster the Task has *without* the contract-surface reason, and that roster differs from the one with it, the
Task has no contract surface for that run. Its roster stays five and its packets are re-derived exactly as
issued. `waveRunRosterProblem` asks the same question of the run it is given, so retries, slot membership,
restart and the install's replay all admit that run.

The rule has one home, `installedContractSurface(installed, { ownerMap })`. It takes the Task's other
architecture-lens reasons by name and returns a tagged reading, `derive` or `issued-without-surface`: the run
was issued without the surface exactly when it names the base five and no other reason holds.

This is the only persisted roster the derivation reads. It weakens "never a persisted copy" (ADR-0047, option
4) by exactly one admitted value: a Contract Task's run may name the base five. A fresh install never writes
that, because a Task with no installed run derives six. Any other roster is still refused.

## Rulings the implementation needed
- **The type is `ReviewedContractSurface`, not `ContractSurface`.** `engine/src/core/skeleton/types.ts` already
  exports `ContractSurface` (a parsed frozen surface with its contract), in a file frozen by G2's CT-1.
- **The plan file is a render argument, not a field of each surface.** One TaskGraph has one plan, as
  `renderOwnerMapSection(planFile, obligations)` already assumes.
- **A missing `plan_file` does not block.** The owner map refuses issuance without one because the second-copy
  rule cites `<plan file>#INV-N` as the violated contract. Here the citation only says where the contract is
  declared, so a TaskGraph recording no plan file is cited by contract id and the section is still issued.
- **Bindings come from the stamp.** `export_bindings` is the validated plan grammar; the section re-parses
  nothing.

## Consequences

**Positive:**
- The two lenses that most often find a contract defect read the contract with that framing before any
  dependent implements against it.
- One derivation drives the roster and both sections. No new State File field, parser or gate state.
- Packets and identities outside the narrow condition are byte-identical.

**Negative and known limits:**
- One more reviewer per Contract Task with a types file.
- It is review, not proof. Whether a declaration admits an illegal state is the reviewer's judgment, checked by
  the Refutation Panel; an advisory finding does not block the freeze.
- A contract without a types file gets no lens: its acceptance tests are still read by the base five only.
- A re-review of the Contract Task after dependents have started (a Task Reopening, a reopened Wave) carries
  the same section, whose "cheapest now" is then less true than at the first review.
- **A finished review records no roster.** A Contract Task whose review settled before the upgrade, inside a
  Wave Gate that is still open or is replayed after completion, has no installed Review Run to read, so its
  derived roster is six while its issued batch has five. Persisted-batch recovery and completed-protocol
  verification then disagree with what was issued; the operator abandons the run and starts a fresh Wave
  Gate. Closing this needs the roster recorded on `accepted_review_authority`, a State File wire change this
  ADR does not make.
- **An owner-mapped Contract Task's installed roster is ambiguous.** It was six before and is six now, so the
  installed run cannot say whether its type-design packet carried the section. The run continues on its
  issued packets. Only a batch that must be re-derived (republication after a crash part-way through) differs
  from what was issued, and blocks.
- Any change to `CONTRACT_SURFACE_RULE` or to a rendered field changes the digests of the two affected packets,
  as with the owner map.

**Tests:**
- `engine/tests/core/contract-surface-section.test.ts`: selection (examples and two properties: every typed
  contract is reviewed by exactly its Contract Task; a surface lists exactly its contract's bindings), the
  rendered text and rule, the label and roles, roster derivation (examples and a property over generated
  Waves), issuance (six requests, the section on both roles, digest binding, byte identity of every other
  packet, unchanged base slot identities, both sections together, no plan file), the installed-run rule
  (admitted five- and six-agent runs, batches re-derived as issued, other rosters still refused, the
  owner-mapped ambiguity, and `installedContractSurface` over every roster and owner-map combination), and
  both known limits above: a settled Contract Task re-derives six against the five issued, so persisted-batch
  recovery classifies the issued batch `incomplete`; and an owner-mapped Contract Task's republished batch
  differs from the issued one in exactly its type-design and architecture packets.
- `engine/tests/core/agent-catalog.test.ts`: `waveReviewRoster` over all four reason combinations, and every
  contract-surface role on the architecture-lens roster.
- `engine/tests/handlers/helpers/programs/reviewer-protocol-wave.integration.test.ts`: through the registered
  Wave Gate program, a Contract Task is issued and installed with six reviewers and the section on both roles;
  a five-agent Review Run installed before the contract was stamped collects all five results and settles.
- `engine/tests/core/wave-review-authority.test.ts`: persisted-batch classification over rosters drawn from
  every reason combination (property).
