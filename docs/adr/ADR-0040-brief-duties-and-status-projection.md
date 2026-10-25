# ADR-0040: Brief duties and status projection

## Status
Accepted (2026-10-23). Shipped with the G5b owner-enforcement feature
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, FR-027 and FR-028; plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-10; interview Q3c).

## Context
G5b makes each owned Invariant a Wave Gate obligation. The engine-reserved completion check
`loom:owner-verification` requires two things. First, the matrix test's imports must reach the owner module
and every declared sibling. Second, unless the Invariant declares a mutation exemption, every mutant that the
fixed operator set makes of the owner's lines changed in the Wave must be killed by the matrix test. Both
checks run at the gate, which comes after implementation. The two people affected by them each need
something before and after that point:

- **The implementing Agent** needs to know about the duty before it writes code. An Agent that learns at the
  gate that its matrix test had to import a sibling, or had to kill mutants of the owner, has already spent
  an attempt. FR-027 requires the brief's ownership section to state the coverage and mutation duties, or the
  declared exemption, for the Invariants the Task touches.
- **The operator** needs to read the outcome after the gate. FR-028 requires `helper orchestration status`,
  in human form and as `--json`, to report the per-Invariant coverage and mutation outcome of the latest
  Wave Gate run, and to name the remedy in the next action when either check blocks.

Several forces constrain both halves:

- A TaskGraph populated before G5b has no `owner_obligations` stamp and owes nothing. A brief that stated
  duties for it would describe an obligation the gate never checks.
- Human status and `--json` status have drifted apart before when each one derived its own view.
- The remedy wording must match what the gate's own diagnostic says. A status that suggests one fix while the
  gate blocks on another sends the operator in circles.
- Interview Q3c ruled out a new log channel. The outcome has to come from state that already exists: the
  persisted completion result.

## Options Considered

1. **Duty paragraph in the brief's ownership section, gated on the stamp; one pure status projection of the
   persisted completion result (chosen)**
   - Pros: the Agent sees the duty in the section it already reads for its ownership role. Only graphs that
     carry a stamp get duties, so pre-feature graphs keep their bytes. One projection feeds both renderers,
     so human and JSON output cannot disagree. Remedies are taken from the same source as the gate's
     diagnostic. No new I/O or log channel.
   - Cons: status can only report what the latest persisted completion result recorded. A run that never
     persisted shows as "not observed", not as "running". The brief's ownership section gets longer for
     Tasks that touch a family.

2. **Leave duties out of the brief; rely on the gate diagnostic and the plan's Invariants section**
   - Pros: no change to brief rendering, and no risk of changing bytes in pre-feature briefs.
   - Cons: the Agent finds out about the mutation duty only after it fails, which costs a retry for each
     Invariant. The plan's `**Owner module:**` blocks do not state the mutation duty or the operator set.
     This fails FR-027.

3. **Separate status renderers for human output and `--json`, each reading the raw `ownerVerification`
   observation**
   - Pros: each renderer could shape the data however suits it, with no intermediate type.
   - Cons: two derivations of the same facts can drift, which is the failure FR-028's "one projection"
     clause exists to prevent. Each renderer would also need its own copy of the remedy wording, a second
     copy of a rule.

4. **A dedicated owner-verification log or report file that status tails (rejected by Q3c)**
   - Pros: it could show progress while a run is still going, and it could keep history across runs.
   - Cons: it adds a new channel whose lifecycle, location and integrity would all need defending. The
     persisted completion result already holds the verdict, so a second source would add a new way for the
     two to disagree.

## Decision
**The brief states each touched Invariant's owner duties only when the graph carries the
`owner_obligations` stamp, and status renders one pure projection of the latest persisted completion
result's `ownerVerification`, taking its remedies from the gate's own diagnostic source.**

### Brief half
- `engine/src/orchestration/implementation-brief.ts` passes `graph.owner_obligations` through as
  `ownerObligations` only when the stamp is present. A pre-feature graph passes nothing, so no duty is
  rendered (the comment there cites AD-10).
