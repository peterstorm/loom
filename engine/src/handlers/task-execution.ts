import { randomUUID } from "node:crypto";
import type { HookResult, TaskGraph } from "../types";
import { findTaskGraphPathFrom, pathExistsFailClosed, taskGraphPath } from "../config";
import { StateManager } from "../state-manager";
import {
  parseIsoInstant,
  parseReservationId,
  type ImplementationAttemptAuthority,
} from "../core/implementation-completion";
import {
  applyTaskExecutionAuthorityBatch,
  classifyTaskExecutionSpawn,
  createTaskExecutionAuthorityBatch,
  parseImplementationTaskBindings,
  proveStaleReservations,
  rollbackTaskExecutionAuthorityBatch,
  staleReservationsForRosterObservation,
  taskExecutionDecision,
  taskExecutionOwnershipError,
  taskExecutionRegistrationError,
  type ExecutionBatchMode,
  type TaskExecutionRosterObservation,
  type TaskExecutionAuthorityPlan,
  type TaskExecutionSpawn,
  type ValidateTaskExecutionInput,
} from "../core/validate-task-execution";
import { parseTaskBaselineField, type ArtifactBaseline } from "../core/artifact-baseline";
import { captureDeclaredArtifactBaseline } from "../utils/declared-artifact-snapshot";
import { captureRepositoryChangeBaseline } from "../utils/repository-change-baseline";
import { repositoryContext } from "../utils/git";
import { anyActiveSubagent } from "../machine";
import { materializeTaskSkeletons } from "../orchestration/skeleton-materialization";
import { renderLeftPreparedName } from "../core/skeleton/problems";
import {
  describeDistillSnapshotFailure,
  distillSnapshotScope,
  settledDistillSnapshotDigests,
  type DistillSnapshotPort,
} from "../core/distill-snapshot";
import { distillSnapshotRef, isDistillTask } from "../core/distill-task";
import type { DomainResult } from "../core/orchestration-contract";
import { discardDistillSnapshots, gitDistillSnapshots } from "../orchestration/distill-snapshot";

type RepositoryChangeBaseline = ArtifactBaseline<"repository-change">;

export type TaskExecutionRegistrationOutcome =
  | Readonly<{
      kind: "registered";
      authorities: readonly ImplementationAttemptAuthority[];
    }>
  | Readonly<{ kind: "block"; message: string }>;

class LockedRegistrationRefusal extends Error {}

/**
 * Snapshot every registering Distill Task's attempt scope under its freshly
 * minted authority (ADR-0068 §5), before the reservation is committed and so
 * before its agent can write. The scope is the attempt baseline's own paths
 * (`distillSnapshotScope`), captured moments earlier from the same bytes.
 * Returns the authority digests snapshotted, for the caller to discard should
 * the locked registration then refuse. A snapshot that cannot be taken
 * refuses the batch, and the snapshots already taken for it are discarded: no
 * Distill Task attempt exists without one.
 *
 * It first discards the snapshots of the Task's earlier, semantically settled
 * attempts (`settledDistillSnapshotDigests`): settlement discards each once
 * its state is persisted (`settleAndPersistExactImplementation`), and this
 * catches one whose discard was lost.
 */
function captureDistillSnapshots(
  root: string,
  state: TaskGraph,
  plans: readonly TaskExecutionAuthorityPlan[],
  snapshots: DistillSnapshotPort,
): DomainResult<readonly string[], string> {
  const captured: string[] = [];
  for (const { authority, baselines } of plans) {
    const task = state.tasks.find((candidate) => candidate.id === authority.taskId);
    if (task === undefined || !isDistillTask(task)) continue;
    discardDistillSnapshots(root, settledDistillSnapshotDigests(task), snapshots);
    const snapshot = snapshots.capture(root, authority.authorityDigest, distillSnapshotScope(baselines.attempt));
    if (!snapshot.ok) {
      discardDistillSnapshots(root, captured, snapshots);
      return {
        ok: false,
        error: `Cannot snapshot the distill scope of ${authority.taskId}: ${describeDistillSnapshotFailure(snapshot.error)}; ` +
          "a Distill Task attempt is not registered without the snapshot its restore needs",
      };
    }
    captured.push(authority.authorityDigest);
  }
  return { ok: true, value: Object.freeze(captured) };
}

