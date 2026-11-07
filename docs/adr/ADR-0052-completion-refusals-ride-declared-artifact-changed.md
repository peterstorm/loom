# ADR-0052: Completion refusals ride the existing declared-artifact-changed obligation

## Status
Accepted (2026-11-07). Records AD-5 of the G2 skeletons plan
(`.claude/plans/2026-11-02-g2-skeletons.md`; spec `.claude/specs/2026-11-02-g2-skeletons/spec.md`,
FR-012 through FR-021, interview Q10a). Shipped on branch `feat/g2-skeletons` by T12, building on the
conformance judge of T8 (ADR for AD-11) and the skeleton records of T10 and T11 (AD-4).

## Context

G2 has the engine write a deterministic skeleton at every not-yet-existing bound path of an
implementation Task before the attempt baselines are captured. The skeleton holds each bound export
with the frozen signature and an initializer that throws `unimplemented: <name>`. Completion must
then refuse a Task that leaves that work undone or breaks the frozen surface: a bound export that is
deleted, renamed, retyped or still unimplemented, and a local declaration that shadows a frozen ADT
or re-lists its variants (FR-013 to FR-017). The pure judge `judgeConformance`
(`engine/src/core/skeleton/conformance.ts`) produces those verdicts. The open question was how a
verdict gets into Proof, the engine's single place for deciding whether an implementation attempt
completed, and from there into settlement receipts and the retry lineage.

Several forces apply. FR-021 says violations are "reported through the existing declared-artifact
channel". The Proof wire is closed: every obligation kind and failure kind has a parser, a receipt
encoding, a retry-appendix rendering and drift matchers (`ATTESTATION_DRIFT_BASE_KINDS`), and each
new kind multiplies that surface. Proof is reached through several settlement paths: the exact
settlement both harnesses' stops use (`settleExactImplementation`), the Pi untrusted stop resolution
(`implementation-application.ts`), and the stored-evidence reconcile
(`reconcile-implementation-proof.ts`). A path that forgets conformance must not pass a Task by
default. Engine-written bytes create a second problem (FR-012). An untouched skeleton differs from the
Wave-start baseline, so the existing `declared-artifact-changed` test would count the engine's own
bytes as the implementer's production. A contract stub written at the contract Task's stop would also
show up as an out-of-scope repository write for any Task that observes it.

Finally, an untouched skeleton has to be refused for the right reason. If the changed test ran
first, an untouched skeleton (after engine-byte subtraction) would fail as `declared-artifact-not-changed`.
That tells the implementer nothing about the frozen signature it still has to fill (AS-024).

## Options Considered

1. **A new failure variant on the existing `declared-artifact-changed` obligation (chosen)**
   - Pros: Widens one union (`ProofFailure`) and leaves the obligation set, its parsers and its drift
     matchers alone. Violations sit beside the existing `declared-artifact-not-changed` and
     `declared-artifact-drifted` failures for the same artifact, so receipts, status and the retry
     appendix already key them by file. Evaluation order inside one arm decides `still unimplemented`
     versus `not-changed` in one place. Matches FR-021's wording directly.
   - Cons: The `declared-artifact-changed` arm now answers two questions (did it change, does it
     conform), so its name no longer covers all of what it checks. Conformance can only be owed for
     files that are declared artifacts, which holds by construction because the scope draws on the
     Task's own production files.

2. **A new obligation kind `declared-artifact-conforms`**
   - Pros: Names conformance as its own duty, so a Proof lists "changed" and "conforms" separately.
     Evaluation order between the two would not be an issue inside one arm.
   - Cons: A wider wire and retry surface for the same information: a new obligation parser, a new
     satisfied-evidence variant, a new derivation rule in `deriveProofObligations`, new receipt and
     drift handling, and a second failure for the same artifact. Ordering between the two obligations
     would still need a rule so that an untouched skeleton is not reported twice, once as not changed
     and once as unimplemented.

