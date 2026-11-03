# ADR-0063: Owner verification follows the family schedule

## Status
Accepted (2026-11-03). Amends ADR-0034 (which obligations a Wave owes) and ADR-0035 (which paths sibling
coverage must reach). Found by the G2 skeletons run (issue #143), whose Wave 1 gate blocked on INV-6.

## Context
G5b made each owned invariant a Wave Gate obligation. As shipped, a Wave owed an obligation as soon as any of
its Tasks listed the owner or a sibling, and sibling coverage required the matrix test to import the owner and
**every** declared sibling. Population checked only that some Task listed the matrix test.

The G2 plan builds its families the way plans naturally do, across Waves:

- the contract Task T1 (Wave 1) writes a compiling stub of INV-6's owner `language.ts`;
- T9 (Wave 2) implements the owner, two siblings and the matrix test;
- T11 (Wave 4) and T13 (Wave 5) add four more siblings, each updating the matrix test.

Three things went wrong, and population accepted the graph anyway:

1. **Wave 1 owed INV-6 for a stub.** T1 listed the owner, so the Wave owed coverage and mutation. The matrix
   test does not exist until Wave 2, and mutating a `throw new Error("not implemented")` stub verifies nothing.
2. **Every family Wave required siblings that did not exist yet.** Coverage at Wave 2 required imports of files
   that Waves 4 and 5 create. The same applied to INV-3 at Wave 4 and INV-4 at Wave 2. The gate could not pass
   until the last sibling landed, so a plan could only satisfy it by putting the whole family in one Wave.
3. **Nothing caught it before execution.** The validator never compared the matrix test's Wave with the first
   Wave the gate would verify.

The implementation brief had the same gaps. It told T1 that its stub's changed lines "will be
mutation-verified", and it would have told T9 to import siblings that later Waves create.

## Options Considered

1. **Re-decompose around the rule.** Move the stub out of the contract Task, and put each family's siblings and
   matrix test into one Wave.
   - Pros: no engine change.
   - Cons: it gives up parallelism and fights the plan's dependency order. Every future plan with an incremental
     family hits the same block, and the contract Task still needs the stub so its acceptance tests compile.

2. **Fix only the sibling rule, and hand-add the matrix test to the contract Task.**
   - Pros: a smaller change.
   - Cons: a contract stub is still mutation-tested, and its baseline matrix test is red by construction. The
     validator gap stays.

3. **One family schedule shared by the gate, the brief and population (chosen).**
   - Pros: the gate, the brief and the validator answer from one pure rule, so they cannot disagree. A due path
     that is missing still fails closed.
   - Cons: a contract Task's stub is trusted to be a stub (see Consequences).

## Decision
**`engine/src/core/owner-verification/obligations.ts` (INV-3's owner) gains the family schedule, three pure
functions over the Task roster:**

- **`duePaths(tasks, wave, family)`:** the owner and siblings due by `wave`, in declared order. A path is due
  when no Task lists it (it exists already) or a Task of that Wave or an earlier one does. A path that only a
  later Wave lists is not yet due.
- **`owesInWave(tasks, contractTaskIds, wave, family)`:** the Wave owes the obligation when its owner is due and
  a Wave Task **other than a contract Task** changes the owner or a sibling. A matrix-test-only change still
  owes nothing. A contract Task writes at most compiling stubs, the same reading `entryPointErrors`
  (`acceptance-contract/binding.ts`) already makes when it never counts the contract Task as a writer.
- **`firstOwingWave(tasks, contractTaskIds, family)`:** the earliest Wave that owes it.

Their consumers:

- `waveOwnerDuty` selects through `owesInWave`. It reads the contract Tasks from the graph's
  `acceptance_contracts` (`contractTaskIdsOf`). A graph without contracts has none, so every Task's change owes:
  the omission verifies more, never less. The State File wire now passes `acceptance_contracts` into the duty it
  re-derives receipt authority from.
- Sibling coverage (`siblingCoverage`, `coverageOverFiles`, `decideCoverage`) no longer reads the obligation.
  It takes the matrix test and the explicit `due` paths. The runner shell computes them with `duePaths` over the
  graph and Wave it already holds.
- The runner plans mutants from `implementationTasks(graph)`, so a contract Task's stub is part of the base and
  never a change the mutants must cover.
- Plan validation (`validate-model-bindings.ts`) refuses a matrix test whose first Task lands after
  `firstOwingWave`. Contract Tasks are resolved with the one writer rule (`contractWriter`).
- The implementation brief renders the owner duties from the same schedule, through the gate's own
  `owesInWave` and `contractTaskIdsOf`. It names the siblings due by the Task's Wave, says that later Waves add
  the rest, tells a contract Task that its stub owes no verification yet, and tells a Task in a Wave the gate
  does not owe (a sibling built before the owner is due, a matrix-test-only change) that its duties bind from
  the first Wave that does.
- `duePaths` always leads with the owner and returns `NonEmpty<string>`, and coverage takes `NonEmpty<string>`,
  so an empty due list, which would pass coverage vacuously, is unrepresentable. `listsPath` in `plan-paths.ts`
  is the one file-list predicate the schedule and role classification share.

`invariantRoles` now takes `FamilyPaths` (owner, siblings, matrix test), so an `OwnerObligation` is classified
directly, without a second adapter.

## Consequences

**Positive:**
- A family can grow Wave by Wave. Each Wave's gate requires exactly the paths that exist by then, and a due
  path that is missing still blocks.
- A contract Wave that stubs an owner no longer blocks on a matrix test that cannot exist yet.
- Population refuses a schedule the gate could never satisfy, before any Task runs.
- The gate, the brief and the validator share one rule.

**Negative:**
- **A contract Task's stub is trusted to be a stub.** If a contract Task put real logic in an owner, that logic
  would sit in the base of the Wave that later implements the owner, and its lines would not be mutated. Contract
  review and the frozen acceptance tests are the guard, not owner verification. `references/executable-models.md`
  lists this under Known residuals.
- **The authority of in-flight Wave Gates changes.** A Wave Gate registered before this change, whose Wave now
  owes a different set, re-derives a different owner check. It refuses its old receipt as drift. Abandon it and
  start a fresh Wave Gate. The G2 run's blocked Wave 1 gate is such a run.

**Tests:**
- `engine/tests/core/owner-obligations.matrix.test.ts`: schedule rows (due by Wave, contract change owes
  nothing, owner not yet due), the G2 INV-6 regression across Waves 1–5, properties (due paths only grow, and
  the first owing Wave is the earliest one that owes), a population-validation sibling row, and a State File
  wire row: a contract-stub Wave's receipt authority owes nothing, and a contract-unaware one is refused.
- `engine/tests/orchestration/owner-verification-runner.test.ts`: a not-yet-due sibling is not required, and an
  owner change made only by a contract Task runs the baseline alone.
- `engine/tests/handlers/validate-model-bindings.test.ts`: a late matrix test is refused, incremental siblings
  are accepted, and a contract stub does not move the first owing Wave.
- `engine/tests/core/implementation-brief-owner-duties.test.ts`: the brief defers later siblings, a contract
  Task is owed no verification, and a sibling built before its owner is due is told its Wave owes nothing yet.
- `engine/tests/core/owner-verification-coverage.test.ts` and
  `engine/tests/acceptance/owner-verification-core.acceptance.test.ts`: coverage over explicit due paths.
