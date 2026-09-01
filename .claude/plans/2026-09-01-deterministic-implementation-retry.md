# Deterministic implementation Slice 4 — bounded retry and escalation

## Status

Accepted implementation architecture for `feat/deterministic-implementation-retry`, based on merged `main` at `cfeacae6c49c2e66a2cde9cbf491454978362736`.

## Objective

Close the lifecycle Slice 3 deliberately left open: an exact semantic attempt-1 failure must authorize exactly one error-aware attempt 2, while an attempt-2 semantic failure must produce explicit terminal escalation. Infrastructure failures remain retryable at the same semantic attempt and never consume the two-attempt budget.

## Approach decision

### A. Derive retry admission from protected Task history — selected

The existing implementation window remains the parent-facing orchestration seam. A pure core derives `attempt 1 | attempt 2 | escalated` from exact settlement history. Status publishes the exact attempt-2 prompt appendix. The shared Claude/Pi PreToolUse gate requires that appendix and atomically installs attempt authority plus frozen prompt/context identity before dispatch.

Pros: one State File aggregate, exact crash recovery, no cross-resource transaction, Pi/Claude parity, no new generic program. Cons: the parent still interprets the existing `spawn-wave-implementation` recovery action.

### B. One registered Run Directory program per retry — rejected

This would provide first-class Agent Request Authority, but settlement would need an atomic State File ↔ Run Directory commit-reference protocol solely to issue one retry. It duplicates the implementation window and materially widens Slice 4.

### C. Same-child continuation — rejected

Claude can sometimes block SubagentStop, while normal Pi children have already exited. This cannot provide harness parity and contradicts the accepted fresh-attempt architecture.

## Domain model

### Implementation Retry Context

A canonical immutable value derived from the exact attempt-1 `retry-required` settlement receipt:

```typescript
type ImplementationRetryContext = Readonly<{
  schemaVersion: 1;
  kind: "implementation-retry-context";
  taskId: TaskId;
  semanticAttempt: 2;
  predecessorReceiptId: ImplementationSettlementReceiptId;
  failureKinds: NonEmpty<string>;
}>;
```

Its rendered prompt appendix is deterministic and parsed exactly. A stale, malformed, duplicate, missing, wrong-Task, or wrong-receipt appendix cannot authorize attempt 2.

### Implementation Attempt Context

Frozen before each dispatch and bound to the active authority:

```typescript
type ImplementationAttemptContext = Readonly<{
  schemaVersion: 1;
  kind: "implementation-attempt-context";
  taskId: TaskId;
  semanticAttempt: 1 | 2;
  authorityDigest: ImplementationAuthorityDigest;
  promptDigest: ArtifactDigest;
  predecessorReceiptId: ImplementationSettlementReceiptId | null;
  retryContext: ImplementationRetryContext | null;
  contextDigest: ArtifactDigest;
}>;
```

It is protected Task state while the attempt is active. Settlement, exact rollback, and stale reclamation clear it with the matching authority. The settlement receipt retains issued request identity after the active context retires.

### Retry admission

The pure command validates the complete history in wire order; each legal `implemented` receipt resets the current lineage to attempt 1:

- no semantic-consuming receipt → attempt 1;
- one `retry-required` receipt and no later escalation → attempt 2, exact appendix required;
- `escalation-required` → terminal escalation, spawn refused;
- any number of `infrastructure-blocked` receipts → preserve the current semantic attempt;
- malformed/contradictory history → fail closed.

## Components

### Functional core

- `engine/src/core/implementation-retry.ts`
  - exact Retry Context parser/renderer;
  - admission derivation;
  - active Attempt Context constructor/parser;
  - status dispatch instruction and escalation projection.
- `engine/src/core/validate-task-execution.ts`
  - derive admission for every bound spawn;
  - mint authority with the derived semantic attempt;
  - install authority and Attempt Context atomically.
- `engine/src/core/implementation-application.ts`
  - clear Attempt Context with exact settlement.