3. **The new variant, but with conformance as an optional observation field ("absent means not owed")**
   - Pros: Smallest diff at every caller, because existing call sites compile unchanged.
   - Cons: A settlement path that forgets to observe conformance would silently pass a Task that left
     every skeleton unimplemented. The safety property would then depend on every caller remembering,
     with nothing enforcing it.

4. **Report violations outside Proof (a Wave Gate check or a separate blocker)**
   - Pros: No change to the Proof wire at all.
   - Cons: Contradicts FR-021. The Task would settle `implemented` with frozen exports still throwing,
     the semantic retry would never see the violations, and the refusal would land a Wave later than
     the attempt that caused it.

## Decision
**Completion refusals are a new `declared-artifact-contract-violated` failure variant of the existing
`declared-artifact-changed` obligation. Every settlement path decides a `contractConformance`
observation explicitly, and engine-written bytes are subtracted before the changed test runs.**

- **Failure variant** (`engine/src/core/proof-obligations.ts`). `ProofFailure` gains
  `{ kind: "declared-artifact-contract-violated"; artifact; violations: NonEmpty<ConformanceViolation> }`.
  `ConformanceViolation = { subject, reason, remedy }`, and `reason` is one closed set:
  `deleted | renamed | retyped | still-unimplemented | shadows-frozen-adt | re-lists-frozen-variants`.
  The `remedy` names the fix where one exists, for example `Extract<FrozenUnion, …>` for a re-listed
  union. The proof channel declares these shapes structurally, because importing CT-1's
  `core/skeleton/types` would close an import cycle through the TaskGraph. The settlement shells pass
  the observation's `ContractConformance` straight through, so a reason CT-1 adds that this list lacks
  fails to compile.
- **Observation** (`ContractConformance`). `{ kind: "not-owed" } | { kind: "judged"; violations:
  ReadonlyMap<artifact, NonEmpty<ConformanceViolation>> }`. An empty violation set is
  `judged` with an empty Map, never an empty array.
- **Evaluation order.** `evaluateDeclaredArtifactChanged` looks up the artifact's violations first and
  fails with `declared-artifact-contract-violated` if there are any. Only then does it apply the
  existing changed test. An untouched skeleton is refused as `still-unimplemented` (AS-024), never as
  `declared-artifact-not-changed`.
- **One observation shell.** `observeContractConformance`
  (`engine/src/orchestration/contract-conformance-observation.ts`, INV-5 sibling) is the only reader.
  It asks `conformanceScope` (`core/skeleton/scope.ts`, INV-5 owner) which files and contracts are
  owed. A `not-owed` scope reads nothing; that covers attested Tasks and the `documentation-only` and
  `generated-artifact` waivers (FR-019, AS-037), and FR-020 adds no new waivers. An owed scope reads
  each in-scope contract's frozen types file and each in-scope file without following links, then
  calls the pure judge. A missing file reads as absent, so its exports are refused as `deleted`. Any
  other read failure is returned as a message.
- **Every path decides it.**
  - `settleExactImplementation` (`handlers/helpers/exact-implementation-settlement.ts`) observes
    conformance before evaluating Proof. A read failure settles as
    `implementation-observation-unavailable`, an infrastructure failure that never consumes a semantic
    attempt and never passes.
  - `reconcile-implementation-proof.ts` observes conformance over the Task's current bytes. A read
    failure aborts the reconcile without changing state.
  - The authority-free Pi untrusted stop (`applyUntrustedStopResolution` in
    `core/implementation-application.ts`) passes the named constant `LEGACY_STOP_CONFORMANCE`
    (`not-owed`). That path always leaves the Task `pending` with `revalidation_required`, so the
    exact settlement or reconcile that follows judges it.
