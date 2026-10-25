# ADR-0034: Family scope keeps G5a's changesFamily; selection has one owner

## Status
Accepted (2026-10-23). Records plan AD-4 of `.claude/plans/2026-10-21-g5b-owner-enforcement.md` (interview Q1d)
and the ownership rule INV-3 of the same plan. It shipped with G5b owner enforcement on
`feat/g5b-owner-enforcement`.

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

**The Owner Scope seam (PR #131 review remediation).** Callers never hand the raw `owner_obligations` array to a
selection. `ownerScopeOf(graph)` builds an opaque `OwnerScope` from the graph's Tasks and stamp; its one key is a
module-private symbol, so only the functions in `obligations.ts` can read it. Internally it is `unstamped` (the
field is absent) or `stamped` (the obligations, `[]` included, and the Tasks), so the absent-versus-empty
distinction is decided once, at construction. Every selection takes the scope:

- `ownerVerificationOwed(scope, wave)` is the gate scope. It keeps an obligation when some Task of that Wave has a
  `file_list` satisfying `changesFamily(invariantRoles(...))`, in stamp order. A Task without a `file_list`
  changes nothing, and an unstamped scope owes `[]`.
- `obligationsTouchedBy(scope, fileList)` is the touch scope: `changesFamily(roles) || roles.matrixTest`, in stamp
  order; `[]` when unstamped.
- `ownerCheckAuthority(scope, wave): OwnerCheckAuthority | null` returns `null` exactly when the scope is
  unstamped. Otherwise it returns `{ obligationsDigest, owed }`, where `owed` is the ids of
  `ownerVerificationOwed`. `owed` may be empty: a stamped graph, `[]` included, always carries the check, so plan
  integrity (FR-002) runs every Wave.
- `stampAgreement(scope, models)` is the gate's drift check: `agrees`, `drifted`, `unstamped` or `underivable`.

`verifyOwed(obligations)` decides which of a set of obligations owe mutation (policy `verify`); population and the
runner both use it, so the owes-mutation rule has one home too.

The same module owns the stamp's identity, so derivation and comparison are written once too.
`obligationsFromPlan(models)` produces one obligation per owned invariant in plan order.
`obligationsDigest(obligations)` and `obligationsAgree(stamped, fromPlan)` work over a canonical key order, so a
stamp read back from the wire digests identically.

Callers in the shipped code:

| Question | Caller (INV-3 sibling) | Selection |
|---|---|---|
| Suite authorization from a TaskGraph | `engine/src/core/owner-verification/suite-authority.ts` | `ownerCheckAuthority` |
| Suite authorization at the gate | `engine/src/handlers/helpers/wave-completion-suite.ts` | through `suite-authority.ts` |
| Suite re-authorization for readiness | `engine/src/core/wave-completion-suite-readiness.ts` | through `suite-authority.ts` |
| Obligations the check runs for | `engine/src/handlers/helpers/wave-completion-suite.ts` | `ownerVerificationOwed` |
| Plan drift against the stamp | `engine/src/core/owner-verification/plan-integrity.ts` | `stampAgreement` |
| Receipt roster validation on read | `engine/src/state-file-wire.ts` | `ownerCheckAuthority` |
| Which owed obligations run mutants | `engine/src/orchestration/owner-verification-runner.ts` | `verifyOwed`, through `verificationRuns` in `core/owner-verification/owed-verification.ts` |
| Whether population needs an `affectedRunner` | `engine/src/core/task-graph-population.ts` | `verifyOwed` |
| Reviewer-packet owner map | `engine/src/core/wave-review-authority.ts` | `obligationsTouchedBy` |
| Brief owner duties | `engine/src/core/implementation-brief.ts` | `obligationsTouchedBy` |

`engine/src/orchestration/implementation-brief.ts` calls `ownerScopeOf` to build the scope it hands the brief
renderer and decides nothing. The State File wire re-derives the check authority from the stamp on purpose rather
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
  follow `obligationsTouchedBy`; suite authority, readiness and the State File wire follow `ownerCheckAuthority`; the gate helper hands the runner
  exactly `ownerVerificationOwed`; plan integrity follows `stampAgreement`; the runner and population follow
  `verifyOwed`.
- **Properties:** the Wave scope is a subset of the touch scope; an absent stamp owes nothing and has no
  authority; for a stamped graph, `owed` is exactly the ids of `ownerVerificationOwed`.

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
  selection behind `OwnerScope`; INV-3's sibling list now names every real caller (table above).

## Consequences

**Positive:**
- The gate, readiness, drift check, receipt validation, runner, population, reviewer packet and brief cannot
  disagree about which obligations apply. A change to scope is a change to one pure function and its matrix rows.
- G5a and G5b share one definition of "changes the family". The validator's owner-first rule, the brief's
  sibling paragraph and the gate's owed set all classify through `plan-paths.ts`.
- Pre-G5b graphs keep byte-identical suite rosters and digests: `ownerCheckAuthority` returns `null` for them,
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
- Two scopes with different predicates are a concept readers must learn. The names `ownerVerificationOwed` and
  `obligationsTouchedBy`, and the subset property, carry that distinction, but a caller can still pick the wrong
  one.
- INV-3 is advisory, but `OwnerScope` narrows what review has to catch. Handing a selection the raw stamp, or
  reading the absent-versus-empty state off a scope, is a type error. What still compiles is a new call site that
  bypasses the module altogether and filters `graph.owner_obligations` itself; review against the matrix test's
  sibling rows remains the guard for that.
- The extra leaf module `owner-check-authority.ts` exists only to break an import cycle. It is structural
  overhead, not domain logic.
