# Plan: Deterministic Task Execution

## Status

Accepted architecture, recovered from the 2026-08-22 completion-oracle discussion and reconciled against Loom `main`. Slice 1 (Verification Policy) merged at `529ffb9`; Slice 2 (quiescent Wave completion suite) merged through PR #29 at `bd16fed`; Slice 3 (Task-local Completion Oracle and exact Implementation Attempt authority) merged through PR #35 at `cfeacae6`. Slice 4 is implemented and locally validated on its feature branch but is not yet review/merge evidence. Slice 5 remains planned.

Slice 4 worktree: `~/dev/claude-plugins/loom-deterministic-implementation-retry`

Branch: `feat/deterministic-implementation-retry` — issue #39

## Objective

Make Task and Wave completion an engine-owned decision over immutable authority and engine-observed facts. Pi and Claude Code adapt harness events into the same domain command; neither harness independently decides that implementation is complete.

## Current constraints

1. Tasks in one Wave execute concurrently in one shared worktree.
2. Spawn admission enforces disjoint declared `file_list` ownership, but tests and whole-program compilation can observe sibling intermediate state.
3. Claude SubagentStop can block a child from stopping, but Loom currently snapshots evidence and cleans up the Guarded Skill Machine binding before the implementation result is settled. Continuing after a blocked stop therefore loses the attribution epoch unless lifecycle ordering changes.
4. Pi applies implementation evidence only after the child result returns to the parent; the child has already exited. Same-process continuation is not available through the normal Pi subagent transport.
5. Wave Gate already proves that no Wave Task remains in `executing_tasks` before protected completion.
6. Full-tier Loom lint over recorded Wave files is already enforced immediately before the Wave completion commit.
7. Loom does not yet own a project verification-command source. Model-authored shell strings must not become engine authority.

## Approach decision

### A. Task-local completion plus Wave-global verification — recommended

At SubagentStop/result capture, execute or evaluate only checks whose truth cannot be invalidated by a concurrently-writing sibling: attempt identity, process completion, attributed/declared byte changes, explicit verification policy, and rechecked new-test presence. Run whole-program build/typecheck/tests and full-tier lint only after the Wave is quiescent unless a check is explicitly proven file-local and non-observing.

**Advantages**

- Fits the existing shared-worktree Wave model.
- Reuses disjoint path ownership and `checkNoExecutingTasks`.
- Adds deterministic value without inventing merge authority.
- Allows one pure completion evaluator to be reused at Task and Wave scopes.
- Preserves Pi/Claude state-transition parity even while transport continuation differs.

**Costs**

- Some failures remain Wave-distance until workspaces are isolated or continuation becomes harness-neutral.
- "Same-Agent retry with hot context" is not promised in the first epic.

### B. Isolated Task worktrees

Each Task writes and verifies in its own worktree, then the engine integrates verified candidates.

**Advantages**

- Strong byte ownership and repeatable Task-local whole-program checks.
- Enables best-of-N later.

**Costs**

- Introduces a new integration aggregate: candidate revisions, merge order, conflicts, retries, and provenance.
- Changes Wave semantics substantially.
- Worktrees are file isolation, not a security boundary.

**Decision**: defer until an engine-owned completion suite exists and can serve as the candidate selector.

### C. Single-writer implementation

Serialize all writing Agents; parallel Agents provide analysis only.

**Advantages**

- Makes whole-program checks sound at every stop.
- Minimal attribution ambiguity.

**Costs**

- Removes Loom's implementation parallelism.
- Does not solve Pi continuation.

**Decision**: reject as the default. It may remain an explicit project policy later.

### D. Wave-quiescent verification with Agent continuation

Run all Agents concurrently, wait for Wave quiescence, verify, then resume the responsible Agent.

**Advantages**

- Checks the integrated workspace.
- Could preserve generation parallelism.

**Costs**

- Requires durable child continuation in both harnesses.
- Claude cleanup ordering and Pi's exited child currently violate that requirement.
- A failing integrated check may not identify one responsible Task.

