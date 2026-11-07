# ADR-0062: Pure core, DomainResult end to end, simplicity axis

## Status
Accepted (2026-11-07). Shipped with the G2 skeletons feature
(`.claude/specs/2026-11-02-g2-skeletons/spec.md`, NFR-020, NFR-021, FR-045; plan
`.claude/plans/2026-11-02-g2-skeletons.md`, AD-14 and INV-2; interview Q2a, Q3a, Q4a, Q13a, Q14a). It applies
ADR-0042 (the TypeScript compiler API enters only through pure, parse-only seams, amended by ADR-0053) and
ADR-0043 (the pure core is enforced by the purity linter) to the new skeleton package. It adds no new
mechanism of its own.

## Context
G2 adds a lot of decision logic to the engine. That logic covers parsing the `**Export bindings:**` grammar,
reading TypeScript and Java declaration surfaces, resolving bindings against frozen types files, producing
canonical skeleton bytes, deriving one skeleton outcome per file_list path, scoping and judging contract
conformance at completion, and projecting status and brief sections. The work with effects is just as broad.
It reads frozen types files and implementation files, writes skeletons into the repository at spawn and at the
contract Task stop, refreshes them on a Contract Revision, and records engine digests in the State File. All of
this runs on both harnesses, Claude Code and Pi, and inside settlement paths that already have strict rules
about attempts and infrastructure failures.

Several forces act on how that logic is built:

- **Determinism.** A skeleton's bytes, an outcome and a conformance verdict have to be pure functions of the
  frozen surface and the observed files. Content-addressed recognition (ADR-0051), engine-digest subtraction
  from the proof scope (ADR-0052) and canonical bytes (ADR-0055) all break if a decision can see the clock,
  randomness or ambient file state.
- **Many expected refusals.** A malformed binding, a binding that spans contracts, a missing or generic or
  non-function alias, a drifted types file, an unparseable source, an unsupported language and a conformance
  violation are all normal results. Each one has to reach the operator with its reason, and a run must never
  crash or silently pass because of one.
- **Running graphs.** TaskGraphs populated before G2 are still in flight. They carry no `export_bindings`
  stamp and no skeleton records, and the engine must not invent obligations for them halfway through a run.
- **Two harnesses.** Anything harness-specific would be a second copy of the same rule, and would drift.
- **Simplicity is the user's primary axis** (Q3a). Retries, flags and new dependencies all cost more than the
  failure modes they would cover.

## Options Considered

1. **Pure core with `DomainResult` end to end, shells turn I/O into values, additive with no flag (chosen)**
   - Pros: Matches the binding precedent of ADR-0042 and ADR-0043, so the existing `no-io-in-pure-modules`
     rule enforces it with one directory entry and no new mechanism. Every decision can be tested from strings
     and graph data with no mocks, temp repos or fakes, and the property and matrix tests (INV-4, INV-5,
     INV-6) depend on that. A refusal is an ordinary value that the shell renders, so FR-045's "every expected
     failure is reported, never thrown" holds by construction. Both harnesses reach the same pure functions
     through the shared spawn reservation and settlement shells. Pre-G2 graphs need no migration.
   - Cons: Every expected failure needs a typed problem variant and a renderer, which means more ADT surface
     up front (`SurfaceProblem`, `ResolutionProblem`, `IdentifierProblem`, `ConformanceViolation`). Shells have
     to collect every observation before calling the core, so a read the core turns out not to need may still
     happen. With no retry, a transient write or read failure goes straight back to the operator.

2. **Pragmatic mocks at the boundaries (core modules call `fs` through injected or mocked ports)**
   - Pros: Less plumbing. A judge could read only the files it ends up needing, and tests could stub a read
     failure in one line.
   - Cons: It breaks INV-2 and the ADR-0043 purity rule. `engine/src/core/skeleton/` could no longer sit in
     `DEFAULT_PURE_MODULES`, so purity would depend on review instead of the linter. Mocked tests prove the
     wiring to the mock, not the behavior. Determinism would rest on every port implementation behaving well,
     and content addressing needs determinism to be a property of the code. Rejected.

3. **Exceptions for expected failures, caught at the handler**
   - Pros: Shorter code paths in the core, and it is familiar.
   - Cons: A thrown refusal has no static type, so a missing case shows up at runtime as an uncaught crash or
     as a generic message with the alias and file name missing. It contradicts NFR-020 and FR-045. The
     settlement path also has to tell a semantic refusal (which consumes an attempt) from an infrastructure
     failure (which never does), and a catch-all cannot make that distinction safely. Rejected.

4. **Retry or backoff around repository reads and writes**
   - Pros: Would ride out a transient filesystem error during materialization.
   - Cons: The no-clobber writer already guarantees that each file is complete or absent (NFR-021), and
     content-addressed recognition adopts any file a failed run left behind. A plain re-run therefore finishes
     the job without a retry loop, which would add timing, nondeterminism and test surface for no gain in
     correctness. Rejected (Q4a).

5. **A feature flag, or retroactive frozen-ADT checks on running graphs (Q13b)**
   - Pros: A flag gives an off-switch. Retroactive checks would catch shadowed or re-listed ADTs in Tasks of
     graphs that already exist.
   - Cons: A flag doubles the state space every test and reviewer has to consider, and the spec admits no new
     waiver or bypass (OOS-010). Retroactive checks change the completion contract of a run its operator
     already planned under the old rules, and they could fail a Task for a rule its brief never stated.
     Rejected.

