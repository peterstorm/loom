# ADR-0060: One skeleton-outcome derivation shown in brief and status

## Status
Accepted (2026-11-07). Shipped by the G2 skeletons run (plan `.claude/plans/2026-11-02-g2-skeletons.md`, AD-13;
interview Q12a; owner of plan invariant INV-4). Builds on ADR-0048 (skeletons materialize per Task inside the
shared spawn reservation), ADR-0051 (stamped, content-addressed skeleton records) and ADR-0055 (canonical skeleton
bytes).

## Context
G2 makes the engine decide, for every non-test file_list path of an implementation Task, whether it writes a
skeleton there. FR-030 says each such path gets exactly one of five outcomes: `skeleton written`,
`no bound exports, no skeleton`, `contract has no types file, no skeletons`, `unsupported language, no skeleton`,
or `exists, not skeletonized`. FR-040 says `helper orchestration status` and the implementer brief both show that
outcome and every stale flag (FR-033). Several acceptance scenarios (AS-038, AS-040 and others) say the brief and
status name a file with the same exact string. FR-045 says every expected failure, such as a refused binding, a
missing alias or an unsupported language, becomes a reported outcome and never a crash.

At least five places need the answer. Spawn materialization decides what to write. The contract-stop step
decides which contract stubs it may write. The Contract Revision refresh decides what to regenerate and what to
flag stale. The status report shows the outcome. The brief tells the Agent what it owns. Most of them also need
the related judgment of whether a file on disk is still an untouched engine skeleton. That judgment compares the
current digest with the engine's record (ADR-0051) or with the canonical bytes (ADR-0055). If each reader worked
the answer out itself, the precedence rules and digest comparisons would drift. One reader might say
`skeleton written` where another says `exists, not skeletonized`, and the operator would see two different
answers for one path.

There is also a timing problem. Status and the brief are read before a Task spawns, when nothing is recorded
yet, and again after registration has recorded what the engine did. The operator needs exactly one outcome for a
path at both times, and a read path must not write state.

## Options Considered

1. **One pure derivation that owns the precedence and the untouched-skeleton judgment, with outcomes recorded at registration and projected before it (chosen)**
   - Pros: every consumer gets the same outcome for the same inputs, by construction. The precedence lives in
     one place, and its matrix test (INV-4) proves each consumer calls it. The derivation is pure, so it can be
     tested exhaustively with no file system. Status and the brief can show an outcome before the spawn without
     writing anything.
   - Cons: every consumer must build the same per-path observation (absent, or present with its current digest
     and its canonical digest). Before the spawn, a reader shows a projection that can still change if the
     files change before registration.

2. **Each consumer derives its own outcome from the graph and the disk**
   - Pros: no shared module and no shared observation type, so each shell reads only what it needs.
   - Cons: five copies of the five-step precedence and of the digest comparison. The FR-030 strings would be
     written in several places. Drift between status and the brief is exactly what FR-040 and the acceptance
     scenarios forbid, and nothing would catch it except the scenarios that happen to cover it.

3. **Persist projected outcomes into the TaskGraph before the spawn, and have every reader read the stored value**
   - Pros: readers do no derivation, so they only read.
   - Cons: status and the brief would write state, because something has to persist the projection before the
     spawn. A read path that mutates the State File breaks the rule that only registration and settlement write
     it. Stored projections also go stale when files change between the write and the spawn. Rejected in the
     plan.

4. **Derive outcomes only at registration, and show nothing before the spawn**
   - Pros: there is only one place where outcomes are computed and nothing is projected.
   - Cons: the brief is rendered for a Task before its registration records anything, so the brief could not
     say which files are skeletons. FR-024 and FR-040 would fail. Status would be empty for the whole period
     when the operator most needs to see what the spawn will do.

## Decision
**`engine/src/core/skeleton/outcomes.ts` is the single owner of skeleton outcomes. It exports
`skeletonOutcomesOf`, `isUntouchedSkeleton`, `presentSkeletonOf` and `renderSkeletonOutcome`. Registration records the outcome it acted
on. Status and the brief show the recorded outcome when there is one and otherwise the one the same derivation
projects now.**

- **Types** (`engine/src/core/skeleton/types.ts`). `SkeletonOutcome` is a closed union:
  `skeleton-written { origin: "spawn" | "contract-stub" | "revision" }`, `no-bound-exports`,
  `contract-has-no-types-file`, `unsupported-language { reason }` and `exists-not-skeletonized`.
  `PathObservation` is `absent | present { sha256, canonicalSha256 | null }`. `SkeletonOutcomesFn` is
  `(graph, taskId, observations: ReadonlyMap<string, PathObservation>) => readonly PathSkeletonOutcome[]`.
- **Precedence, first match wins.** For each production path of the Task (`productionFiles` in `scope.ts`):
  1. present, and `isUntouchedSkeleton` is true → `skeleton-written` with the record's origin (`spawn` when
     canonical bytes are adopted with no record);
  2. any other present path → `exists-not-skeletonized`;
  3. no export binding names the path → `contract-has-no-types-file` when the Task claims a `Types file: none`
     contract, else `no-bound-exports`;
  4. bound, but `skeletonLanguageOf` (AD-15, `language.ts`) returns unsupported → `unsupported-language`;
  5. bound and supported → `skeleton-written { origin: "spawn" }`, which means "to write".

  A path the observations do not mention counts as absent. An unknown task id gives an empty list, not an
  exception.
