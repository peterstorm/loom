# ADR-0031: Owner verification is an engine-reserved completion-suite check (approach B)

## Status
Accepted (2026-10-23). Shipped with G5b owner enforcement
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-1).

## Context
G5a taught the plan grammar to declare an owner module for an Invariant (`**Owner module:**`, siblings, a
matrix test). These declarations were only advisory. G5b turns them into Wave Gate obligations. For every
owned Invariant whose family a Wave changed, the gate must prove two things. First, sibling coverage: the
matrix test imports the owner and every sibling. Second, mutation verification: every mutant of the owner's
changed lines is killed by the matrix test. It must also prove that the plan still agrees with what was
stamped at population (FR-002). The question this ADR answers is where that work runs inside the Wave Gate
lifecycle.

Four forces shape the answer:

- **Cost and the lock.** Mutation runs are slow: one baseline run plus up to the per-Invariant cap of mutant
  runs, each through the project's test runner. That can take minutes. The protected-state commit
  (`complete-wave-gate`) runs under the StateManager lock, and nothing slow may run there. But anything checked
  outside the lock has to be bound to what is committed inside it, or a check-then-commit TOCTOU window opens.
- **Harness neutrality (NFR-002).** Claude Code and Pi both drive the Wave Gate through the same engine
  program (`engine/src/handlers/helpers/programs/wave-gate.ts`). Anything that needs a new step in each
  harness's sequencing doubles the integration surface and risks the two harnesses drifting apart.
- **Existing authority.** The Wave completion suite already has the shape this needs. It is authorized from
  frozen manifest authority, run outside the lock by `ensureWaveCompletionSuite`, persisted as a
  digest-addressed result, and turned into an `AcceptedWaveCompletionReceipt` bound to the suite digest and
  the workspace digest. `checkWaveCompletionSuite` (`engine/src/core/wave-gate-checks.ts`) then gates
  `complete-wave-gate` on that receipt. Acceptance Contracts already showed that a result and its receipt can
  carry a rich typed observation (`acceptance?: AcceptanceObservation`) beside the per-check process facts.
- **Backward compatibility (FR-004).** A TaskGraph populated before G5b owes nothing. Its suite roster, suite
  digest, persisted results and receipts must stay byte-identical, so an in-flight run does not lose its
  receipt or replay differently.

## Options Considered

1. **A dedicated owner-verification gate stage (approach A)**
   - Pros:
     - Clear separation: owner verification has its own stage, its own result file and its own status line.
     - Its failure taxonomy does not touch the completion-suite types.
   - Cons:
     - Needs a second receipt and digest scheme (authority, workspace binding, replay, stale detection). That
       duplicates the suite's authority model, and the two schemes could disagree about the same workspace.
     - Adds a new program step that both harnesses have to sequence and that `complete-wave-gate` has to
       check separately. That is more surface for the two harnesses to drift apart.
     - Status, the next action and receipt reuse each need a new parallel code path.

2. **Inline in `complete-wave-gate` (approach C)**
   - Pros:
     - No new artifact. The check runs at the moment of commit, so it sees exactly what is committed.
   - Cons:
     - Running it under the protected-state lock holds the lock for minutes of mutant runs and blocks every
       other state write.
     - Running it before taking the lock opens a TOCTOU window between the check and the commit. Nothing
       binds the observed workspace to the committed one.
     - Mixes slow effects (worktrees, process spawns) into a handler whose job is a short, atomic transition.

3. **An engine-reserved check inside the Wave completion suite (approach B, chosen)**
   - Pros:
     - Runs where slow checks already run: outside the lock, in `ensureWaveCompletionSuite`, through the one
       harness-agnostic program.
     - The check is a member of the authorized roster, so it is part of the suite digest. Receipt reuse,
       workspace-digest binding, replay, persisted-result parsing and status all reuse the suite's existing
       machinery.
     - `checkWaveCompletionSuite` blocks on it with no new code.
     - Follows an existing precedent: the engine-reserved `loom:full-tier-lint` check (`engine-full-tier-lint`)
       already shows how an engine-owned check sits beside operator project checks.
   - Cons:
     - The completion-suite types grow: a check variant, an observation on results and receipts, a new
       authority failure kind and new infrastructure and semantic failure kinds, each with its own strict
       parser.
     - The suite runner gains an effectful step that is not a project command. It has its own shell
       (`orchestration/owner-verification-runner.ts`) and does not reuse the generic process-check path.

## Decision
**Owner verification is a third, engine-reserved variant of `AuthorizedWaveCompletionCheck`,
`engine-owner-verification` with check id `loom:owner-verification`, injected into the Wave completion suite
exactly when the TaskGraph carries the `owner_obligations` stamp.**