/**
 * Imperative shell: preflight one snapshot, capture baselines, then register
 * the accepted batch in one locked update. A sibling-hook veto that occurs
 * after registration becomes policy-eligible for exact reclamation only after
 * the grace period and a qualifying graph-scoped roster observation; the
 * policy does not prove process death. Pi consumes the returned authorities,
 * while the Claude wrapper correlates them through SubagentStart sidecars.
 *
 * An optional `spawnCwd` re-roots the whole registration at the spawn's
 * declared repository: the graph that governs a repository lives IN that
 * repository, so a batch whose items declare a linked worktree registers in
 * the worktree's graph and snapshots the worktree's baselines, while the
 * orchestrator runtime itself stays rooted wherever it is. The no-argument
 * call preserves the historical runtime-cwd resolution exactly.
 *
 * A Distill Task's attempt scope is snapshotted (`captureDistillSnapshots`)
 * once its authority is minted and before the locked update commits the
 * reservation; `distillSnapshots` is the store, Git's in production.
 */
export async function registerTaskExecutionBatch(
  spawns: readonly TaskExecutionSpawn[],
  mode: ExecutionBatchMode = "parallel",
  rosterObservation?: TaskExecutionRosterObservation,
  spawnCwd?: string,
  distillSnapshots: DistillSnapshotPort = gitDistillSnapshots,
): Promise<TaskExecutionRegistrationOutcome> {
  const inputs = spawns.filter(
    (spawn): spawn is Extract<TaskExecutionSpawn, { kind: "implementation" }> =>
      spawn.kind === "implementation",
  );
  if (inputs.length === 0) return { kind: "registered", authorities: Object.freeze([]) };
  let statePath = "<unresolved>";
  let manager: StateManager;
  let state: TaskGraph;
  try {
    statePath = spawnCwd === undefined ? taskGraphPath() : findTaskGraphPathFrom(spawnCwd);
    // Fail CLOSED on an unreadable graph: `existsSync` collapses EACCES/ELOOP/
    // ENOTDIR/EIO into `false`, which would wave the whole implementation batch
    // through with no ownership, staleness, or baseline check and no trace.
    if (!pathExistsFailClosed(statePath)) return { kind: "registered", authorities: Object.freeze([]) };
    const candidate = StateManager.fromPath(statePath);
    if (candidate === null) {
      return { kind: "block", message: `BLOCKED: task graph at ${statePath} disappeared during registration; refusing to spawn implementation tasks unchecked` };
    }
    manager = candidate;
    state = manager.load();
  } catch (error) {
    return {
      kind: "block",
      message: `BLOCKED: cannot establish task graph authority at ${statePath}: ${error instanceof Error ? error.message : String(error)}; refusing unchecked implementation spawn`,
    };
  }
  const bindings = parseImplementationTaskBindings(state, inputs);
  if (!bindings.ok) return { kind: "block", message: `BLOCKED: ${bindings.error}` };
  const taskIds = bindings.taskIds;
  // The roster fact and clock are resolved ONCE in the shell; the pure
  // staleness predicate is re-derived under the lock against the graph the lock
  // actually holds. Pi supplies the fact sampled before its own prospective
  // roster rows were added. Other callers probe here. In either case a racing
  // successful registration carries a fresh `reserved_at`, so grace protects
  // it when this same observation is reused under the lock.
  const now = Date.now();
  const observedRoster: TaskExecutionRosterObservation = rosterObservation ?? {
    kind: "at-registration",
    anyActiveForGraph: anyActiveSubagent(statePath),
  };
  const staleFor = (snapshot: TaskGraph) =>
    staleReservationsForRosterObservation(snapshot, observedRoster, now);
  const staleReservations = staleFor(state);
  const ownershipError = taskExecutionOwnershipError(state, taskIds, mode, staleReservations);
  if (ownershipError !== null) return { kind: "block", message: `BLOCKED: ${ownershipError}` };

  for (const taskId of taskIds) {
    const decision = taskExecutionDecision(state, taskId, taskIds);
    if (decision.kind === "ineligible") return { kind: "block", message: `BLOCKED: ${decision.reason}` };
  }

  const repository = repositoryContext(spawnCwd);
  if (!repository.ok) {
    return {
      kind: "block",
      message: `BLOCKED: Cannot capture implementation baseline: ${repository.error}`,
    };
  }

  // Skeletons materialize before any baseline is captured (AD-1): the
  // engine's bytes are part of every baseline this attempt starts from, so
  // they are never attributed to the implementer. A stage-two problem, or a
  // write the no-clobber writer refused, blocks the whole batch. A prepared
  // name a write left behind blocks nothing: it is an operator note.
  const skeletons = materializeTaskSkeletons(repository.root, state, taskIds);
  if (!skeletons.ok) {
    return {
      kind: "block",
      message: `BLOCKED: Cannot materialize the skeletons of ${taskIds.join(", ")}: ${skeletons.error.join("; ")}`,
    };
  }
  for (const leftover of skeletons.value.leftovers) {
    process.stderr.write(`[loom] skeleton note: ${renderLeftPreparedName(leftover)}\n`);
  }

  const baselines = new Map<string, Readonly<{
    proof: ReturnType<typeof captureDeclaredArtifactBaseline>;
    attempt: ReturnType<typeof captureDeclaredArtifactBaseline>;
    repositoryAttempt: RepositoryChangeBaseline;
    repositoryObservation: RepositoryChangeBaseline;
  }>>();
  let repositoryAttempt: RepositoryChangeBaseline;
  try {
    repositoryAttempt = captureRepositoryChangeBaseline(repository.root);
  } catch (error) {
    return {
      kind: "block",
      message: `BLOCKED: Cannot snapshot repository changes: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  for (const taskId of taskIds) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) continue;
    // A retained repository baseline is the stored wire record; re-prove it
    // under the digest scheme its field owns so the in-memory bundle keeps the brand.
    const retained = parseTaskBaselineField(task, "repository_baseline", `${taskId} repository_baseline`);
    if (retained !== undefined && !retained.ok) {
      return { kind: "block", message: `BLOCKED: Invalid retained repository baseline: ${retained.errors.join("; ")}` };
    }
    try {
      const declared = task.file_list ?? [];
      const attemptScope = [...new Set([...declared, ...(task.files_modified ?? [])])];
      baselines.set(taskId, {
        proof: captureDeclaredArtifactBaseline(repository.root, declared),
        attempt: captureDeclaredArtifactBaseline(repository.root, attemptScope),
        repositoryAttempt: retained?.value ?? repositoryAttempt,
        repositoryObservation: repositoryAttempt,
      });
    } catch (error) {
      return {
        kind: "block",
        message: `BLOCKED: Cannot snapshot declared artifacts for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (baselines.size !== taskIds.length) {
    return {
      kind: "block",
      message: "BLOCKED: Cannot capture implementation baselines for every bound task.",
    };
  }

  const parsedReservedAt = parseIsoInstant(new Date(now).toISOString(), "reservation instant");
  if (!parsedReservedAt.ok) {
    return { kind: "block", message: `BLOCKED: ${parsedReservedAt.error.errors.join("; ")}` };
  }
  const reservedAt = parsedReservedAt.value;
  const reservationIds = inputs.map(() => parseReservationId(randomUUID(), "generated reservation id"));
  const invalidReservation = reservationIds.find((result) => !result.ok);
  if (invalidReservation !== undefined && !invalidReservation.ok) {
    return { kind: "block", message: `BLOCKED: ${invalidReservation.error.errors.join("; ")}` };
  }
  const authorityBatch = createTaskExecutionAuthorityBatch(
    state,
    inputs,
    taskIds,
    reservationIds.flatMap((result) => result.ok ? [result.value] : []),
    repository.headSha,
    reservedAt,
    baselines,
    skeletons.value,
  );
  if (!authorityBatch.ok) return { kind: "block", message: `BLOCKED: ${authorityBatch.error}` };
  const snapshotted = captureDistillSnapshots(repository.root, state, authorityBatch.plans, distillSnapshots);
  if (!snapshotted.ok) return { kind: "block", message: `BLOCKED: ${snapshotted.error}` };

  try {
    const authorities = await manager.updateAndReturn((current) => {
      // Every graph-derived preflight fact is recomputed under the State File
      // lock. The stale proofs are minted from THIS snapshot, and application
      // still compares their exact authority digests before releasing anything.
      const lockedStale = staleFor(current);
      const lockedPlansError = taskExecutionRegistrationError(
        current,
        inputs,
        taskIds,
        mode,
        baselines,
        lockedStale,
        authorityBatch.plans,
      );
      if (lockedPlansError !== null) throw new LockedRegistrationRefusal(lockedPlansError);
      const staleProofs = proveStaleReservations(current, lockedStale);
      return {
        state: applyTaskExecutionAuthorityBatch(current, authorityBatch.plans, staleProofs, reservedAt, authorityBatch.skeletonRecords),
        value: Object.freeze(authorityBatch.plans.map(({ authority }) => authority)),
      };
    });
    return { kind: "registered", authorities };
  } catch (error) {
    // Nothing was reserved, so no attempt will ever read these snapshots.
    discardDistillSnapshots(repository.root, snapshotted.value, distillSnapshots);
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "block",
      message: `BLOCKED: ${error instanceof LockedRegistrationRefusal ? message : `Cannot atomically register implementation attempts: ${message}`}`,
    };
  }
}

/**
 * Discard the snapshots of rolled-back Distill Task attempts. The rollback is
 * already committed, so a repository that cannot be resolved here fails
 * nothing: the refs it leaves are named on stderr, as a failed discard is.
 */
function discardRolledBackDistillSnapshots(
  rolledBack: readonly ImplementationAttemptAuthority[],
  spawnCwd: string | undefined,
  snapshots: DistillSnapshotPort,
): void {
  const digests = rolledBack.map(({ authorityDigest }) => authorityDigest);
  const repository = repositoryContext(spawnCwd);
  if (repository.ok) {
    discardDistillSnapshots(repository.root, digests, snapshots);
    return;
  }
  process.stderr.write(
    `[loom] distill snapshot note: ${digests.map(distillSnapshotRef).join(", ")} left in place for rolled-back ` +
      `${rolledBack.map(({ taskId }) => taskId).join(", ")}: ${repository.error}\n`,
  );
}

/** Exact rollback used when a harness cannot carry a just-minted capability.
 *  The optional `spawnCwd` must be the SAME repository the registration
 *  resolved: a rollback that targets a different graph would reclaim
 *  reservations the wrong State File still holds. A rolled-back Distill Task
 *  attempt never ran, so its snapshot is discarded with it. */
export async function rollbackTaskExecutionRegistration(
  authorities: readonly ImplementationAttemptAuthority[],
  spawnCwd?: string,
  distillSnapshots: DistillSnapshotPort = gitDistillSnapshots,
): Promise<HookResult> {
  if (authorities.length === 0) return { kind: "allow" };
  let statePath = "<unresolved>";
  try {
    statePath = spawnCwd === undefined ? taskGraphPath() : findTaskGraphPathFrom(spawnCwd);
    const manager = StateManager.fromPath(statePath);
    if (manager === null) {
      return { kind: "block", message: `BLOCKED: Cannot roll back implementation registration; task graph ${statePath} is unavailable.` };
    }
    const rolledBackAt = parseIsoInstant(new Date().toISOString(), "rollback instant");
    if (!rolledBackAt.ok) return { kind: "block", message: `BLOCKED: ${rolledBackAt.error.errors.join("; ")}` };
    const distillTaskIds = await manager.updateAndReturn((state) => ({
      state: rollbackTaskExecutionAuthorityBatch(state, authorities, rolledBackAt.value),
      value: new Set(state.tasks.filter(isDistillTask).map(({ id }): string => id)),
    }));
    const rolledBackDistill = authorities.filter(({ taskId }) => distillTaskIds.has(taskId));
    if (rolledBackDistill.length > 0) discardRolledBackDistillSnapshots(rolledBackDistill, spawnCwd, distillSnapshots);
    return { kind: "allow" };
  } catch (error) {
    return {
      kind: "block",
      message: `BLOCKED: Cannot roll back implementation registration at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function validateTaskExecutionBatch(
  spawns: readonly TaskExecutionSpawn[],
  mode: ExecutionBatchMode = "parallel",
  rosterObservation?: TaskExecutionRosterObservation,
  spawnCwd?: string,
): Promise<HookResult> {
  const result = await registerTaskExecutionBatch(spawns, mode, rosterObservation, spawnCwd);
  return result.kind === "registered" ? { kind: "allow" } : result;
}

export async function validateTaskExecution(input: ValidateTaskExecutionInput): Promise<HookResult> {
  return validateTaskExecutionBatch([classifyTaskExecutionSpawn(input)]);
}