## Decision
**Everything under `engine/src/core/skeleton/` is a pure function from strings and graph data to values.
Every expected failure is a `DomainResult` or a typed problem ADT. Shells convert I/O into values without
retry. The feature is additive, has no flag and adds no new runtime dependency.**

Concretely:

- **The pure package.** `bindings.ts`, `ts-surface.ts`, `java-surface.ts`, `resolve.ts`, `generate.ts`,
  `language.ts`, `outcomes.ts`, `scope.ts`, `conformance.ts`, `status.ts` and the CT-1 `types.ts`. The
  directory is listed as `engine/src/core/skeleton/` in `DEFAULT_PURE_MODULES`
  (`engine/src/linter/programmatic/no-io-in-pure-modules.ts`). The trailing-slash entry covers every current
  and future file in the package. `engine/tests/linter/programmatic/machine-purity.test.ts` pins the entry,
  and the closure audit backs it. The only exception to the import ban is the `typescript` grant to the
  `ts-surface.ts` seam (ADR-0053, INV-1). No file in the package reads `fs`, `child_process`, `os`,
  `process.*`, the clock or randomness (INV-2).
- **`DomainResult` end to end.** `DomainResult` from `engine/src/core/orchestration-contract/identity.ts` is
  the one result type, and the CT-1 function aliases in `types.ts` return it: `ParseIdentifierFn`, the four
  `Read*SurfaceFn` readers (`SurfaceProblem`), and resolution
  (`NonEmpty<ResolutionProblem>`, so the batch is refused with every problem named). Conformance violations,
  unsupported languages and skeleton outcomes are discriminated unions (`ContractConformance`,
  `SkeletonOutcome`, `ConformanceScope`), not exceptions or nulls.
- **Shells own every effect.** Repository reads and writes live only in
  `engine/src/orchestration/skeleton-writer.ts` (the one no-clobber writer, INV-3, with results
  `written | exists | refused{reason} | io-failed{message}`), `frozen-surface-observation.ts`,
  `skeleton-materialization.ts`, `contract-stub-materialization.ts`,
  `contract-conformance-observation.ts` and the existing handler shells. Each shell returns
  `DomainResult<…, string>`. A conformance read failure becomes an `implementation-observation-unavailable`
  infrastructure failure, which never consumes a semantic attempt and never passes. There is no retry or
  backoff anywhere. Idempotent re-runs and content-addressed adoption (ADR-0051) take that role.
- **Additive, no flag.** The G2 TaskGraph fields (`export_bindings`, `skeletons`,
  `tasks[].skeleton_outcomes`) are optional and parsed by `engine/src/state-file-wire.ts`, so a graph from
  before G2 loads unchanged. Materialization, the brief's Frozen signatures section and the status report all
  check for the missing `export_bindings` stamp and write or show nothing for such a graph. Status reports it
  as not applicable: "the TaskGraph was populated before export bindings were stamped".
- **One path for both harnesses.** Materialization runs inside the shared `registerTaskExecutionBatch`
  reservation (ADR-0048). Conformance runs in `settleExactImplementation`, which both harnesses' stops use, and
  in `reconcile-implementation-proof`. Contract stubs come from the shared SubagentStop dispatch, which
  `pi/subagent-stop.ts` also routes through. No new runtime dependency is added. TypeScript reading reuses the
  existing `typescript` dependency (ADR-0042), and Java reading is a hand-written lexer (ADR-0054, Q14a).

## Consequences

**Positive:**
- Purity is enforced by the linter, not by convention. A future file under `engine/src/core/skeleton/`
  inherits the rule with no upkeep.
- Every refusal reaches the operator as a named, typed reason, and the compiler forces each renderer to handle
  every variant. Resolution reports every problem in the batch, not just the first.
- The core is tested without mocks, through property and matrix tests over plain data. Determinism, and with
  it content-addressed recognition and engine-digest subtraction, is a property of the code.
- Running graphs are unaffected by the upgrade, and no migration or flag lifecycle needs managing.
- Claude Code and Pi cannot diverge on skeleton behavior, because neither has its own copy of it.

**Negative:**
- More type surface. Each new failure mode needs a problem variant and a renderer, so adding a refusal costs
  more than adding a `throw`.
- Shells read eagerly. For example, the conformance observation reads every in-scope file and types file
  before judging, even when the first violation would settle the result. The NFR-001 and NFR-002 two-second
  budgets show this is acceptable at 20 files, but the budgets limit how far the eager approach scales.
- With no retry, a transient filesystem error during materialization blocks the registration until someone
  re-runs it. Recovery is idempotent, but it is manual.
- **Known gap, not fully closed by the shipped code.** The intent is that pre-G2 graphs are not checked
  retroactively for frozen ADTs. Materialization, the brief and status gate on the `export_bindings` stamp,
  but `conformanceScope` (`engine/src/core/skeleton/scope.ts`) does not. A pre-G2 Task that claims a contract
  with a frozen types file, and has a production file in that file's language, is still owed the ADT
  shadowing and re-listing check at completion. Signature checks cannot fire there, because without a stamp
  there are no bindings. Closing the gap means adding one guard in `conformanceScope`: no stamp gives
  `not-owed`. That change belongs to the INV-5 owner module and is out of scope for this ADR.