**Decision**: defer until a cross-harness Implementation Program owns continuation requests.

## Domain model

### Implementation Attempt

One engine-reserved execution of one Task under one semantic attempt ordinal and one immutable byte baseline.

```typescript
type SemanticAttempt = 1 | 2;

type ImplementationAttemptAuthority = Readonly<{
  taskId: TaskId;
  wave: WaveNumber;
  attempt: SemanticAttempt;
  reservationId: ImplementationReservationId;
  taskScopeBaselineDigest: ArtifactBaselineDigest;
  dirtySetBaselineDigest: ArtifactBaselineDigest;
}>;
```

Only a parser/smart constructor mints this value. A Task id inferred from concurrent `executing_tasks` is not attempt authority.

### Verification Policy

Regression execution and new-test creation are independent obligations.

```typescript
type VerificationRequirement<Waiver extends string> =
  | Readonly<{ kind: "required" }>
  | Readonly<{ kind: "waived"; reason: Waiver }>;

type VerificationPolicy = Readonly<{
  regression: VerificationRequirement<
    "documentation-only" | "generated-artifact"
  >;
  newTests: VerificationRequirement<
    "existing-tests-sufficient" | "documentation-only" | "generated-artifact"
  >;
}>;
```

Legacy `new_tests_required` is parsed at the TaskGraph boundary:

- `true` or absent → regression required, new tests required.
- `false` → both waived under one explicit legacy migration reason in the parsed compatibility representation.
- New TaskGraph production writes `verification_policy`.
- If both fields are present, the parser requires equivalent semantics; disagreement is invalid state.

### Completion Check Result

A process spawn failure is structurally separate from an observed process. Exit, timeout, signal, and report production remain independent facts because a timeout handler can still produce exit 0 or a report.

```typescript
type CompletionProcessOutcome =
  | Readonly<{
      kind: "spawn-failed";
      message: NonEmptyString;
    }>
  | Readonly<{
      kind: "observed";
      exitCode: number | null;
      timedOut: boolean;
      signal: NodeJS.Signals | null;
      report: "not-required" | "produced" | "missing";
    }>;

type CompletionCheckResult = Readonly<{
  checkId: CompletionCheckId;
  scope: "task" | "wave";
  outcome: CompletionProcessOutcome;
}>;
```

### Completion Suite Result

A non-empty immutable set of exact expected check results bound to Task-attempt or Wave authority. Duplicate, missing, surplus, stale, and wrong-scope results are parser or settlement failures.

```typescript
type CompletionSuiteResult =
  | Readonly<{
      kind: "task-suite";
      authority: ImplementationAttemptAuthority;
      checks: NonEmpty<CompletionCheckResult>;
    }>
  | Readonly<{
      kind: "wave-suite";
      wave: WaveNumber;
      workspaceDigest: WorkspaceDigest;
      checks: NonEmpty<CompletionCheckResult>;
    }>;
```

### Implementation Completion Oracle

The aggregate command owns the transition from observed attempt to the next Task lifecycle action.

```typescript
settleImplementationAttempt(
  task: Task,
  authority: ImplementationAttemptAuthority,
  observation: ImplementationObservation,
  suite: CompletionSuiteResult,
): Either<ImplementationCompletionError, ImplementationCompletionTransition>
```

```typescript
type ImplementationCompletionTransition =
  | Readonly<{ kind: "implemented"; proof: SatisfiedTaskProof }>
  | Readonly<{
      kind: "retry-required";
      attempt: 2;
      failures: NonEmpty<ImplementationCompletionFailure>;
    }>
  | Readonly<{
      kind: "escalation-required";
      failures: NonEmpty<ImplementationCompletionFailure>;
    }>
  | Readonly<{
      kind: "blocked";
      failure: CompletionInfrastructureFailure;
    }>
  | Readonly<{
      kind: "ignored";
      reason: "stale" | "duplicate" | "already-completed";
    }>;
```