- **Untouched judgment.** `isUntouchedSkeleton(record, currentSha, canonicalSha)` is true only when the file
  exists and its digest equals the record's `engineSha256` or the canonical digest. Spawn materialization
  (`engine/src/orchestration/skeleton-materialization.ts`) reaches it through `skeletonOutcomesOf`, which
  applies it at precedence step 1, and `presentSkeletonOf`, which says whether an untouched file is already
  canonical or engine bytes to refresh. The contract-stop step (`engine/src/orchestration/contract-stub-materialization.ts`)
  and the revision refresh (`engine/src/orchestration/skeleton-revision.ts`) share one pure planner,
  `planSkeletonRefresh` (`engine/src/core/skeleton/refresh-plan.ts`, candidate-driven and record-driven),
  which acts on `presentSkeletonOf`; settlement digest subtraction (`engine/src/core/implementation-application.ts`)
  calls `isUntouchedSkeleton` directly. None of them compares digests itself.
- **Exact strings.** `renderSkeletonOutcome` is an exhaustive `ts-pattern` match that returns the five FR-030
  strings. It is the only place those strings are produced.
- **Recorded and projected.** Registration (`engine/src/core/validate-task-execution.ts`) writes the Task's
  `skeleton_outcomes` inside the spawn reservation (ADR-0048). `taskSkeletonOutcomes` in
  `engine/src/core/skeleton/status.ts` returns one entry per path in file_list order. Each entry is the recorded
  outcome marked `recorded`, or the outcome `skeletonOutcomesOf` derives now marked `projected`. Read paths never
  persist a projection.
- **Status.** `skeletonStatusReport` builds the `skeletons` part of `LoomStatusDocument`
  (`engine/src/core/loom-status.ts`). It is a closed union of `not-applicable | unobserved | reported`. The
  `reported` case lists every current-Wave Task with its per-path outcome and basis, every stale record
  (`staleSkeletons`, FR-033) and every stage-two binding problem. The status shell
  (`engine/src/handlers/helpers/orchestration.ts`) observes the paths through `observeSkeletons`
  (`engine/src/orchestration/skeleton-observation.ts`, the observation the brief shell reads too) and passes
  them in. A TaskGraph populated before the binding stamp is reported as `not-applicable`, not as an error. A
  report status could not observe blocks nothing (registration observes again and is the authority), but
  while a spawn is owed status names it under the `skeletons-unobserved` reason.
- **Brief.** `engine/src/core/implementation-brief.ts` renders the Frozen signatures section from
  `taskSkeletonOutcomes` and `renderSkeletonOutcome`, with stale flags from `renderStaleSkeleton`. Status and the
  brief therefore cannot disagree about a path.
- **Blocked spawn.** When the report carries stage-two problems and spawns are owed,
  `engine/src/core/implementation-window.ts` replaces `spawn-wave-implementation` with a
  `repair-skeleton-bindings` recovery whose blocked reason is `skeleton-bindings-unresolved`. It names every
  problem and points to a Contract Revision or a re-plan, because registration would refuse the spawn with the
  same problems.
- **Invariant (INV-4).** Only `outcomes.ts` orders the outcomes or judges whether a skeleton is untouched. Every
  sibling calls it. `engine/tests/core/skeleton-outcomes.matrix.test.ts` has a row for each consumer
  (materialization, contract stubs, revision, status, brief). `engine/tests/core/skeleton-outcomes.test.ts`
  holds the property that every non-test path gets exactly one outcome. The derivation and the report emit no
  logs and no metrics, and every expected failure is an outcome or a report variant (FR-045).

## Consequences

**Positive:**
- FR-030 and FR-040 hold by construction: one function decides each path's outcome, and one function renders
  its string, for every reader.
- The precedence and the digest comparison can be tested exhaustively without I/O. A new consumer gets
  consistent behavior by calling the owner, and the INV-4 matrix catches a consumer that does not.
- The operator sees each path's outcome before and after the spawn. The `recorded`/`projected` basis says
  whether the engine has acted yet. Read paths never write state.
- A stage-two binding problem becomes a named blocked reason with a repair command instead of a spawn that
  registration then refuses.

**Negative:**
- A projected outcome is only a forecast. If a file appears or changes between status and the spawn,
  registration can record a different outcome, for example `exists, not skeletonized` where status projected
  `skeleton written`. The basis label tells the operator this, but the forecast can still be wrong.
- Every shell that reads outcomes must observe the paths and compute canonical digests, which means regenerating
  canonical bytes from the frozen surface. Status and brief rendering therefore do the same generation work that
  registration does.
- The first-match precedence is a fixed policy. A present file that is not an untouched skeleton is always
  `exists, not skeletonized`, even when it is bound and in an unsupported language. The operator sees one
  outcome, not every reason that applies.
- Adding an outcome kind means changing the union, the precedence, the renderer, the State File wire parser and
  every exhaustive match. That is intentional, but it costs more than adding a string.
