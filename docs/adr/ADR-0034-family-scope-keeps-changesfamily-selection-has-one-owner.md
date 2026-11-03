# ADR-0034: Family scope keeps G5a's changesFamily; selection has one owner

## Status
Accepted (2026-10-23). Records plan AD-4 of `.claude/plans/2026-10-21-g5b-owner-enforcement.md` (interview Q1d)
and the ownership rule INV-3 of the same plan. It shipped with G5b owner enforcement on
`feat/g5b-owner-enforcement`.
Amended 2026-11-01 (#136): the opaque `OwnerScope` seam and its selections became two duty entry points,
`waveOwnerDuty` and `taskOwnerDuty`; see "Two duty entry points" under Decision.
Amended 2026-11-03 (ADR-0063): `waveOwnerDuty` selects through the family schedule (`owesInWave`): the owner
must be due, and a contract Task's change owes nothing.

## Context
G5a gave a plan's owned invariants a family: one owner module, its declared sibling entry points and a matrix
test. It also gave the engine one rule for which roles a Task's file list plays in that family. That rule lives in
`engine/src/core/plan-paths.ts`: `invariantRoles(fileList, ownership)` returns `{ owner, siblings, matrixTest }`,
and `changesFamily(roles)` holds when the owner or a sibling is changed. Plan validation
(`engine/src/handlers/helpers/validate-model-bindings.ts`, the owner-first rule) and the implementation brief
(`engine/src/core/implementation-brief.ts`) both classify roles through it. So a Task that the validator holds to
the owner-first rule is also the Task the brief calls a sibling.

G5b makes owned invariants Wave Gate obligations. Population stamps them into the TaskGraph as
`owner_obligations`, and the engine-reserved completion check `loom:owner-verification` runs sibling coverage and
mutation verification for them. That adds new questions, each with more than one consumer:

- **Gate scope.** Which obligations does a Wave owe coverage and mutation for? The suite helper
  `engine/src/handlers/helpers/wave-completion-suite.ts` and suite re-authorization in
  `engine/src/core/wave-completion-suite-readiness.ts` must give the same answer. The receipt validation in
  `engine/src/state-file-wire.ts` and the runner `engine/src/orchestration/owner-verification-runner.ts` must
  agree with both.
- **Touch scope.** Which obligations does a single Task touch? The answer drives the owner-map section of the
  reviewer packet (`engine/src/core/wave-review-authority.ts`) and the owner-duty paragraphs of the brief
  (`engine/src/core/implementation-brief.ts`).
- **Suite authority.** Does the Wave's suite carry the owner check at all, and with which digest and owed ids?
  This must be byte-stable for graphs populated before G5b (FR-004).

Each of these decisions is cheap to inline at its call site, a filter over `owner_obligations` here or an
`owner_obligations !== undefined` there. Inline copies drift, though. If readiness disagreed with the suite
helper, a receipt would fail to re-authorize. If the packet disagreed with the brief, a reviewer would see an
owner map for duties the implementer was never told about. The spec glossary added a second problem: it first
defined "Family change" to include the matrix test, which contradicts G5a's `changesFamily`.

## Options Considered

1. **One pure owner module, with gate scope on G5a's `changesFamily` (chosen)**
   - Pros:
     - Every selection is written once and tested once (`engine/tests/core/owner-obligations.matrix.test.ts`).
     - Gate scope and touch scope are related by construction: the Wave scope is a subset of the touch scope for
       every file list, and a property test asserts it.
     - Role classification stays in `plan-paths.ts`, so G5a's validator, the brief and the G5b gate cannot
       disagree about what a "sibling" is.
     - A change to the matrix test alone does not spawn up to 24 mutant runs per invariant.
   - Cons:
     - A Wave that weakens only the matrix test is not re-verified by mutation at that Wave's Gate. It relies on
       the review packet's owner map and on the next Wave that changes the family.
     - One more module every consumer must import, and a leaf type module to keep the import graph acyclic.

2. **Gate scope includes the matrix test (any role triggers the checks), as the original spec glossary said**
   - Pros:
     - A matrix-test-only change would be re-checked for coverage and mutation kills in the same Wave.
     - A single scope: gate and touch would be the same predicate.
   - Cons:
     - Contradicts G5a's `changesFamily`. The validator would call a Task outside the family while the gate
       treats it as changing the family.
     - Mutation verification is bounded by the owner's lines changed since the Wave base. A matrix-only Wave has
       no changed owner lines, so it would owe a check with no mutation sites. The cost is a baseline run that
       proves nothing new.
     - Couples test-only edits to the most expensive gate check.

3. **Each consumer selects inline (no owner module)**
   - Pros:
     - No new module. Each call site reads like the local logic it serves.
   - Cons:
     - Ten call sites in nine modules (the table under Decision), several questions and two scopes, kept in sync
       by convention. This is exactly the drift
       INV-3 exists to forbid.
     - The absent-vs-empty stamp distinction (`undefined` owes nothing and has no check, while `[]` still carries
       the plan-integrity check) would be re-encoded at each site. A mistake would change pre-G5b suite digests.

4. **Put the ownership decision inside `authorizeWaveCompletionSuite` (`verification-manifest.ts`)**
   - Pros:
     - Suite authorization would need no extra parameter.
   - Cons:
     - It drags TaskGraph and plan-model knowledge into the manifest module, and creates an import cycle between
       the owner-verification core and `types.ts`.
     - Packets and briefs would still need their own touch selection elsewhere, so ownership would split anyway.

## Decision
**`engine/src/core/owner-verification/obligations.ts` is the sole owner of every Owner Obligation selection. The
Wave's gate scope uses G5a's `changesFamily` (owner or sibling). The touch scope uses any role, matrix test
included.**

The module is pure and listed under `DEFAULT_PURE_MODULES` (INV-2). It classifies roles only through
`invariantRoles` and `changesFamily` from `engine/src/core/plan-paths.ts`.

**Two duty entry points (#136; superseding the PR #131 `OwnerScope` seam).** Callers never filter the raw
`owner_obligations` array. Two functions read a graph, and each answers with a union whose variants decide the
absent-versus-empty distinction once. Both duties are plain data, with one field per fact:

- `waveOwnerDuty(graph, wave): WaveOwnerDuty` is the gate scope.
  - `unstamped` (the field is absent): `owed: []`. The suite carries no owner check.
  - `stamped` (the obligations, `[]` included): `owed` keeps an obligation when some Task of that Wave has a
    `file_list` satisfying `changesFamily(invariantRoles(...))`, in stamp order; a Task without a `file_list`
    changes nothing. `obligationsDigest` is the whole stamp's identity.
- `ownerCheckAuthorityOf(duty): OwnerCheckAuthority | null` derives the owner check from a Wave duty at one point:
  `null` exactly when the stamp is absent, otherwise `{ obligationsDigest, owed }` with the ids of the duty's `owed`,
  possibly none. A stamped graph always carries the check, so plan integrity (FR-002) runs every Wave.
- `stampAgreement(duty, models): StampAgreement` is the gate's drift check of a Wave duty: `agrees`, `drifted` or
  `underivable`, comparing the canonical digest of the obligations the plan derives with the duty's
  `obligationsDigest`. An unstamped duty is `drifted`, decided here rather than by each caller.
- `taskOwnerDuty(graph, fileList): TaskOwnerDuty` is the touch scope: `touched` keeps an obligation when
  `changesFamily(roles) || roles.matrixTest`, in stamp order. `unstamped` touches nothing (`touched: []`); the brief
  tells it apart from a stamped graph the Task does not touch.

The PR #131 remediation put the stamp behind an opaque `OwnerScope` with three selections over it
(`ownerVerificationOwed`, `ownerCheckAuthority`, `obligationsTouchedBy`) and a drift check (`stampAgreement`). #136
replaced the scope and its selections with the two duties above, from which the check is derived, and
`stampAgreement` now takes a Wave duty. Each caller asks one question about one Wave or one Task and gets every
answer in one value, so the owed obligations and the check's owed ids can no longer come from two different
scopes.

`verifyOwed(obligations)` decides which of a set of obligations owe mutation (policy `verify`); population and the
runner both use it, so the owes-mutation rule has one home too.

The same module owns the stamp's identity, so derivation and comparison are written once too.
`obligationsFromPlan(models)` produces one obligation per owned invariant in plan order.
`obligationsDigest(obligations)` and `obligationsAgree(stamped, fromPlan)` work over a canonical key order, so a
stamp read back from the wire digests identically.

Callers in the shipped code:

| Question | Caller (INV-3 sibling) | Selection |
|---|---|---|
| Suite authorization from a TaskGraph | `engine/src/core/owner-verification/suite-authority.ts` | `ownerCheckAuthorityOf(waveOwnerDuty(...))` |
| Suite authorization at the gate | `engine/src/handlers/helpers/wave-completion-suite.ts` | through `suite-authority.ts` |
| Suite re-authorization for readiness | `engine/src/core/wave-completion-suite-readiness.ts` | through `suite-authority.ts` |
| Obligations the check runs for | `engine/src/handlers/helpers/wave-completion-suite.ts` | `waveOwnerDuty(...).owed` |
| Plan drift against the stamp | `engine/src/core/owner-verification/plan-integrity.ts` | `stampAgreement(duty, models)` (unstamped is drift) |
| Receipt roster validation on read | `engine/src/state-file-wire.ts` | `ownerCheckAuthorityOf(waveOwnerDuty(...))` |
| Which owed obligations run mutants | `engine/src/orchestration/owner-verification-runner.ts` | `verifyOwed`, through `verificationRuns` in `core/owner-verification/owed-verification.ts` |
| Whether population needs an `affectedRunner` | `engine/src/core/task-graph-population.ts` | `verifyOwed` |
| Reviewer-packet owner map | `engine/src/core/wave-review-authority.ts` | `taskOwnerDuty(...).touched` |
| Brief owner duties | `engine/src/core/implementation-brief.ts` | `invariantOwnershipSourceOf` over the shell's `TaskOwnerDuty` |

`engine/src/orchestration/implementation-brief.ts` calls `taskOwnerDuty(graph, task.file_list)` and hands the
renderer the `InvariantOwnershipSource` that `invariantOwnershipSourceOf` (in `core/implementation-brief.ts`) builds from
it: the stamped duty itself, or, for an unstamped graph, the plan's Invariants. Its only part in that choice is the
plan-file read it passes in, which runs only for an unstamped graph (#134). The State File wire re-derives the check authority from the stamp on purpose rather
than reading it off the receipt: a persisted receipt must not certify its own roster. The runner no longer
re-derives the authority; it receives the `OwedVerification` the gate decided (`ownerObservationDecision` in
`core/owner-verification/owed-verification.ts`: the owed obligations with the authorized digest) (PR #131 review
remediation).

`authorizeWaveCompletionSuite` in `engine/src/core/verification-manifest.ts` is deliberately not a sibling. It
takes the `OwnerCheckAuthority | null` its callers obtained as a parameter, makes no ownership decision, and
injects `loom:owner-verification` only when that parameter is non-null (OWN-1). The `OwnerCheckAuthority` type
lives in the leaf module `engine/src/core/owner-check-authority.ts` and is re-exported from `obligations.ts`. The
manifest module (which `types.ts` imports) and the owner-verification core (which imports `types.ts`) can then
both name it without a cycle between source domains.

The matrix test `engine/tests/core/owner-obligations.matrix.test.ts` covers:

- **Owner rows:** Wave scope against touch scope over owner-only, sibling-only, matrix-only and unrelated file
  lists, plus absent against empty `owner_obligations`.
- **Sibling rows:** nine, one per caller in the table except the gate helper's suite authorization. That call goes
  through `suite-authority.ts`, so the suite-authority rows cover it. The packet and brief
  follow `taskOwnerDuty`; suite authority, readiness and the State File wire follow `ownerCheckAuthorityOf`; the gate helper hands the
  runner exactly the Wave duty's `owed`; plan integrity follows `stampAgreement`; the runner and population follow
  `verifyOwed`.
- **Properties:** the Wave scope is a subset of the touch scope; an absent stamp owes nothing and has no
  authority; for a stamped graph, the derived check's `owed` is exactly the ids of the duty's `owed`.

INV-3 is advisory: no lint rule forbids an inline selection. The matrix test and review are its enforcement.

The spec glossary entry "Family change" (`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`) now defines a
family change as G5a's `changesFamily` rule: the Wave's Tasks' files include the owner or a sibling entry point,
and a change to the matrix test alone is not a family change. The amendment is
logged there with no FR or AS change. `docs/operations.md` ("Owner verification blocks a Wave Gate", step 2) and
`CONTEXT.md` (Owner Obligation, Owner Verification) state the same scope.

Two points where the shipped code differs from the plan's wording:

- The plan calls these "three selections" but names four. The module also owns the stamp-identity functions
  above, the drift check and `verifyOwed`.
- The plan's first draft exported `waveChangedObligations(waveTasks, obligations)` and selections over a raw
  graph. The PR #131 review remediation folded the Wave filter into `ownerVerificationOwed` and put every
  selection behind an opaque `OwnerScope`; #136 then replaced the scope and its selections with the two duties. INV-3's
  sibling list names every real caller (table above).

## Consequences

**Positive:**
- The gate, readiness, drift check, receipt validation, runner, population, reviewer packet and brief cannot
  disagree about which obligations apply. A change to scope is a change to one pure function and its matrix rows.
- G5a and G5b share one definition of "changes the family". The validator's owner-first rule, the brief's
  sibling paragraph and the gate's owed set all classify through `plan-paths.ts`.
- Pre-G5b graphs keep byte-identical suite rosters and digests: `ownerCheckAuthorityOf` gives `null` for them,
  and `authorizeWaveCompletionSuite` adds nothing.
- A Wave that touches a matrix test still gets the owner map in review and owner duties in the brief, without
  paying for mutation runs that have no changed owner lines to mutate.
- `verification-manifest.ts` stays ignorant of TaskGraphs and plans. The source-domain import graph stays
  acyclic through the `owner-check-authority.ts` leaf.

**Negative:**
- A Wave that changes only the matrix test, for example by deleting an assertion or dropping an import of a
  sibling, is not re-checked for coverage or mutation kills at that Wave's Gate. That regression is caught only by
  the reviewer, through the packet's owner map, or at the next Wave that changes the owner or a sibling. This is
  an accepted gap.
- Two scopes with different predicates are a concept readers must learn. The names `waveOwnerDuty` and `taskOwnerDuty`,
  and the subset property, carry that distinction, but a caller can still pick the wrong
  one.
- INV-3 is advisory, but the duty unions narrow what review has to catch: a caller receives the absent-versus-empty
  answer as a variant, so it has no reason to read the stamp, and the stamp a drift check needs is under a key only
  `obligations.ts` can read. What still compiles is a new call site that
  bypasses the module altogether and filters `graph.owner_obligations` itself; review against the matrix test's
  sibling rows remains the guard for that.
- The extra leaf module `owner-check-authority.ts` exists only to break an import cycle. It is structural
  overhead, not domain logic.