Expected verification failures consume a semantic attempt. Infrastructure failures do not.

## Component design

### Functional core

#### `engine/src/core/verification-policy.ts`

Owns `VerificationPolicy`, exact unknown-input parsing, legacy migration, and obligation derivation.

#### `engine/src/core/completion-suite.ts`

Owns process/check/suite ADTs, exact parsers, result evaluation, and failure rendering as data.

#### `engine/src/core/implementation-completion.ts`

Owns `ImplementationAttemptAuthority`, attempt settlement, stale/duplicate classification, and bounded retry/escalation transitions. It composes proof obligations and completion-suite evaluation; it performs no I/O.

#### Existing `engine/src/core/proof-obligations.ts`

Consumes `VerificationPolicy` rather than deriving both test obligations from one boolean. It remains the aggregate for authored proof obligations and evidence.

### Imperative shell

#### Task-result adapters

- Claude: `engine/src/handlers/subagent-stop/update-task-status.ts`
- Pi: `pi/subagent-result.ts`

Each adapter gathers harness-native observations, parses them once, executes the safe Task-local suite through a shell port, invokes the same aggregate command, and applies its returned transition under the State File lock.

No adapter may independently map "child returned" to `status: "implemented"`.

#### Wave Gate

`engine/src/handlers/helpers/programs/wave-gate.ts` runs the Wave suite only after canonical readiness proves `checkNoExecutingTasks`. The suite result becomes another explicit Wave Gate fact before `commitActiveWaveGateCompletion`.

The existing full-tier lint call remains Wave-scoped until it is represented as a named completion check proven against the integrated workspace; migration must not temporarily remove enforcement. An accepted Wave suite result and its workspace/suite digests become inputs to Wave readiness and protected completion authority, never an unbound pre-commit side effect.

### I/O ports

Do not introduce a generic command framework. The completion shell needs two real seams:

```typescript
type RunCompletionCheck = (
  check: AuthorizedCompletionCheck,
  signal: AbortSignal,
) => Promise<CompletionCheckResult>;

type LoadCompletionSuite = (
  scope: TaskCompletionScope | WaveCompletionScope,
) => Either<CompletionSuiteConfigurationError, AuthorizedCompletionSuite>;
```

The production adapters execute fixed executable/argument arrays. Tests use plain fake functions.

## Verification command authority

Do not execute model-authored shell strings.

The runner slice must introduce one operator-owned, parseable source of fixed commands. The preferred design is a protected Loom verification manifest whose bytes are captured before implementation begins and whose entries contain:

- stable check id;
- scope (`task` or `wave`);
- executable;
- readonly argument array;
- repository-relative working directory;
- bounded timeout;
- report policy.

The manifest must be guarded from implementation Agents for the duration of the loom flow. Automatic package-manager detection may generate an initial manifest, but detection is not runtime authority.

The domain slice deliberately does not invent this manifest format; it establishes the result and policy contracts first.

## Data flow

### Task completion

```text
reserved Task + attempt baseline
  → child result / SubagentStop observation
  → parse harness evidence
  → run safe Task-local checks
  → CompletionSuiteResult
  → settleImplementationAttempt (pure)
  → locked State File transition
  → implemented | retry-required | escalation-required | blocked | ignored
```

### Wave verification

```text
registered Wave Gate
  → canonical readiness
  → prove no executing Wave Tasks
  → load frozen Wave completion suite
  → execute checks with bounded process shell
  → evaluate exact suite (pure)
  → continue semantic reviews/advisory decision
  → protected Wave completion commit
```

## Error handling

### Domain failures

Returned as `Either` values:

- authority mismatch;
- stale or duplicate attempt;
- missing/surplus/duplicate check result;
- non-zero exit;
- timeout;
- signal termination;
- missing required report;
- unsatisfied proof obligation;
- attempt budget exhausted.

### Infrastructure failures

