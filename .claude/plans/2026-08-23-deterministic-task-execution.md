# Plan: Deterministic Task Execution

## Status

Accepted architecture, recovered from the 2026-08-22 completion-oracle discussion and reconciled against Loom `main`. Slice 1 (Verification Policy) merged at `529ffb9`; Slice 2 (quiescent Wave completion suite) is implemented on the branch below. Slices 3–5 remain planned.

Implementation worktree: `~/dev/claude-plugins/loom-deterministic-task-execution`

Branch: `feat/deterministic-wave-completion-suite`

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
- Final validation: **215 test files, 5,313 passed, 1 intentional skip**; panel smoke **22/22**, review-panel smoke **19/19**, standalone review, orchestration façade, Pi resources, and TaskGraph **22/22**; typecheck, unused checks, full-tier lint, and diff checks passed.
- Existing live `web/chatbot` (23 Tasks) and `baby-adventure` (63 Tasks) legacy TaskGraphs pass the Slice 2 validator unchanged.

### Slice 3 — Task-local completion suite and attempt authority

- Add protected Task-attempt authority to reservations with separate Task-scope and repository dirty-set baseline digests.
- Add the pure `settleImplementationAttempt` reducer only when production state can mint and carry that authority.
- Run only explicitly file-local, non-observing checks at Task result settlement.
- Route Claude and Pi through `settleImplementationAttempt`.
- Remove inference-based success authority; inference may remain cleanup-only.
- Never block SubagentStop to continue the same child in this epic; retries are new engine-issued attempts in both harnesses.

### Slice 4 — bounded retry/escalation

- Freeze attempt-1 and attempt-2 contexts before dispatch.
- Persist retry diagnostics and issued request identity.
- One retry for semantic failure; explicit escalation after attempt 2.
- Infrastructure retry policy remains separate.

### Slice 5 — attributed events and semantic Task output

- Add proven per-Task event identity where the harness exposes or can carry it.
- Never infer parallel Claude tool attribution from `executing_tasks`.
- Persist typed Task output for dependent Task briefs.
- Compile Requirement Completion Claims into frozen assertions where supported.

## Invariants

1. Only engine-issued Implementation Attempt authority can settle a Task.
2. Exactly one current attempt exists per executing Task.
3. Attempt 2 is terminal: success, escalation, infrastructure block, or ignored stale result.
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