- `engine/src/core/wave-gate-machine.ts`
  - publish exact initial/retry dispatch instructions;
  - publish terminal escalation rather than re-spawn.

### Imperative shell

- `engine/src/handlers/task-execution.ts`
  - parse prompt appendix, capture prompt bytes/digest, and install one locked registration.
- Pi and Claude continue through this same shared registration path; no transport may infer semantic attempt independently.
- `commands/loom.md` and `commands/templates/impl-agent-context.md` explain how the parent appends the engine-issued retry appendix exactly.

## Invariants

1. Attempt 2 is impossible without one exact current attempt-1 `retry-required` receipt.
2. Attempt 2 is impossible with missing, stale, malformed, or modified Retry Context.
3. At most one semantic retry exists per lineage.
4. Attempt-2 semantic failure is terminal escalation and cannot be manually re-spawned.
5. Infrastructure failure never changes semantic attempt.
6. Active authority and Attempt Context agree on Task, attempt, authority digest, and prompt digest.
7. Pi and Claude use the same admission and registration functions.
8. Late/duplicate results cannot clear a replacement Attempt Context.
9. A newly accepted implementation receipt starts a fresh remediation lineage at attempt 1 when the non-completed Task is deliberately re-executed.

## Testing

### Pure examples/properties

- attempt selection for every valid history prefix;
- infrastructure insertion does not alter attempt selection;
- exact retry render/parse round trip;
- one-byte/context-field changes reject;
- escalation is terminal;
- constructor/parser round trip and digest tamper rejection.

### Integration

- shared registration installs semantic attempt 2 and frozen context;
- missing/stale retry appendix blocks before `executing_tasks` mutation;
- settlement/rollback/reclamation clear only matching context;
- status emits exact retry instructions and terminal escalation;
- Pi tool-call admission carries attempt 2; Claude handler uses the same registration path;
- full existing unit and smoke suites remain green.

## Implementation outcome

- Added the pure bounded retry/context module and exact settlement-receipt parser surface.
- Shared registration derives semantic attempt from immutable history, requires exact attempt-2 context, and freezes prompt/context identity atomically with authority and baselines.
- StateManager proves retry lineage, active context/authority, baseline, and executing membership lockstep.
- Settlement, rollback, reclamation, Claude, and Pi cleanup retire only matching context authority.
- Canonical status emits initial/retry dispatches or terminal escalation; Pi and resume-after-clear now consume the canonical status seam.
- Pi registers the post-write-grant child-visible prompt and has a real attempt-1 → attempt-2 → escalation → attempt-3-refusal integration test.
- Updated `/loom`, implementation prompt, workflows, deterministic design status, and `CONTEXT.md`.

## Validation receipt

- Focused pure/core/StateManager/registration/status/Pi suites: green throughout.
- Authoritative unit suite: **232 files, 6,035 passed, 1 platform skip, 0 failures**.
- TypeScript and unused-code gates: passed.
- Full-tier lint: **11 changed production TypeScript files, 0 violations**.
- Smoke: panel mode 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.

## Distill/deepen receipt

Applied:

1. Removed unused Task status from retry admission.
2. Branded prompt/context digests as `ArtifactDigest`.
3. Reused the existing hash capability rather than granting a new Node builtin.
4. Flattened status recovery control flow.
5. Extracted Pi admission rollback into grant, roster, pointer, and retained-debt operations while preserving effect order.
6. Reused the canonical status read seam from Pi and deleted the Pi-only status policy.

Skipped: a new per-retry Run Directory program and same-child continuation. Both add broader seams than Slice 4 needs; the former creates cross-resource commit complexity, and the latter cannot preserve Pi/Claude parity.

## Documentation and vault

- Slice 4 remains explicitly **feature-branch evidence**, not shipped, until review and merge.
- `CONTEXT.md` defines Implementation Retry Context.
- The vault’s Loom MOC, deterministic Task execution note, and quality roadmap now record PR #35, shipped Slices 1–3, active issue #39, and the next ranked work. Vault auto-sync committed those note changes without absorbing unrelated in-progress creative files.