Spawn, filesystem, manifest, and protected-state failures are shell-originated typed failures. They block without consuming the semantic implementation-attempt budget.

No catch-all converts infrastructure failure into failed tests.

## Test strategy

### Unit tests

- Parse every ADT from `unknown`, including exact-key rejection.
- Derive regression and new-test obligations independently.
- Settle every transition without filesystem/process mocks.
- Prove Pi and Claude normalized observations produce byte-equal transitions.

### Property tests with fast-check

- Settlement is deterministic for equal inputs.
- Attempt 2 can never transition to another retry.
- Infrastructure failure never consumes an attempt.
- Stale/duplicate outcomes never mutate current proof.
- Satisfied transition implies every expected obligation and check is satisfied.
- Missing, duplicate, or surplus check ids can never produce `implemented`.
- Parsing/serialization round trips preserve valid values.
- Legacy boolean migration is total and deterministic.
- Explicit policy disagreement with legacy input is always rejected.

### Integration tests

- Real timeout process that traps termination and exits zero is still a timeout.
- Real signal termination records the signal independently.
- Missing required report blocks despite exit zero.
- Wave suite cannot run while a Wave Task remains in `executing_tasks`.
- Existing full-tier lint remains enforced during migration.

No production subprocess is mocked.

## Delivery slices

### Slice 1 — explicit verification policy

- Add `VerificationPolicy` and its exact compatibility parser.
- Split regression/new-test obligation derivation.
- Update `CONTEXT.md`, proof lockstep, state load guards, TaskGraph production, Claude/Pi result settlement, Wave readiness, and docs together.
- Add example and property tests for independent requirements and legacy migration.
- Do not add test-only attempt authority, settlement reducers, subprocess ports, or completion-suite abstractions.

### Slice 2 — quiescent Wave suite

- Add completion process/check/suite ADTs and pure evaluator.
- Add protected verification manifest and fixed-command parser.
- Add bounded subprocess shell with orthogonal outcomes.
- Execute whole-program checks only after Wave quiescence.
- Bind the accepted Wave suite result and workspace/suite digests into Wave readiness and protected completion authority.
- Persist result/receipt and expose it through Wave status.
- Keep existing full-tier lint fail-closed throughout migration.

#### Settled Slice 2 authority and compatibility details

- The operator source is `.loom/verification-manifest.json`. TaskGraph population reads it directly; decompose input can neither provide nor override command authority.
- The protected TaskGraph stores the parsed immutable manifest and canonical digest before any implementation Task can execute. Runtime suite loading consumes those frozen values, never model output or mutable source bytes.
- An absent source freezes an engine-owned manifest with no project commands. The resulting authorized suite remains non-empty because it always includes the reserved `loom:full-tier-lint` check. This preserves existing projects and active legacy graphs without inventing project commands.
- Manifest commands are executable plus readonly argument arrays and always run with `shell: false`; shell/eval program strings are rejected. Working directories and report paths are repository-relative and symlink-confined.
- The Wave workspace digest covers Git-visible tracked files plus non-ignored untracked files, including their path, mode, and bytes. Git internals, ignored dependencies/caches, State File bytes, and Run Directory artifacts are outside this authority.
- The suite runs immediately after canonical current-Wave quiescence and implementation/test proof, before semantic review publication. Review-only progress cannot alter workspace bytes; any later workspace change makes the accepted receipt stale and causes a fresh suite execution on resume.
- Full-tier lint is represented as the engine-owned reserved check and the existing terminal lint invocation remains in place during Slice 2 migration as a fail-closed canary.
- A successful result is published immutably in the registered Wave Run Directory and then bound into protected TaskGraph state under exact run, Wave, registration revision, authority, manifest, suite, and workspace digests.
- Current workspace observation participates in canonical Wave readiness. The locked completion path re-observes it; stale, missing, malformed, duplicate, surplus, or conflicting suite evidence cannot commit.
- Existing TaskGraphs with no manifest/suite fields remain readable and can acquire the built-in suite. Historical completed Wave registrations are never rewritten. New completed registrations carry exact accepted-suite authority.
- The Wave Gate remains a per-program façade (ADR-0005) and LC-1 remains a projection over durable evidence (ADR-0006); Slice 2 adds no generic command framework or second lifecycle checkpoint.

