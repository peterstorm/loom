# ADR-0032: Owner Obligations are stamped at population; the gate re-reads the plan and fails closed on drift

## Status
Accepted (2026-10-23). Shipped with G5b owner enforcement
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-2; interview Q2a).

## Context
G5a taught the plan grammar to declare owned Invariants (`**Owner module:**`, siblings, a matrix test). G5b
turns those declarations into Wave Gate obligations. The obligations have several readers. The Wave Gate's
owner check needs them to decide coverage and mutation. The reviewer packets need them to issue the owner map
and the second-copy rule. The implementation brief needs them to state each Task's owner duties. `helper
orchestration status` needs them to project verdicts and remedies. If every reader re-parses the plan, every
one of them, including pure core modules, needs I/O. The plan grammar would then be interpreted in several
places.

Two requirements pull against each other here:

- **FR-002** says the gate reads obligations "from the plan the TaskGraph names". A plan edited after
  population, for example an owned Invariant added, removed or given a new owner, must not quietly change or
  escape what the gate checks.
- **FR-004** says a TaskGraph populated before G5b owes nothing. Old graphs must keep their completion-suite
  roster and digest unchanged.

The second requirement needs a way to tell "populated before the feature" apart from "populated by the
feature from a plan with no owned Invariants". If both are written as an absent or empty record, the gate
cannot tell them apart. It would then have to choose between skipping drift checks on new plans and blocking
old graphs.

## Options Considered

1. **Stamp at population, always (including `[]`), and have the gate re-read the plan and compare** (chosen)
   - Pros: every reader except the gate does a pure selection over graph data (`graph.owner_obligations`).
     Whether the field is present answers "pre-G5b?" with no second marker. The gate still honours FR-002 by
     re-deriving the obligations from `plan_file` and requiring canonical equality. The stamp's digest can be
     bound into the completion-suite authority.
   - Cons: the obligations exist in two places, the plan and the stamp, and must be kept in agreement.
     Legitimate plan edits after population, such as adding a mutation exemption, block until re-population.

2. **Re-parse the plan in every reader, plus a schema marker to identify pre-G5b graphs**
   - Pros: one source of truth (the plan file). A plan edit takes effect at once.
   - Cons: every reader, including the brief renderer, the review-packet builder and the status projection,
     needs file I/O and plan parsing, so pure core modules would grow I/O dependencies. Each reader has its own
     failure modes when the plan is unreadable. It needs a second field just to say "this graph is G5b-era".
     Nothing pins what population saw, so a mid-flight plan edit changes obligations silently instead of
     being detected.

3. **Stamp only non-empty obligations**
   - Pros: graphs from plans with no owned Invariants stay byte-identical to pre-G5b graphs.
   - Cons: an absent field becomes ambiguous ("pre-G5b" or "no owned Invariants"). A graph populated from a
     plan with no owned Invariants would skip the plan re-read. If the plan later gained an owned Invariant,
     that drift would go unchecked, which breaks FR-002.

## Decision
**Population always stamps `owner_obligations` as data in the TaskGraph (`[]` included). Whenever the stamp
is present, the gate's owner check re-reads `plan_file`, re-derives the obligations and blocks as
infrastructure on any unreadable, malformed or drifted plan. Only a graph without the stamp skips this.**

**The shape** (`engine/src/core/owner-verification/types.ts`, `engine/src/types.ts`):

```ts
OwnerObligation = Readonly<{
  invariant: string; title: string; statement: string | null; owner: string;
  siblings: readonly SiblingEntryPoint[]; matrixTest: string;
  mutation: MutationPolicy; // { kind: "verify" } | { kind: "exempt"; reason: NonEmptyText }
}>
TaskGraph.owner_obligations?: readonly OwnerObligation[]
```

**The one derivation (INV-3 owner).** `engine/src/core/owner-verification/obligations.ts` owns the rule:

- `obligationsFromPlan(models)` returns one obligation per `owned` Invariant, in plan order. Unowned and
  malformed Invariants owe nothing.
- `obligationsDigest` is sha256 over the canonical JSON.
- `obligationsAgree(stamped, fromPlan)` checks canonical structural equality, in the same order. Key order
  read back from the wire does not matter.
- The selections every reader uses are `ownerVerificationOwed`, `waveChangedObligations`,
  `obligationsTouchedBy` and `ownerCheckAuthority`.

`ownerCheckAuthority(graph, wave)` returns `null` exactly when the stamp is absent. In that case the suite
roster and digest stay unchanged (FR-004). Otherwise it returns the stamp digest and the owed Invariant ids,
which may be none.

**Population** (`engine/src/core/task-graph-population.ts`, shell
`engine/src/handlers/helpers/populate-task-graph.ts`):

- `ownerObligationsOf` calls `obligationsFromPlan` over the plan's Invariants.
- The graph is always written with `owner_obligations: ownerObligations`.
- The previous graph's `owner_obligations` is destructured away along with the other stale wave authority,
  so re-population replaces the stamp, as it does for `acceptance_contracts`.
- Population also refuses a plan whose non-exempt owned Invariants owe mutation verification when the frozen
  verification manifest has no `affectedRunner` (`owner-verification-runner-missing`). Without that refusal,
  every later gate would block on a runner that cannot exist.

**The wire** (`engine/src/state-file-wire.ts`, `parseOwnerObligations`): an absent field stays absent. A
present field must be an array, every entry is parsed as an `OwnerObligation`, and an Invariant may appear at
most once. The parsed stamp feeds the reconstruction of completion-suite authority (`OwnerStampedGraph`), so a
persisted suite receipt is re-proven against the stamp's digest.

**The gate** (`engine/src/handlers/helpers/wave-completion-suite.ts`, `ownerVerificationObservation`):

1. Whenever the suite carries `loom:owner-verification`, the stamp is present. A suite that authorizes the
   check while the stamp is missing blocks as `plan-drift`.
2. `planIntegrityFailure` re-reads `graph.plan_file`, resolving it against the repository root, and parses it
   with `parsePlanModels`. This runs on every Wave, whether or not the Wave owes anything. Each of the
   following blocks as an infrastructure failure and never skips (FR-002):
   - **`plan-unreadable`:** the graph names no `plan_file`, or the file cannot be read.
   - **`plan-malformed`:** the plan has model strays, or an Invariant whose ownership is `malformed`.
   - **`plan-drift`:** `obligationsAgree(stamp, obligationsFromPlan(models))` is false.
3. When the plan agrees and the Wave owes nothing, the observation is
   `{ kind: "verified", obligationsDigest, boundMs: 0, verdicts: [] }`. Plan integrity is proven, and no
   coverage or mutation runs (AS-004, AS-005).
4. Otherwise `runOwnerVerification` decides. It never throws, by construction; the shell's last-resort catch turns a
   throw from the injected port into `unexpected-error`. Every infrastructure kind is
   a blocking failure in `engine/src/core/completion-suite.ts` and never counts as a kill.

**The other readers use the stamp purely.**

- **Implementation brief:** `engine/src/orchestration/implementation-brief.ts` passes
  `graph.owner_obligations` to `engine/src/core/implementation-brief.ts`.
- **Reviewer packets:** `engine/src/core/owner-verification/owner-map.ts` and
  `engine/src/core/wave-review-authority.ts` build the owner map from it.
- **Status:** `engine/src/core/owner-verification/status.ts` reads it.

None of these modules re-reads the plan.

**Deviations from the plan, as shipped:**

- The plan's single "owner-verification-infrastructure" failure ships as three named kinds: `plan-unreadable`,
  `plan-malformed` and `plan-drift`. Each has its own remedy row in `docs/operations.md` (§ owner verification).
- The gate reads the plan directly (`readFileSync` plus `parsePlanModels`) rather than through
  `loadPlanModelsSource`, so that each failure keeps its own kind.
- The owner run also reports an owner path that is not a readable file in the workspace as `plan-drift`
  (`engine/src/orchestration/owner-verification-runner.ts`).

`docs/architecture.md` ("Owner verification in the completion suite (G5b)") draws the flow.

## Consequences

**Positive:**
- Owner verification has one derivation and one canonical comparison. The brief, the review packets and
  status are pure selections over graph data, so no I/O leaks into the functional core.
- Whether the field is present cleanly separates pre-G5b graphs (no check, unchanged suite digest) from
  G5b graphs that owe nothing (the check runs and proves plan integrity). No extra schema marker is needed.
- Plan drift after population fails closed and is never silently honoured or ignored. The gate checks the
  obligations it was authorized for, and they are bound into the suite digest.
- Every failure mode is named and has a documented remedy (restore the plan, or re-populate).

**Negative:**
- Obligations are duplicated between the plan and the stamp. Any legitimate post-population plan edit to an
  owned Invariant blocks the next gate with `plan-drift`. This includes adding a `**Mutation exemption:**`.
  The only way forward is to restore the plan or re-populate, and re-population resets every Task to
  `pending`. `docs/operations.md` warns operators to decide exemptions in the architecture phase.
- Every Wave Gate of a G5b graph re-reads and re-parses the plan, even when the Wave owes nothing. A plan file
  that is moved, deleted or broken blocks gates that have no owned Invariant in scope.
- Comparing through the canonical form makes the stamp's field set part of the contract. A future field on
  `OwnerObligation` must be added to `canonicalObligation`, or drift detection silently ignores it.
- Graphs populated before G5b stay unchecked for their whole life. They gain owner verification only through
  re-population.
