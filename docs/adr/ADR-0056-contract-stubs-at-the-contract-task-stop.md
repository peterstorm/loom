# ADR-0056: Contract stubs are written at the contract Task's SubagentStop

## Status
Accepted (2026-11-07). Records AD-9 of the G2 skeletons plan
(`.claude/plans/2026-11-02-g2-skeletons.md`; spec `.claude/specs/2026-11-02-g2-skeletons/spec.md`,
FR-023, AS-043, AS-044, AS-045, interview Q7a). Shipped on branch `feat/g2-skeletons` by T13, building
on the generator and resolver of T7, the outcome and language predicates of T9 (INV-4, INV-6), the
skeleton records of T10 and the no-clobber writer of T11 (INV-3). T14 and T15 changed the contract
brief and decompose rule 12 to match.

## Context

A contract Task writes an Acceptance Contract's types file and acceptance tests. Its Wave Gate must
see those tests fail for a behavioral reason (RED) before the Acceptance Freeze. The tests import
the production files the contract binds. Before G2 the contract Task wrote those imported files by
hand, as stubs. That was work the implementer did off the frozen surface, with no fixed format, and
it put production paths into a contract Task's `file_list`. FR-023 says the engine MUST write these
stubs, in the same skeleton format as US3 and US4, and MUST NOT ask the contract Task to write them.
The spec left open when the engine writes them (AS-043, open question 2).

The timing is the hard part. Implementation-Task skeletons are generated from a *frozen* types file
when a Task registers (ADR-0048; signatures come only from the frozen types file, ADR-0049). Contract stubs cannot wait for the freeze, because RED is
observed with them already present: without them the acceptance file fails to collect, which G1
refuses as a non-behavioral RED. They cannot be written before the contract Task runs either,
because the types file they are generated from does not exist yet. So the stub point has to be
after the types file is written, before the acceptance tests are first run, and inside the contract
Task's own attempt. Several more constraints apply:
- Both harnesses must hit that point. Claude Code stops through
  `engine/src/handlers/subagent-stop/dispatch.ts`; Pi settles results in `pi/subagent-stop.ts`.
- Only the I7 stop checks (`runStopChecks`) run the acceptance tests before the Wave Gate. Stubs
  that appear after them would let a contract Task stop with tests that cannot import their subject.
- Freeze and Contract Revision semantics must not change (OOS-008).
- The contract Task's agent can edit the types file again after a stop-check block. Stubs written
  by an earlier stop must then follow the new canonical bytes, but a file anyone else wrote must
  never be overwritten.

## Options Considered

1. **At the contract Task's SubagentStop, before the stop checks and before settlement (chosen)**
   - Pros: This is the one point where the types file exists and RED has not yet been observed. Both
     harnesses already have a stop shell for it, and the stop checks that run right after it see the
     stubs. It runs once per stop, not once per edit. A blocked stop keeps the same agent working,
     and its next stop refreshes untouched stubs from the edited types file.
   - Cons: The stubs come from a types file that is not frozen yet, so a later edit to the types file
     needs a refresh path (create, adopt or refresh) instead of a single write. The contract Task's
     agent never sees the stubs during its own attempt, only at stop.

2. **A PostToolUse hook on every write to a types file**
   - Pros: Stubs appear as soon as the types file is written, so the agent could run the acceptance
     tests itself mid-attempt with the stubs in place.
   - Cons: More entry points: every write tool on both harnesses, plus Pi's separate result path. It
     does work on every edit, including half-written types files that do not parse, and that produces
     problem noise. It is a second writer schedule on top of the stop, which would still have to
     check the stubs before the stop checks run.

3. **At Wave Gate start**
   - Pros: One place, run once, after the contract Task has finished editing.
   - Cons: Neither the contract Task's agent nor the I7 stop check would ever see the stubs. Every
     acceptance file would fail to collect at the stop, and the stop check would report a failure the
     agent cannot fix. It also moves the write out of the contract Task's attempt, so its bytes would
     look like foreign changes to whatever observed them next.

4. **Keep hand-written stubs from the contract Task**
   - Pros: No new engine entry point.
   - Cons: Contradicts FR-023. The stubs would follow no canonical format, so the untouched-skeleton
     judgment (INV-4) and the conformance checks of US5 and US6 could not apply to them.

## Decision
**`materializeContractStubs` (`engine/src/orchestration/contract-stub-materialization.ts`) writes and
records the stubs of every contract the stopping Task is the contract Task of. Both stop shells run
it before `runStopChecks` and before settlement.**

- **Who it runs for.** `stubbedContracts(graph, taskId)` selects the typed Acceptance Contracts whose
  `contractRole` for the stopping Task is `contract-task` and which have at least one export binding.
  Any other Task gets nothing and no repository probe.
