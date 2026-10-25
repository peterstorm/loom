# ADR-0039: The second-copy lens is an engine-issued packet section

## Status
Accepted (2026-10-23). Shipped with the G5b owner-enforcement feature
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, FR-022..FR-026, AS-022..AS-028, SC-005, OOS-009;
plan `.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-9). Amended by ADR-0047 (2026-10-25): as shipped,
the Wave review roster never issued `architecture-tech-lead`, so its half of the decision below was dead; the
roster is now derived per Task and appends `architecture-tech-lead` whenever the Task's packets carry the owner
map.

## Context
G5a gives each owned Invariant one owner module, with sibling entry points that must call it and a matrix test
that drives the rule through the owner and every sibling. G5b adds two mechanical checks at the Wave Gate:
sibling coverage and owner mutation. Neither check catches the failure that ownership exists to prevent, which
is a **second copy**. A second copy is a diff that re-implements an owned Invariant's predicate somewhere other
than the owner module. It can sit in a sibling or in an unrelated file. It can pass every test, and the matrix
test only fails it once the copy diverges on an input the test happens to exercise. Deciding whether a hunk is
"the same predicate" is a semantic judgment, so it belongs to review. A lint rule or path check cannot make it.

Review has hard constraints of its own:

- **Reviewer guidance is frozen.** The Wave reviewer shims load archived protocol text
  (`references/reviewer-protocol-v2/agents/*.md`, including `code-reviewer.md` and
  `architecture-tech-lead.md`). This feature may not edit that text. If it changed, every protocol-v2 review
  would see different guidance, and the frozen-protocol guarantee would be lost.
- **The rubric is versioned.** `REVIEWER_IMPACT_RUBRIC_V1` (`engine/src/core/reviewer-contract.ts`) controls
  severity. OOS-009 excludes a rubric version change, so the new duty has to fit inside the existing rubric.
- **Packets are digest-bound.** A Wave review Context Packet is content-addressed. Slot identity, request
  authority and capture replay depend on its bytes. Anything a reviewer must act on has to be inside the
  digest, or the engine cannot prove which obligation the reviewer was shown (FR-023). Packets that do not
  need the new content must keep their exact bytes (FR-024, SC-005), so in-flight and unrelated reviews are
  not re-derived.
- **Scope is per Task.** Which Invariants a Task touches is decided by INV-3's owner,
  `engine/src/core/owner-verification/obligations.ts`. The packet must not re-derive that selection.

## Options Considered

1. **Engine-issued, digest-bound owner-map section in the Wave review packet (chosen)**
   - Pros: the duty reaches the reviewer through the one channel this feature controls and the engine already
     hashes, so the obligation is part of the packet digest. The section is limited to the reviewers and Tasks
     that need it, so every other packet stays byte-identical. The section cites the concrete contract
     (`<plan file>#INV-N`), which `REVIEWER_IMPACT_RUBRIC_V1` already accepts as a critical basis ("Explicit
     non-negotiable project obligations remain binding; cite the actual obligation and consequence"), so no
     rubric change is needed. Text and selection come from pure, testable modules.
   - Cons: the reviewer still makes the semantic call, and the Refutation Panel is the only check on it.
     Standalone `/review-pr` gets no owner map, because it has no TaskGraph to read obligations from.

2. **Edit the archived reviewer agent guidance to add a second-copy lens**
   - Pros: every review, standalone included, would carry the lens. No packet changes.
   - Cons: the guidance is frozen and off-limits. Generic guidance cannot name this plan's owners, siblings
     or matrix tests, so the reviewer would have to rediscover ownership from the plan without engine
     authority. The text would sit outside any packet digest, so the engine could not prove what a reviewer
     was told.

3. **A new rubric version that makes second copies an explicit severity class**
   - Pros: the severity rule would be formal and the same everywhere.
   - Cons: excluded by OOS-009. A rubric bump ripples through every reviewer payload schema and contract test.
     It is also unnecessary, because the V1 rubric already admits explicit project obligations as a critical
     basis.

4. **Mechanical second-copy detection (a lint rule or AST similarity check at the gate)**
   - Pros: deterministic, and it blocks without relying on a reviewer.
   - Cons: whether code "implements the same predicate" cannot be decided syntactically. Renamed variables,
     inverted conditions and partial copies all defeat a structural matcher. An approximation would produce
     false blocks or quiet misses, and both are worse than an honest review judgment that the Refutation Panel
     checks. Sibling coverage and mutation (ADR-0035, ADR-0037) already provide the deterministic part.

5. **Put the owner map in the implementation brief only**
   - Pros: no packet change at all.
   - Cons: it tells the implementer but gives review no authority. A second copy written anyway would reach the
     gate with no reviewer asked to look for it. The brief duty paragraphs (AD-10) ship alongside this
     decision and do not replace it.

## Decision
**The second-copy rule and the touched Invariants' ownership facts reach Wave reviewers as an engine-issued
fixed section, `owner-map`, inside the digest of schema-2 code-reviewer and architecture-tech-lead packets for a
Task that touches an owned family. Every other packet is byte-identical.**

**Renderer.** The renderer is pure and lives in `engine/src/core/owner-verification/owner-map.ts`.

- `OWNER_MAP_SECTION = "owner-map"` is the byte-section label.
- `OWNER_MAP_ROLES = ["code-reviewer", "architecture-tech-lead"]` and `isOwnerMapRole(role)` are the single
  definition of which reviewer roles receive the section.
- `renderOwnerMapSection(planFile, obligations: NonEmpty<OwnerObligation>)` renders the section. The
  `NonEmpty` type makes an empty section impossible to represent.
  - It opens with an `## Owner map (engine-issued)` heading and a preamble naming the plan file.
  - Each obligation then gets one block, in the order given. The block contains the Invariant id and title,
    its statement (`none declared` when absent), the owner module, the sibling entry points with their notes
    (`none` when there are none), the matrix test, and the contract a second copy violates, spelled
    `<planFile>#INV-N`.
  - It ends with `## Second-copy rule` followed by the fixed `SECOND_COPY_RULE` text.
- `SECOND_COPY_RULE` has four paragraphs:
  1. A diff that implements a declared-owned Invariant's predicate outside its owner module is a second copy
     and a finding. The finding cites `<plan file>#INV-N` as the violated contract.
  2. Rate it critical when the copy diverges from the owner on some input, and name that diverging input as
     the consequence.
  3. Rate it advisory when the copy is behaviorally identical. It is still a second copy and should be
     replaced by a call to the owner module.
  4. The existing severity rules and the Refutation Panel apply unchanged.

**Selection.** Selection is not re-derived here. `obligationsTouchedBy(scope, task.file_list ?? [])` in
`engine/src/core/owner-verification/obligations.ts` (INV-3's owner) returns the obligations in which the file
list plays any role. That means the Task changes the owner or a sibling, or it writes the matrix test. The
`scope` is the opaque `OwnerScope` that `ownerScopeOf(graph)` builds; the issuer never holds the raw
`owner_obligations` stamp (ADR-0034, PR #131 review remediation).

**Issuance.** `engine/src/core/wave-review-authority.ts` issues the section.

- When `registration.schemaVersion === 2`, it builds `ownerScopeOf(graph)` once and renders one `owner-map`
  byte section for each Task with a non-empty touched set. This happens once per Task, before the subject loop.
  The stamp test is the scope's: an unstamped scope (a graph without `owner_obligations`) touches nothing, so no
  Task gets a section.
- In the subject loop, the section is added to `fixedContext` only when both of these hold:
  - `subject.taskId !== null`, which excludes the spec-check subject;
  - `isOwnerMapRole(subject.role)`.
- Fixed context is digest-bound, so the section is inside the packet digest. A changed obligation changes the
  packet identity (FR-023, AS-025).
- Section order is: authority JSON, then wave-frozen source, then owner map, then requirement coverage.
  Requirement coverage only goes to the spec-check subject.

The section therefore appears only when all five plan conditions hold:

- schema 2;
- a Task subject;
- a code-reviewer or architecture-tech-lead role;
- a stamped graph;
- a non-empty touched set.

**Receiving roles.** Only `code-reviewer` and `architecture-tech-lead` receive the section. Both are issued
for an owner-mapped Task: its Wave review roster is the base five with `architecture-tech-lead` appended last,
derived from the same owner-map presence (ADR-0047). These roles'
packets carry nothing new:

- `code-simplifier`
- `comment-analyzer`
- `pr-test-analyzer`
- `silent-failure-hunter`
- `type-design-analyzer`
- the spec-check subject (`spec-check-invoker`)
- the `review-verifier-agent` Refutation Panel verifiers

**Byte identity.** A packet gets identical bytes in each of these cases (FR-024, SC-005; AS-024, AS-026):

- a schema-1 registration;
- a graph without `owner_obligations`, which covers pre-feature graphs;
- an empty stamp;
- a Task touching no owned family;
- any other role.

Standalone review never builds a Wave packet and has no TaskGraph, so by construction it never carries an
owner map (AS-027).

**Where the shipped code differs from the plan:**

- **Missing plan file fails closed.** If a Task touches owned Invariants but the stamped TaskGraph has no
  `plan_file`, issuance fails with
  `Task <id> touches owned Invariants but the stamped TaskGraph records no plan_file to cite`. It does not
  emit a section with no contract to cite.
- **Matrix-test-only Tasks get the section.** "Touches" means any role, the matrix test included, because
  that is `obligationsTouchedBy`'s documented scope for packets and briefs. A Task that only writes the matrix
  test therefore gets the owner map. This differs from the narrower changed-family scope that triggers gate
  coverage and mutation.
- **Longer advisory wording.** The rule's advisory paragraph adds remediation guidance (replace the copy with
  a call to the owner module). The plan's text did not include it, and severity semantics are unchanged.

**Tests.**

- `engine/tests/core/owner-map-packet.test.ts` covers rendering, the role list, digest binding and every
  byte-identity regression.
- `engine/tests/acceptance/owner-map-packet.acceptance.test.ts` is the frozen CT-2 contract.
- The packet sibling row in `engine/tests/core/owner-obligations.matrix.test.ts` proves the packet uses INV-3's
  owner for selection.

**Operator docs:**

- `docs/operations.md` (owner-verification section)
- `references/executable-models.md` ("The second-copy lens (G5b)" and its limits)
- `docs/architecture.md`
- the `Owner Map` and `Second Copy` terms in `CONTEXT.md`

## Consequences

**Positive:**
- Reviewers get the exact owner, siblings, matrix test and violated-contract citation for the Invariants a Task
  touches. They do not have to reconstruct ownership from the plan.
- The obligation is inside the packet digest. The engine can prove which owner map a reviewer saw, and a
  changed stamp re-derives the affected packets.
- No change to frozen guidance or the rubric. `REVIEWER_IMPACT_RUBRIC_V1` already makes a cited project
  obligation with a concrete diverging input a valid critical basis.
- Byte identity outside the narrow condition means pre-feature graphs, unrelated Tasks, other roles and
  standalone reviews behave exactly as before, so in-flight Waves are not disturbed.
- Pure rendering, plus selection delegated to INV-3's owner, keeps the lens testable. It cannot drift from the
  gate's and the brief's view of which Invariants a Task touches.

**Negative:**
- Whether a hunk is a copy, and whether it diverges, is reviewer judgment checked only by the Refutation Panel.
  A missed second copy is possible, and an identical copy is advisory, so it never blocks a Wave by itself.
- Standalone `/review-pr` has no second-copy lens. There is no TaskGraph and no repository-wide owner registry
  to issue one from.
- Only two reviewer roles see the map. A second copy in a Task reviewed only by other roles is not prompted for.
  (As first shipped only `code-reviewer` was actually issued; ADR-0047 makes `architecture-tech-lead` join the
  roster of every owner-mapped Task.)
- Any change to the stamp's rendered fields, or to `SECOND_COPY_RULE`, changes the digests of all affected
  packets. The rule text is effectively a versioned contract that has no version number of its own.
- A stamped graph without `plan_file` now makes Wave review issuance fail rather than degrade. This is deliberate,
  but it is a new failure path for an operator to resolve.