- `engine/src/core/implementation-brief.ts`: `invariantOwnership` selects the touched obligations through
  INV-3's owner, `obligationsTouchedBy(task.file_list, ownerScope)` in
  `engine/src/core/owner-verification/obligations.ts`. This is the touch scope, in which any role counts,
  including the matrix test. It is wider than the gate's `ownerVerificationOwed(scope, wave)` scope, because whoever
  writes the matrix test needs to know the duty.
- For each touched obligation, `ownerDuties` appends a paragraph under that Invariant's ownership block,
  headed `**Owner duties (INV-N):**`:
  - **Coverage.** The paragraph says the matrix test must import the owner module and every named sibling
    entry point, or, when the Invariant declares no siblings, the owner alone. It also says the Wave Gate
    follows imports through re-exports.
  - **Mutation.** For `mutation.kind === "verify"`, it says the owner's lines changed in the Wave will be
    mutation-verified, and that every mutant the fixed operator set makes must be killed by the matrix test.
    For `"exempt"`, it names the declared exemption and its reason, and says sibling coverage still applies.
    The match is exhaustive.
- **Deviation from the plan, recorded:** the shipped renderer also handles an obligation that is touched
  but has no plan block of its own, which happens when the stamp and the plan's blocks differ. It renders
  that obligation as its own `**INV-N: title**` block after the plan's blocks, so the duty is never dropped
  silently.

### Status half
- `engine/src/core/owner-verification/status.ts` is pure. Status says one thing about owner verification:
  an `OwnerVerificationStatus`, which is a `report` and the `remedies` read from it.
- The report is `OwnerVerificationStatusReport`, the persisted `OwnerVerificationObservation` itself plus
  one status-only case. **Deviation from the plan, recorded:** the plan described a bare
  `OwnerVerificationStatus[]` of per-Invariant status records. The shipped report is a three-case union, so
  that "absent" and "could not run" are also representable, and it carries the verdict types the gate
  judged and the completion result stores, not a status-only copy of them:
  - `not-observed` with a `reason`: no persisted result, one without owner verification, or a persisted
    result status could not read (named by its read failure, so it never passes for "no result");
  - `unavailable`: the check could not run at all, carrying its `OwnerInfrastructureFailure`;
  - `verified`: the `obligationsDigest` the check ran against, `boundMs`, and one `InvariantVerdict` per owed
    Invariant (`[]` when nothing is owed).
- Each `InvariantVerdict` carries `invariant`, `title`, `owner`, `matrixTest`, a `CoverageVerdict` and a
  `MutationVerdict` (`engine/src/core/owner-verification/types.ts`):
  - `coverage` is `covered`, or `missing` with a `NonEmpty` list of paths, or `infrastructure`;
  - `mutation` is `verified` with `generated`, `killed`, `timedOut`, `invalid`, `survivors`, `unmutated` and
    `ownerChangedInWave` (the survived count is `survivors.length`, derived where it is rendered and never
    stored beside the list); or `exempt` with its reason; or `red-baseline` with its failures;
    or `infrastructure`.

  `red-baseline` is shipped in addition to the plan's list, because a red baseline means no mutant ran and
  the counts would mislead.
- **Why the report is the verdicts themselves.** An earlier shape projected each verdict into a near-copy
  (`kind` renamed `result`, `covered` renamed `pass`, every count copied field by field). That copy failed
  the deletion test: removing it moved no complexity to any caller, and every new verdict field had to be
  added in four places. `--json` now serializes the persisted verdicts, so one representation is shared by
  the gate, the completion result and status. The deep part of `status.ts` is the free-text renderer,
  `renderOwnerVerificationStatus`: a header with the Invariant count and the bound, one line per Invariant
  (`coverage pass` for `covered`), and one line per survivor. The `--json` shape was unshipped when it
  changed, so there is no compatibility shim.
