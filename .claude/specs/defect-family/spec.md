# Feature: Orchestration stale-flow proof-boundary capture

**Spec ID:** defect-family-stale-flow
**Created:** 2026-09-18
**Status:** Approved
**Owner:** Loom maintainers

## Summary

Loom's per-task proof settlement must be deterministic even when a task's production is committed before its first implementation dispatch. Today a session interrupted before the first dispatch leaves its work committed in the graph while the settlement baseline is re-registered afterward — the stale-flow wedge — and the proof then fails or mis-attributes bytes that pre-date dispatch. The feature fixes two seams: task-graph population captures each task's proof boundary (`artifact_baseline` and `start_sha`) at the population revision before any work exists, and settlement's declared-artifact-changed is driven by the cumulative path set that includes proof-boundary changes. The wedge becomes unrepresentable, and normal flow is unchanged because a child's proof changes are always a subset of the cumulative set.

## User Scenarios

### US1: [P1] A Task Whose Work Is Committed Before Dispatch Settles Deterministically

**As a** Loom operator running an orchestrated implementation wave
**I want to** see a task settle correctly even when its work was committed before the first dispatch
**So that** a session interrupted before dispatch cannot strand the task as perpetually unimplemented or settle it against a baseline that post-dates its production

**Why this priority:** The stale-flow wedge surfaces as an unrecoverable task state in real interrupted sessions; any settlement that depends on the child editing files at dispatch time is unsound by construction.

**Acceptance Scenarios:**
- AS-001: Given a task whose work is committed before the first implementation dispatch, When task-graph population has captured `artifact_baseline` and `start_sha` at the population revision and the task settles, Then proof.changed includes the committed work, the cumulative path set includes it, and the proof settles satisfied even if the child makes no edits.
- AS-002: Given a task populated at some revision, When the first dispatch occurs, Then `registerTaskExecutionBaseline` prefers the population-stamped `task.artifact_baseline` and `task.start_sha`, so the proof boundary always predates the task's production.

### US2: [P1] Settlement Credits Proof-Boundary Bytes

**As a** Loom review gate
**I want to** classify every byte a task's proof boundary introduced as declared-artifact-changed
**So that** the Oracle's `filesModified` and new-test collection see all bytes attributable to the task, and no production can shade out-of-scope

**Acceptance Scenarios:**
- AS-003: Given a task settles with prior and attributed path sets, When the cumulative set is derived, Then it is the union of the prior paths, the attributed attempt paths, and proof.changed — so proof-boundary changes are always included.
- AS-004: Given a normal task whose child edits files during dispatch, When the cumulative set is derived, Then proof.changed is a subset of it, so the settlement behavior of the normal flow is unchanged.

## Functional Requirements

- FR-001: Task-graph population MUST capture each task's proof boundary (`artifact_baseline` and `start_sha`) at the population revision, before any production work exists, and the first dispatch MUST preserve it (`registerTaskExecutionBaseline` MUST prefer the populated task values).
- FR-002: Settlement's declared-artifact-changed MUST be driven by the cumulative path set, which MUST be the union of the prior paths, the attributed attempt paths, and proof.changed; cumulative proof artifact changes MUST equal proof.changed, and the normal flow MUST remain unchanged because proof.changed is a subset of the cumulative set.

## Out of Scope

Explicitly NOT part of this feature:

- OOS-001: Changing the proof engine's attribution model beyond the cumulative union of prior, attributed-attempt, and proof-boundary paths.
- OOS-002: Changing dispatch-time baseline behavior beyond preferring the population-stamped task values.
- OOS-003: Altering review, refutation, or advisory settlement authority beyond declared-artifact-changed cumulative inclusion.
- OOS-004: Introducing a new settlement command or operator override for the stale-flow case; the fix must be structural in population and settlement.

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Proof boundary | The pair (`artifact_baseline`, `start_sha`) recorded at population revision, identifying the byte state a task's production is measured against. |
| Stale-flow wedge | The unrecoverable state in which a task's work is committed before its first dispatch, so a post-dispatch baseline never sees it as production. |
| Cumulative path set | The union of prior modified paths, the attributed attempt paths, and proof.changed, used for declared-artifact-changed classification. |
| Declared-artifact-changed | The settlement verdict domain naming every byte introduced by a task; cumulativeProofArtifactChanges equals proof.changed. |
| Population revision | The exact repository revision at which task-graph population stamps the proof boundary. |