#### Slice 2 implementation evidence

- Pure exact parsers and deterministic evaluator cover command, process, report, suite, manifest, result, and accepted-receipt authority.
- The real bounded process shell proves timeout-plus-exit-zero, signal termination, hard-kill escalation, spawn failure, report freshness, and symlink/path failures without subprocess mocks.
- Git-visible workspace hashing binds tracked and non-ignored untracked path/mode/type/bytes while excluding protected State/Run Directory/report artifacts.
- Modern TaskGraphs freeze the operator manifest during population; legacy field-absent graphs remain compatible.
- The registered Wave Gate runs the suite only after current-Wave quiescence/proof readiness, before semantic review publication, and retains terminal full-tier lint as a migration canary.
- Immutable Run Directory results recover the publication-to-State-File crash window without rerunning commands. Infrastructure results remain retryable and are not frozen into the deterministic slot.
- Accepted receipts enter protected readiness and schema-v2 terminal history; status projects accepted, stale, rejected, pending, malformed, and unavailable evidence without executing commands.
- Canonical review `review-20260824T164705Z-deterministic-wave-suite` produced digest `87955ed09e6c9ee63eaed96c7b2f086e5fb2c3ba00b56a8335a99bc3803d9d90`. All three refutation lenses upheld three criticals: modern direct-helper divergence, descendant-process escape, and incomplete inline-eval denial. All were fixed with explicit modern-helper refusal, POSIX process-group containment, and an allowlisted executable/subcommand policy.
- Accepted bounded advisories fixed Git fallback cause loss, staged-artifact cause loss, two stale comments, and three duplicated internal representations. The `ActiveWaveGateRegistration` union, `WaveGateLifecycleEvidence` redesign, and advisory-projection status interface remain deferred to their planned atomic architecture slices.
- Final remediated validation: **215 test files, 5,324 passed, 1 intentional skip**; panel smoke **22/22**, review-panel smoke **19/19**, standalone review, orchestration façade, Pi resources, and TaskGraph **23/23**; typecheck, unused checks, full-tier lint, and diff checks passed.
- Existing live `web/chatbot` (23 Tasks) and `baby-adventure` (63 Tasks) legacy TaskGraphs pass the Slice 2 validator unchanged.

### Slice 3 — Task-local completion suite and attempt authority

- Add protected Task-attempt authority to reservations with separate Task-scope and repository dirty-set baseline digests.
- Add the pure `settleImplementationAttempt` reducer only when production state can mint and carry that authority.
- Run only explicitly file-local, non-observing checks at Task result settlement.
- Route Claude and Pi through `settleImplementationAttempt`.
- Remove inference-based success authority; inference may remain cleanup-only.
- Never block SubagentStop to continue the same child in this epic; retries are new engine-issued attempts in both harnesses.

#### Slice 3 architecture checkpoint

##### Stored Task lifecycle and migration

`Task` becomes a discriminated union over the existing flat wire fields; no second nested lifecycle source is introduced.

- `pending`: pending or failed Proof; no revalidation marker.
- `revalidation-required`: `status: "pending"`, any historical Proof, and `revalidation_required: true`.
- `implemented`: `status: "implemented"` and satisfied Proof.
- `completed`: `status: "completed"` and satisfied Proof; only Wave Gate mints this arm.
- `failed`: `status: "failed"` and failed Proof.
- `legacy-missing-proof`: an implementation-bearing legacy status, absent Proof, and an explicit protected migration marker. It remains readable but cannot receive modern positive completion authority.

