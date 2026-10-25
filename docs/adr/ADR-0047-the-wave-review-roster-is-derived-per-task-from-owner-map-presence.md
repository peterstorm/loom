# ADR-0047: The Wave review roster is derived per Task from owner-map presence

## Status
Accepted (2026-10-25). Fixes a G5b defect against FR-022
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`; plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-9). Amends the issuance half of ADR-0039.

## Context
FR-022 says the Wave review Context Packets for **code-reviewer and architecture-tech-lead** must carry an
engine-issued owner map for every owned Invariant whose family the reviewed Task touches, together with the
second-copy rule. ADR-0039 shipped the section and `OWNER_MAP_ROLES = ["code-reviewer",
"architecture-tech-lead"]`. But the Wave review roster was one constant of five reviewers (code-reviewer,
silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer). `architecture-tech-lead`
was never issued at a Wave Gate. Its half of FR-022 was dead code, and the second-copy lens never reached the
reviewer whose job it most is: ownership, seams and duplication of a rule across modules are the
architecture reviewer's lens (it preloads `deepen` in review mode).

Constraints:

- **Slot authority is positional.** A Review Run binds `slot_authority[i].agent === expected_agents[i]`, and
  the state-file parser enforces that order. Slot and request ids hash the subject `{ role, taskId }`, the
  Task run and the batch epoch, never the roster.
- **Selection has one owner.** Which Invariants a Task touches is decided by `obligationsTouchedBy` in
  `engine/src/core/owner-verification/obligations.ts` (INV-3's owner). A second selection rule is forbidden
  (ADR-0034, ADR-0039).
- **Byte identity (SC-005).** Packets that need no owner map keep their exact bytes.
- **Frozen reviewer guidance.** `references/reviewer-protocol-v2/agents/architecture-tech-lead.md` already
  exists and `agents/architecture-tech-lead.md` carries the same Context Packet bootstrap as the other Wave
  reviewers, so a schema-2 Wave request for it is valid without editing frozen text.
- **Persisted state.** Review Run parsers (`state-file-wire.ts`, `findings.ts`) accept any non-empty unique
  `expected_agents` with matching ordered slots; only the engine's own comparisons pinned the five.

## Options Considered

1. **Per-Task roster derived from owner-map presence, architecture-tech-lead appended last (chosen)**
   - Pros: the roster follows the same fact that issues the section, so the two can never disagree. Appending
     last keeps every base reviewer's index, slot id, request id and packet bytes unchanged. Tasks that touch
     no owned family keep exactly the base five, so their persisted runs parse and resume unchanged. No
     persisted-state migration is needed.
   - Cons: the roster is no longer a constant. Every roster comparison has to derive it from protected state.
     A batch with owner-mapped Tasks grows by one request per such Task.

2. **Add architecture-tech-lead to every Wave Task's roster**
   - Pros: one constant roster, no derivation.
   - Cons: a sixth reviewer (and its model spend) on every Task, including Tasks with no owner map. It changes
     every in-flight run's roster, and a five-agent persisted run would no longer equal the roster, which is a
     state migration.

3. **Drop architecture-tech-lead from `OWNER_MAP_ROLES`**
   - Pros: no roster change; the dead code goes away.
   - Cons: contradicts FR-022 as written. The second-copy lens would reach only the general code reviewer.

4. **Keep the persisted `expected_agents` as the authority instead of re-deriving**
   - Pros: no derivation at comparison sites.
   - Cons: a run installed with a short roster would settle with it. The comparison exists to prove the run
     carries the engine's exact roster; trusting the persisted copy makes that proof circular.

## Decision
**A Wave Task's ordered reviewer roster is a pure function of whether its review packets carry the owner map:
`BASE_WAVE_REVIEW_AGENTS` (the five), or `OWNER_MAPPED_WAVE_REVIEW_AGENTS` (the five with
`architecture-tech-lead` appended last).**

- `engine/src/core/agent-catalog-projections.ts` holds both rosters, the `WaveReviewRoster` type (exactly one
  of the two; no other ordering or subset is representable), `WaveReviewRole`, `isWaveReviewRole` and
  `waveReviewRoster(ownerMapped)`.
- `engine/src/core/wave-review-authority.ts` holds the one home of owner-map presence,
  `ownerMapObligations(graph, schemaVersion, task)`: schema 2 only, and exactly
  `obligationsTouchedBy(ownerScopeOf(graph), task.file_list)`. No second selection rule.
- There is exactly one presence-to-roster derivation, the private `waveTaskReviewDerivation`, which returns
  a Task's obligations together with the roster their presence picks. Packet issuance
  (`prepareWaveReviewBatch`) renders the owner map from that same result and orders its subjects from that
  same roster, so the section and the roster cannot disagree. `waveTaskReviewRoster(graph, schemaVersion,
  task)` and `waveTaskReviewRosters` (every registered Task, in registration order) project the roster from
  it for every other site. `waveReviewSubjects(rosters)` orders a batch: spec-check first, then each Task in
  registration order with its own roster.
- `OWNER_MAP_ROLES` is typed `satisfies readonly WaveReviewRole[]`, and a test asserts every owner-map role is
  on the owner-mapped roster, so neither role can silently go unissued again.
- Every roster comparison derives the Task's roster from protected state:
  - the locked install (`installWaveReviewRunsTransition`), which writes it as `expected_agents`;
  - persisted-batch recovery (`classifyPersistedWaveBatch`);
  - completed-protocol verification (`verifyCompletedWaveProtocols`).
- A persisted Review Run is checked against that roster by one pure function,
  `waveRunRosterProblem(graph, schemaVersion, task, run)`. It returns a typed refusal: `expected-agents-differ`
  when `expected_agents` is not the derived roster, or `slot-authority-differs` when `slot_authority` is
  missing or does not bind that roster's agents in order, one slot per agent. Every site that compares a
  persisted run uses it, at the same strictness, and keeps its own refusal text:
  - protocol-v2 slot membership (`waveReviewerSlotProblem`);
  - exhausted-run restart (`prepareExhaustedWaveGateRestart`);
  - the locked install's replay of an existing run (`installWaveReviewRunsTransition`), which also compares
    slot ids;
  - reviewer retries of a current-protocol run (`currentWaveTaskReviewRetries`). A legacy run without
    `reviewer_protocol` keeps its structural slot check only.
- The legacy, CLI-created Review Packet path (`handlers/helpers/review-packet.ts`) has no owner map and keeps
  the base five.

The architecture-tech-lead request is minted from the catalog like every other reviewer: profile
`focused-review`, required Skill `deepen` (the spawn task carries `LOOM_REQUIRED_SKILL: deepen`, which Pi's
spawn gate requires). Its packet is a Reviewer Protocol v2 packet with the payload schema, impact rubric,
frozen Wave source and the owner-map section.

## Consequences

**Positive:**
- FR-022 holds for both roles. The architecture reviewer receives the owner map for every Task that touches
  an owned family, and the Wave does not complete until it settles.
- Packets, slot ids and request ids of the base five are byte-identical with or without the owner map, and
  Tasks without one are untouched. SC-005 still holds.
- One decision (owner-map presence) drives both the section and the roster, so they cannot drift.

**Negative:**
- A Wave Review Run installed before this change for a Task that touches an owned family carries only the base
  five. Its derived roster is now six, so the retry and membership checks refuse it, fail closed, and the
  Wave Gate blocks with `Task <id> active Review Run lacks engine-issued exact slot authority`. The operator
  abandons that run and starts a fresh Wave Gate. Only runs started between G5b's merge and this fix, over
  stamped graphs, can be in that state. Runs over unstamped graphs and Tasks touching no owned family are
  unaffected.
- A Wave batch grows by one request per owner-mapped Task. Pi's eight-request chunking already handles it.
- The roster now depends on the Task's `file_list` and the graph's `owner_obligations` stamp. Both are already
  part of packet and batch authority, so a change to either already re-derives the Review Packet.

**Tests:**
- `engine/tests/core/agent-catalog.test.ts`: roster order, append-last, `waveReviewRoster`, owner-map roles
  on the roster.
- `engine/tests/core/owner-map-packet.test.ts`: roster derivation with and without an owner map (unstamped,
  empty stamp, untouched, schema 1), six versus five requests in one batch, the architecture packet's owner
  map, unchanged base-reviewer slot and request identity, issuance rosters equal to `waveTaskReviewRosters`
  for a mixed Wave, and each `waveRunRosterProblem` refusal (differing `expected_agents`; missing, short or
  reordered slot authority) beside an admitted six-agent owner-mapped run and five-agent plain run.
- `engine/tests/core/wave-review-authority.test.ts`: subject order and persisted-batch classification over
  mixed rosters (property).
- `engine/tests/handlers/helpers/programs/reviewer-protocol-wave.integration.test.ts`: end-to-end from a
  stamped graph through the CLI. It issues six reviewers, both owner-map packets carry the section, and the
  Wave completes only after architecture-tech-lead settles. A pre-fix five-agent run for an owner-mapped Task
  is refused by reviewer retries and by slot membership (`waveReviewerSlotProblem`), while a plain Task's
  five-agent run is admitted. Exhausted-run restart over an owner-mapped Task binds all six slots and refuses
  the five-agent run.