- **Engine bytes subtracted (FR-012).** `buildTaskLocalByteObservation`
  (`core/implementation-application.ts`) receives the graph's `SkeletonRecord`s and the current
  digests of their paths, both supplied by `handlers/helpers/task-local-completion.ts`. It uses the one
  untouched-skeleton judgment, `isUntouchedSkeleton` (`core/skeleton/outcomes.ts`, INV-4 owner):
  - It drops a proof-scope change whose current digest still equals the recorded engine digest, so
    engine bytes never satisfy "changed".
  - It drops a repository-changed path that still holds a recorded engine digest. That keeps
    contract stubs out of the contract Task's out-of-scope set.
- **Receipts and retry.** A receipt keeps each contract-violated failure as
  `CONTRACT_VIOLATED_FAILURE_KIND_PREFIX` (`proof:declared-artifact-contract-violated `) followed by
  canonical JSON `{ artifact, omitted, violations }`, which holds the longest prefix of violations
  that fits the receipt's failure-kind bound plus a count of the rest. The stored Proof keeps all of
  them. The semantic retry appendix (`renderImplementationRetryContext` in
  `core/implementation-retry.ts`) renders the authority line, then a violation section headed
  "Declared-artifact contract violations (declared-artifact-contract-violated) …; fix every one before
  completing". Under it each receipt entry is its file, then each encoded violation's subject, reason
  and remedy, then an "and N more violations not shown" line when the entry omitted any. It never
  drops an entry it cannot parse; it shows that entry verbatim instead (FR-028).
- **No drift semantics.** The new kind is not in `ATTESTATION_DRIFT_BASE_KINDS`. A contract violation
  is a semantic failure the next attempt can fix, not terminal attestation drift.

### Required, as the plan seed specified

As AD-5 specified, `contractConformance` is a required field of `ObservedProofEvidence`, of
`IncomingImplementationEvidence` and of the `reconcileTaskFromStoredEvidence` parameter. Every
settlement path must decide it: an observed verdict from `observeContractConformance`, or the named
`not-owed` constant `LEGACY_STOP_CONFORMANCE` on the Pi untrusted stop. A new settlement path that
forgets to observe conformance fails to compile, so the risk Option 3 was rejected for cannot arise.
Callers outside settlement, such as test fixtures, pass `{ kind: "not-owed" }` explicitly.

## Consequences

**Positive:**
- One failure variant carries the whole feature through Proof. No new obligation kind, evidence
  variant or drift matcher was added, and existing consumers that switch on `ProofFailure["kind"]`
  were made exhaustive by the compiler (status summaries, `failureSummary` in reconcile, and the
  `proofFailureKind` mapping in `implementation-completion.ts`).
- An untouched skeleton is refused with an actionable reason (`still-unimplemented`, with the export
  name), not a generic "not changed".
- Engine bytes can never count as implementer work, and the contract Task is never blamed for the
  stubs the engine writes at its stop.
- A conformance read failure is infrastructure, so a transient filesystem problem never burns a
  semantic attempt and never lets a Task pass.
- The retry brief lists, for each violated file, every violation that fits the receipt's
  failure-kind bound with its remedy, plus a count of any it omitted. Attempt 2 can fix all of the
  listed ones in one go and knows how many more remain.
- `contractConformance` is required, so the compiler guarantees that every settlement path decides
  conformance. No path can pass a Task by forgetting it.

**Negative:**
- The `declared-artifact-changed` arm now checks conformance as well as change. Someone reading only
  the obligation name will undercount what it enforces.
- The proof channel duplicates CT-1's violation shapes structurally to avoid an import cycle. The
  compiler keeps them aligned only through the settlement shells' pass-through, not through a shared
  declaration.
- Receipts truncate the violations they encode to fit the failure-kind bound, and the retry appendix
  is rendered from the receipt. When one file has very many violations, the appendix lists only the
  encoded prefix and an "and N more violations not shown" line. The stored Proof keeps them all.
- Callers of `evaluateTaskProof` outside settlement, such as test fixtures, must pass an explicit
  `not-owed` value.
- Conformance is checked only on files that are declared artifacts and parse to a supported skeleton
  language. A contract whose types file no skeleton language reads contributes no surface. This is a
  stated limit, not a waiver.