The TaskGraph parser derives a pending Proof for legacy pending Tasks that omitted one. It translates implementation-bearing Tasks without Proof into the explicit legacy arm rather than inventing satisfied evidence. New writers cannot mint the legacy arm. The provenance-checked reconciliation helper is the only positive legacy migration: exact registered Review Packet/baseline authority may recover Proof and remove the marker. Ordinary reconciliation may still revoke stale authority.

##### Implementation Attempt authority

`engine/src/core/implementation-completion.ts` owns exact parsers, constructors, digests, lifecycle classification, and settlement:

```typescript
type SemanticAttempt = 1 | 2;

type ImplementationAttemptAuthority = Readonly<{
  schemaVersion: 1;
  kind: "implementation-attempt-authority";
  taskId: TaskId;
  wave: WaveNumber;
  semanticAttempt: SemanticAttempt;
  reservationId: ImplementationReservationId;
  headSha: GitSha;
  reservedAt: IsoInstant;
  taskScopeBaselineDigest: ArtifactDigest;
  dirtySetBaselineDigest: ArtifactDigest;
  authorityDigest: ArtifactDigest;
}>;
```

Reservation identity distinguishes repeated executions. `retry_count`, Task id, harness result index, and `executing_tasks` cardinality are never attempt authority. Slice 3 registration defaults to semantic attempt 1; only Slice 4 may explicitly request attempt 2. Manual re-execution therefore receives a fresh reservation id under attempt 1 until the bounded retry program exists.

The Task stores at most one `active_implementation_attempt` and an immutable `implementation_attempt_history` of exact settlement receipts. New graphs enforce:

```text
Task id in executing_tasks
  iff Task has active_implementation_attempt
  iff stored attempt baselines hash to that authority's two baseline digests
```

Legacy `executing_tasks` entries without active authority remain readable as legacy reservations, but are cleanup/invalidation-only. Stale reservation reclamation removes only the exact active authority it proved abandoned.

Registration captures baselines and reservation ids in the shell, then revalidates and atomically installs baselines, digests, authority, `reserved_at`, and `executing_tasks` under one StateManager lock. The returned authority is the only result correlation capability.

##### Harness correlation

Claude:

1. PreToolUse atomically registers the attempt.
2. SubagentStart reads the trusted first user prompt, resolves its Task, loads that Task's exact active authority, and writes a session+agent-id sidecar containing the authority.
3. SubagentStop snapshots and parses that sidecar before roster/machine cleanup deletes it.
4. Settlement consumes the snapshot. General transcript text and sole-`executing_tasks` inference are cleanup-only.

Pi:

1. Shared registration returns exact attempt authorities in spawn order.
2. Each implementation `ReservedSlot` stores its exact authority.
3. Finalization and successful results settle only that authority. Unreserved prompt/parent-prompt/sole-executing binding is cleanup-only.

A stale result whose reservation id differs from the locked active attempt is ignored and cannot release the newer attempt. Duplicate history receipts are idempotently ignored. Missing or ambiguous attribution preserves every modern active attempt.

##### Task-local suite

Slice 3 does not widen the operator Verification Manifest to Task subprocesses. In a shared worktree, even `shell: false` allowlisted commands can observe sibling intermediate bytes; arbitrary Task-scope project commands remain forbidden.

The Task suite is a distinct exact envelope containing only engine-owned checks. Its initial non-empty roster contains `loom:task-byte-scope`, evaluated from parser-proven Task paths and exact attempt baselines. Baseline/read/path uncertainty is infrastructure-blocked. Modified paths outside the attempt's declared plus previously-attributed Task scope are semantic failure. The batch-shared repository dirty-set delta is invalidation evidence, not attribution, and sibling paths never become this Task's Proof.

The existing Wave suite remains the only authority for build, typecheck, tests, package scripts, project reports, and full-tier lint.

##### Completion Oracle