**The check and its authority** (`engine/src/core/completion-suite.ts`, `engine/src/core/verification-manifest.ts`):

```ts
| Readonly<{
    kind: "engine-owner-verification";
    checkId: CompletionCheckId;              // always OWNER_VERIFICATION_CHECK_ID_TEXT = "loom:owner-verification"
    scope: "wave";
    reportPolicy: Readonly<{ kind: "not-required" }>;
    obligationsDigest: ArtifactDigest;       // digest of the stamped owner_obligations
    owed: readonly string[];                 // owed Invariant ids, plan order, possibly empty
  }>
```

- `authorizeWaveCompletionSuite(manifest, registration, workspaceDigest, owner: OwnerCheckAuthority | null = null)`
  makes no ownership decision. It builds the roster as `[ENGINE_LINT_CHECK, …(owner === null ? [] :
  [engineOwnerCheck(owner)]), …projectChecks]`, copying `obligationsDigest` and `owed` verbatim. With `null`
  the roster, and so the suite digest, is byte-identical to the pre-G5b roster (FR-004). A project check
  cannot claim the id: the project-check parser in `completion-suite.ts` refuses any `checkId` in the reserved
  `loom:` namespace.
- `ownerCheckAuthority(ownerScopeOf(graph), wave)` in `engine/src/core/owner-verification/obligations.ts` is the one place
  that decides the authority (INV-3, AD-4). It returns `null` exactly when the graph has no stamp. Otherwise it
  returns the stamp's `obligationsDigest` and the ids `ownerVerificationOwed` selects, which is an empty list
  when the Wave changed no owned family. It has two callers. `authorizeGraphCompletionSuite` in
  `engine/src/core/owner-verification/suite-authority.ts` is the one authorize-from-TaskGraph function: the
  gate helper (`engine/src/handlers/helpers/wave-completion-suite.ts`, authorizing the suite it runs) and
  readiness (`engine/src/core/wave-completion-suite-readiness.ts`, re-authorizing for readiness and status)
  both call it. `engine/src/state-file-wire.ts` re-derives the authority from the stamp when an installed
  receipt loads, on purpose: a receipt must not certify its own roster. The runner
  (`engine/src/orchestration/owner-verification-runner.ts`) receives the authorized check from the gate and
  records its digest, never re-deriving it (PR #131 review remediation). They all read the same graph, so they
  cannot disagree; and
  `authorizeWaveCompletionSuite` takes the authority as a required parameter, so no caller can drop it by
  omission.
- **Deviation from the plan:** the plan placed `OwnerCheckAuthority` in `obligations.ts`. It ships in its own
  leaf module, `engine/src/core/owner-check-authority.ts`, and `obligations.ts` re-exports it.
  `verification-manifest.ts` (which `types.ts` imports) and `obligations.ts` (which imports `types.ts`) both
  name it, so it lives in a leaf to keep the source domains acyclic. The decision is still made only in
  `obligations.ts`.

**What the check observes.** `WaveCompletionSuiteResult` and `AcceptedWaveCompletionReceipt` gain an optional
`ownerVerification?: OwnerVerificationObservation`, mirroring `acceptance?`. It is present exactly when the
suite authorizes the check. The observation (`engine/src/core/owner-verification/types.ts`) is either
`verified { obligationsDigest, boundMs, verdicts }`, with one `InvariantVerdict` per owed id, or
`unavailable { failure }`. Results and receipts written before G5b keep their exact field set: the optional
field joins the strict-field parse only when present.

**How the suite runs it** (`observeOwnerCheck` / `ownerVerificationObservation` in
`engine/src/handlers/helpers/wave-completion-suite.ts`):

1. Whenever the check is authorized, the plan named by `plan_file` is re-read and must re-derive the stamp
   (FR-002, AD-2). An unreadable plan is `plan-unreadable`, strays or malformed ownership are `plan-malformed`,
   and any difference from the stamp is `plan-drift`. This runs even when `owed` is empty.
2. When nothing is owed, the observation is `verified` with no verdicts and `boundMs: 0`.
3. Otherwise `runOwnerVerification` (`engine/src/orchestration/owner-verification-runner.ts`) runs coverage
   and mutation for the owed obligations, using `withMutationWorkspace`
   (`engine/src/orchestration/owner-mutation-workspace.ts`) for the isolated worktree (AD-8). It digests the
   real workspace before and after the run. It never throws, by construction (total reads, guarded steps, a
   named `unexpected-error` for anything that still throws), and the suite shell keeps a last-resort catch
   that turns a throw from the injected port into the same blocking `unexpected-error` failure.
4. The check's stored `CompletionCheckResult` is an engine-observed exit: `ownerVerificationExitCode` is 1
   exactly when `ownerVerificationFailures(observation)` is non-empty, the same way the reserved lint check
   reports.

**How a result is judged** (`evaluateWaveCompletionSuite`, `engine/src/core/completion-suite.ts`):

- `CompletionAuthorityFailure` gains `owner-verification-mismatch` (`ownerVerificationMismatch`). It covers an
  observation the suite does not authorize, an authorized check with no observation, an exit that contradicts
  the findings, a different `obligationsDigest`, or verdicts for ids other than `owed`. This kind is not in
  the plan's seed. It closes the gap that would let a forged or stale observation pass.
- `CompletionInfrastructureFailure` gains `owner-verification-infrastructure` (carrying
  `NonEmpty<OwnerInfrastructureFinding>`), and `CompletionSemanticFailure` gains `owner-verification-rejected`
  (carrying `NonEmpty<OwnerSemanticFinding>`: missing siblings, red baseline, survivor). The plan's seed had one
  `NonEmpty<OwnerVerificationFailure>`. The shipped types split it by the `infrastructure` kind, so a finding
  that could not decide can never be reported, or counted, as a kill or a semantic rejection.
- An accepted receipt cannot carry an observation with findings. The receipt parser refuses one.

**Fail-closed persistence.** A rejection whose only infrastructure failures come from the owner check, and
which carries no semantic failure, is published as an attempt record beside the result slot
(`completion-suites/<suite>/<workspace>.owner-infrastructure/<sha256>.json`) rather than in the slot itself.
The evidence persists, and a retry at the same workspace runs the check again instead of replaying the
failure. There is no automatic retry. A mixed rejection (a semantic failure beside an undecided owner check)
is already decided by its semantic failure, so it goes to the result slot and replays as rejected; the pure
`rejectionDisposition` in `engine/src/core/completion-suite.ts` makes that choice once for the gate, replay
and readiness (PR #131 review remediation).

**Status.** `engine/src/core/loom-status.ts` projects the latest persisted result's `ownerVerification` through
`engine/src/core/owner-verification/status.ts` (AD-10), and adds remedy next actions when the suite was rejected
with `owner-verification-rejected`.

Operator-facing behavior and remedies: `docs/operations.md` ("Owner verification blocks a Wave Gate (G5b)").
Structure: `docs/architecture.md` ("Owner verification in the completion suite (G5b)").

## Consequences

**Positive:**
- No new gate stage, receipt scheme or harness step. Claude Code and Pi get owner verification through the
  existing `ensureWaveCompletionSuite` path in `handlers/helpers/programs/wave-gate.ts`, and
  `checkWaveCompletionSuite` blocks on it unchanged.
- Slow mutant runs happen outside the StateManager lock. The receipt that `complete-wave-gate` checks is bound
  to the suite digest (which includes `obligationsDigest` and `owed`) and to the workspace digest, so there is
  no TOCTOU window between verification and commit.
- Pre-G5b graphs are untouched: no stamp gives a `null` authority, which leaves the roster, suite digest,
  results and receipts byte-identical.
- The plan-integrity check runs on every Wave of a stamped graph, including Waves that owe nothing, so plan
  drift is caught at the first gate after it happens rather than only when a family changes.
- The ownership decision stays in one module (`obligations.ts`). Suite authorization only carries what it is
  handed, which keeps INV-3's single-owner rule intact across authorization, readiness and the runner.

**Negative:**
- The completion-suite module grows a lot: a check variant, an observation with its own strict parsers
  (verified mutation tallies are re-validated through the branded `VerifiedMutationOfFn`), a new authority
  failure and two new failure kinds. Every consumer of `AuthorizedWaveCompletionCheck` must handle the new
  variant.
- The owner check does not go through the generic project-command process path. Its "exit code" is
  synthesized from the observation, so the evaluator must cross-check exit against findings
  (`owner-verification-mismatch`) to keep the two from disagreeing.
- Owner-check infrastructure failures need special persistence (the `.owner-infrastructure/` attempt
  records), so they do not occupy the result slot and block a retry. That is one more artifact path for
  operators to understand.
- A Wave Gate's suite run can now take minutes when mutation is owed. The time bound is reported (`boundMs`),
  not enforced as a global deadline beyond each mutant's clamped timeout, and a long run delays the receipt.
- Any change to `owner_obligations`, or to which Invariants a Wave owes, changes the suite digest. A receipt
  from before a re-population is therefore never reused, which is intended but forces a full re-run.