- Remedies are not decided in `status.ts`. `observedOwnerVerificationStatus(observation)` maps
  `ownerVerificationFailures(observation)` through `renderOwnerVerificationFailure`, both from
  `engine/src/core/owner-verification/verdict.ts`, which is the source the gate's diagnostic also reads.
  `ownerVerificationNotObserved(reason)` owes no remedy. The shipped wording:
  - missing siblings: `strengthen <matrixTest> to import the owner and every sibling entry point`, after
    the missing paths;
  - survivor: `mutant survived at <owner>:<line>:<column> (<operator>): original …, mutated …; strengthen
    <matrixTest> to kill it, or declare a mutation exemption with a reason on INV-N`. This is more precise
    than the plan's template, because it adds the column and the original and mutated text;
  - red baseline and infrastructure failures name their cause.
- `engine/src/core/loom-status.ts`:
  - `ownerVerificationStatusOf(result)` derives the one `OwnerVerificationStatus` from what status read as
    the latest persisted completion result, so "unavailable" versus "absent" is decided once. An `observed`
    result carrying owner verification is reported as itself with its remedies. An absent result, one
    without owner verification, and an `unavailable` read are each `not-observed` with their own reason and
    owe no remedy.
  - `withOwnerVerificationRemedies(status, owner)` consumes that value. It adds remedies only when
    completion-suite readiness is `rejected` with failure kind `owner-verification-rejected`: one
    `completion-prerequisite-failed` reason per remedy appended to `next.reasons`, prefixed `owner
    verification blocks the Wave Gate:`. Readiness and remedies read the same persisted result, so they
    cannot disagree; a rejection for any other failure kind adds none.
  - `deriveLoomStatusFromParsedGraph` returns the `LoomStatusDocument` (`engine/src/types.ts`): the routed
    `LoomStatus`, its next action merged with the remedies, and `owner.report` as its `ownerVerification`
    key, all from one `ownerVerificationStatusOf` value. The document type requires `ownerVerification`;
    the bare `LoomStatus` stays a separate type, so the compiler proves the status command always carries
    the report and neither renderer handles an absent field. `renderLoomStatusJson(document)` serializes it
    exactly; `renderLoomStatusHuman(document)` adds the lines from `renderOwnerVerificationStatus`.
- `engine/src/handlers/helpers/orchestration.ts` derives that document once and hands it to whichever
  renderer `--json` selects; the shell decides nothing about owner verification.
- No new log channel. Status reads only the persisted completion result.
- Operator-facing documentation is in `docs/operations.md`, under "Owner verification blocks a Wave Gate
  (G5b)": "Reading the result" and the remedies table.

## Consequences

**Positive:**
- Agents know the coverage and mutation duties, or the exemption and its reason, before they write code, and
  the brief names the files involved, which avoids retries spent finding out at the gate.
- Pre-feature graphs get unchanged briefs and no duties that would never be checked, because the stamp's
  absence is the one signal for that, and `ownerVerificationOwed` and the suite read the same signal.
- Human and `--json` status come from one document, and the report and the next-action remedies from one
  `OwnerVerificationStatus`, so none of them can disagree. Remedy text has one source shared
  with the gate's diagnostic.
- The status value is pure and covered by tests (`engine/tests/core/owner-verification-status.test.ts`,
  `engine/tests/acceptance/owner-verification-status.acceptance.test.ts`), and its union types make illegal
  combinations unrepresentable. For example, a `missing` coverage always carries at least one path.

**Negative:**
- Status shows only the latest persisted completion result. There is no progress view during a long
  mutation run and no history across runs. This was accepted under Q3c.
- Remedies appear in the next action only when readiness classifies the rejection as
  `owner-verification-rejected`. If a rejection is attributed to another failure kind, the owner findings
  are still visible in the report lines, but the next action does not name them.
- `--json` serializes the persisted verdict types directly, so a change to `InvariantVerdict`,
  `CoverageVerdict` or `MutationVerdict` changes the status wire shape too. This is accepted: one
  representation across gate, completion result and status is what removed the hand-kept copy.
- The brief uses the wider touch scope, which includes the matrix test, while the gate checks only Waves
  that change the owner or a sibling. A Task that edits only the matrix test is told the duty even though
  its own change does not trigger the check. The duty is still accurate for the Wave that does trigger it.
- Briefs for Tasks in owned families get longer, and the brief's wording now has to stay consistent with the
  gate's behavior: the fixed operator set and the follow-through-re-exports rule.