```typescript
settleImplementationAttempt(
  task: SettleableTask,
  currentAuthority: ImplementationAttemptAuthority,
  suppliedAuthority: ImplementationAttemptAuthority,
  observation: ImplementationObservation,
  suite: TaskCompletionSuiteResult,
): Either<ImplementationCompletionError, ImplementationCompletionTransition>
```

The pure reducer owns exact authority comparison, suite evaluation, Proof evaluation, evidence preservation, and transition classification:

- `implemented` — exact current authority, accepted Task suite, and satisfied Proof.
- `retry-required` — semantic failure on attempt 1; recorded but not dispatched in Slice 3.
- `escalation-required` — semantic failure on attempt 2; recorded but not dispatched in Slice 3.
- `infrastructure-blocked` — observation/suite infrastructure uncertainty; consumes no semantic attempt.
- `ignored` — stale, duplicate, or already-completed evidence.

A locked shell applies the returned transition and existing review/spec/Wave invalidation intent atomically, clears only the matching active attempt, appends one receipt, and recomputes `impl_complete`. Pi and Claude may preserve different evidence provenance, but equivalent normalized observations produce byte-equal transitions.

##### Positive-writer cutover

All positive Task-completion writers change in this slice:

- Claude `runUpdateTaskStatus` and Pi `applyImplementationPiResult` call the Oracle.
- `applyUntrustedStopResolution` becomes an Oracle application/helper rather than a second status decision.
- `applyCompletionInfrastructureFailure` requires exact modern attempt authority; legacy inference can only quarantine/release legacy reservations.
- `store-test-evidence` may store evidence but may not set implemented.
- `reconcile-implementation-proof` may invalidate modern authority; positive settlement is limited to its explicit provenance-checked legacy migration.
- Population creates canonical pending lifecycle state; Wave Gate alone promotes implemented to completed; reopening creates revalidation-required state.

##### Tests and rollout

Property tests prove exact parser totality/round trips, digest determinism, settlement determinism, no retry after attempt 2, infrastructure failures do not consume semantic attempts, stale/duplicate results never alter current Proof, and implemented implies exact accepted checks plus satisfied obligations.

Parity tests feed equivalent Claude/Pi normalized observations into the same reducer. Integration tests cover Claude sidecar binding/snapshot cleanup, Pi reserved-slot authority, late-result/new-reservation collision, missing/ambiguous cleanup, stale reservation reclamation, out-of-scope writes, legacy graph migration, and every out-of-band positive writer.

Runtime rollout occurs only at a Pi session boundary after merge. A pre-Slice-3 active child has no exact sidecar/reserved authority and therefore requires cleanup/revalidation and a fresh spawn; compatibility inference never upgrades it to implemented.

Slice 4 alone freezes retry contexts, dispatches attempt 2, persists retry diagnostics/request identity, and owns escalation execution. Slice 3 classifies and records those transitions but launches no retry.

#### Slice 3 shipped evidence

- `engine/src/core/implementation-completion.ts` owns exact attempt/suite/observation/receipt parsers and the pure Oracle; `engine/src/core/implementation-application.ts` owns Task-byte-scope construction, one evidence-preservation rule, and one exact transition applier.
- `engine/src/handlers/helpers/task-local-completion.ts` is the thin filesystem/Git shell. It reads exact registered paths and fixed Git dirty-set facts only; it runs no Task/project subprocess.
- The allowed Task scope is exactly `attempt_artifact_baseline`. Current-attempt attribution requires parser-proven paths whose bytes changed from that baseline. Cumulative declared-artifact Proof compares the first `artifact_baseline`. Foreign transcript paths are semantic failure; baseline/path/read/Git uncertainty is infrastructure-blocked. Repository dirty-set delta is invalidation-only and never Task attribution, Proof, or sibling evidence.
- Claude modern settlement requires the exact no-replace SubagentStart sidecar; Pi modern settlement requires the exact ReservedSlot authority. Both gather harness evidence, invoke the same Oracle under the State File lock, and apply the same transition core. Missing/inferred legacy identity can clean/quarantine only and cannot set implemented.
- Failed/malformed/unsafe exact attempts settle as non-consuming infrastructure receipts before release. Duplicate results are idempotent; late results preserve newer attempts. Sidecar publication is atomic no-replace and permits only byte-identical duplicate delivery; post-identification start failure rolls back only the exact registration and capabilities created by that start.
- `store-test-evidence` remains evidence-only. Ordinary `reconcile-implementation-proof` can reopen/invalidate only; positive reconciliation is limited to explicit, packet-authorized `legacy_missing_proof` migration and clears the marker.
- Attempt 1 semantic failure records retry-required; attempt 2 records escalation-required. No retry/escalation dispatch exists in Slice 3; that remains Slice 4.
- Focused production/property/integration suites, the full bounded unit suite, smoke, typecheck/unused, full-tier lint, and diff checks are the required cutover evidence. Counts are recorded only from final fresh runs; this subsection does not claim review or merge.