- **Entry points.** Both shells call the total wrapper `contractStubStopNote(store, taskId)`, which
  never throws and returns the line the stop must say, or `null`.
  - Claude Code: `dispatch.ts` calls it for an `impl` stop with observed authority, writes the note to
    stderr, and prefixes it to any stop-check message.
  - Pi: `reportContractStubs` in `pi/subagent-stop.ts` calls it in the `implementation` route before
    `reportImplementationStopChecks` and `applyImplementationPiResult`, and adds the note to the
    stop-check notes the parent model gets.
- **Steps per contract.**
  1. *Read.* `canonicalContractSkeletons` observes the contract's current types file
     (`observeFrozenSurface(..., "current")`), not a frozen copy. It resolves each binding separately
     with `resolveBindings`, so one vanished alias never blocks the other bindings' stubs.
  2. *Generate.* Each resolved binding whose path `skeletonLanguageOf` (INV-6) maps to the types
     file's language gets the same canonical bytes registration writes, from `generateSkeleton`. A
     language mismatch is a `language-mismatch` problem. An unsupported path gets nothing.
  3. *Plan.* The pure `planCandidateRefresh` (`core/skeleton/refresh-plan.ts`, one action per canonical skeleton) decides
     each path's action through `presentSkeletonOf` (INV-4): `create` a missing path; `adopt` a file that already holds the canonical bytes;
     `refresh` an untouched stub whose canonical bytes changed after a stop-check block and further
     types-file edits. A file anyone else wrote gets no action.
  4. *Write.* `createSkeleton` and `refreshSkeleton` in `skeleton-writer.ts` (INV-3) never write a
     frozen path and never clobber. A refresh is conditional on the observed digest.
  5. *Record.* Each stub becomes a `SkeletonRecord` with `origin: "contract-stub"`, its `engineSha256`
     and its `typesSha256`. The records are installed in one locked `updateAndReturn`, and only
     records that changed are written. A second stop over the same bytes writes and records nothing.
- **Scope of stubs.** Stubs are written for every bound file of the contract, which is a superset of
  what the acceptance tests import. This is deterministic and needs no walk of the import graph.
- **Unresolvable bindings.** These write no stub. Their problems are rendered into the stop's output
  (`renderContractStubs`) and into status. They never block the stop. The contract gate then sees an
  uncollected acceptance file, which G1 already refuses as a non-behavioral RED. Infrastructure
  failures (unloadable State File, unresolvable root, a records update that fails after the writes)
  are an error string in the same note. Writes come before the locked update, so a refused update
  leaves canonical bytes that the next stop or registration adopts by content (ADR-0051).
- **Plan shape.** Bound paths leave the contract Task's `file_list`. AD-3's `validateExportBindings`
  refuses a bound path listed there, because the engine writes it. The contract brief and decompose
  rule 12 say the engine writes the stubs (FR-041, AS-045).
- **Freeze and later Waves.** Freeze semantics are unchanged (OOS-008, AS-044). A stub is not a
  frozen path. At its owning implementation Wave it is an ordinary skeleton record: it reports
  "skeleton written (contract stub)", and the US5 and US6 conformance checks apply to it. Engine-byte
  subtraction (ADR-0052) keeps an untouched stub out of the contract Task's out-of-scope set.
- **Shared with revision.** `canonicalContractSkeletons`, `writePlanned` and `writeFailure`
  (`orchestration/skeleton-refresh.ts`), `observeSkeletonPaths` (`orchestration/skeleton-observation.ts`)
  and the planner are also used by the Contract Revision refresh (ADR-0057, `orchestration/skeleton-revision.ts`),
  so both refresh paths generate, observe, decide and write the same way.

## Consequences

**Positive:**
- FR-023 holds on both harnesses through one module, and the contract Task's agent writes no
  production file.
- The stop checks and the contract gate see stubs in the canonical skeleton format. RED is then
  observed against the real frozen-signature surface, not against a hand-made placeholder.
- A stub is a skeleton for its owning Wave, so the untouched-skeleton judgment, engine-byte
  subtraction, status outcomes and conformance checks need no special case for contract stubs.
- Stops are idempotent. A repeated stop over unchanged bytes writes and records nothing, and a
  stop after a types-file edit refreshes only untouched stubs.
- One bad binding costs only its own stub, and the problem is named in the stop output.

**Negative:**
- Stubs come from a types file that is not frozen yet, so the create, adopt and refresh plan is more
  complex than a one-shot write. Edits between stops are handled only by the next stop's refresh.
- The contract Task's agent cannot see the stubs mid-attempt. If it runs the acceptance tests itself
  before stopping, they fail to import their subject until the first stop writes the stubs.
- Every bound file is stubbed, including ones no acceptance test imports. Those files exist earlier
  than they strictly need to.
- Stub problems are a note, never a block. A contract Task with an unresolvable binding still
  stops. The refusal comes at the contract gate as a non-behavioral RED, one step later than the
  stop that could have named it.
- The step runs on every contract-Task stop and adds a State File load, plus a types-file read when
  the Task stubs a contract, to that stop path.