### Slice 4 — bounded retry/escalation

- Freeze attempt-1 and attempt-2 contexts before dispatch.
- Persist retry diagnostics and issued request identity.
- One retry for semantic failure; explicit escalation after attempt 2.
- Infrastructure retry policy remains separate.

#### Slice 4 implementation checkpoint (feature branch; not merge evidence)

- `engine/src/core/implementation-retry.ts` derives the only legal next attempt from exact settlement history and owns exact Retry Context/Attempt Context parsing, rendering, self-digests, and admission.
- Canonical status emits initial or exact retry dispatch instructions. Attempt-2 exhaustion emits non-retryable `escalate-wave-implementation`; no pending-state inference can mint attempt 3.
- The shared Claude/Pi task registration shell requires the exact status-issued retry appendix, mints semantic attempt 2 atomically with baselines, and freezes prompt/context identity before dispatch. Pi rebuilds the registration prompt after write-grant injection so the digest covers exactly what its child sees.
- Settlement, rollback, stale reclamation, and Pi exact cleanup retire Attempt Context only with matching authority. Infrastructure receipts preserve the current semantic attempt and do not consume the budget.
- `/loom`, resume-after-clear, the implementation prompt template, workflow docs, canonical Pi status, and `CONTEXT.md` consume the same status/retry vocabulary.
- Pure parser/property, StateManager, shared registration, status, Claude-shell, and full Pi extension tests cover missing/stale/tampered retry context, attempt-2 admission, crash/replay authority, terminal escalation, and attempt-3 refusal.

### Slice 5 — attributed events and semantic Task output

- Add proven per-Task event identity where the harness exposes or can carry it.
- Never infer parallel Claude tool attribution from `executing_tasks`.
- Persist typed Task output for dependent Task briefs.
- Compile Requirement Completion Claims into frozen assertions where supported.

## Invariants

1. Only engine-issued Implementation Attempt authority can settle a Task.
2. Exactly one current attempt exists per executing Task.
3. Only semantic failure on attempt 2 is terminal and publishes escalation; infrastructure failure preserves attempt 2, while ignored stale evidence leaves current authority untouched.
4. Infrastructure failure does not consume semantic attempt budget.
5. A Task suite never executes a check whose truth can observe sibling intermediate bytes, and persisted Task proof is rechecked against its exact byte scope.
6. A Wave suite executes only after every Wave Agent has stopped, and its accepted digest is part of protected Wave completion authority.
7. One pure evaluator decides equivalent Pi and Claude observations.
8. Missing, malformed, stale, duplicate, surplus, or conflicting evidence fails closed.
9. Regression execution and new-test creation are independent policies.
10. Model-authored shell text never becomes completion-command authority.

## Explicit non-goals

- Isolated Task worktrees in the first epic.
- Same-process Agent continuation parity.
- Best-of-N implementation candidates.
- Diff-scoped LLM re-review.
- Mutation testing.
- A generic workflow/command DSL.
- Rewriting the Loom lifecycle onto Fugue primitives that Fugue 0.4 does not expose.
