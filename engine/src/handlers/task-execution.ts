import { randomUUID } from "node:crypto";
import type { HookResult, TaskGraph } from "../types";
import { pathExistsFailClosed, taskGraphPath } from "../config";
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
  type TaskExecutionSpawn,
  type ValidateTaskExecutionInput,
} from "../core/validate-task-execution";
import {
  captureDeclaredArtifactBaseline,
  captureRepositoryChangeBaseline,
} from "../utils/artifact-baseline";
import { repositoryContext } from "../utils/git";
import { anyActiveSubagent } from "../machine";

export type TaskExecutionRegistrationOutcome =
  | Readonly<{
      kind: "registered";
      authorities: readonly ImplementationAttemptAuthority[];
    }>
  | Readonly<{ kind: "block"; message: string }>;

class LockedRegistrationRefusal extends Error {}

/**
 * Imperative shell: preflight one snapshot, capture baselines, then register
 * the accepted batch in one locked update. A sibling-hook veto that occurs
 * after registration becomes policy-eligible for exact reclamation only after
 * the grace period and a qualifying graph-scoped roster observation; the
 * policy does not prove process death. Pi consumes the returned authorities,
 * while the Claude wrapper correlates them through SubagentStart sidecars.
 */
export async function registerTaskExecutionBatch(
  spawns: readonly TaskExecutionSpawn[],
  mode: ExecutionBatchMode = "parallel",
  rosterObservation?: TaskExecutionRosterObservation,
): Promise<TaskExecutionRegistrationOutcome> {
  const inputs = spawns.filter(
    (spawn): spawn is Extract<TaskExecutionSpawn, { kind: "implementation" }> =>
      spawn.kind === "implementation",
  );
  if (inputs.length === 0) return { kind: "registered", authorities: Object.freeze([]) };
  const statePath = taskGraphPath();
  // Fail CLOSED on an unreadable graph: `existsSync` collapses EACCES/ELOOP/
  // ENOTDIR/EIO into `false`, which would wave the whole implementation batch
  // through with no ownership, staleness, or baseline check and no trace.
  if (!pathExistsFailClosed(statePath)) return { kind: "registered", authorities: Object.freeze([]) };
  // Past the fail-closed probe the graph is PRESENT-or-unprovable, so every
  // remaining failure to read it is a refusal, never a pass: returning "allow"
  // here is the same fail-open the probe above was introduced to close.
  const manager = StateManager.fromPath(statePath);
  if (!manager) {
    return { kind: "block", message: `BLOCKED: task graph at ${statePath} could not be opened; refusing to spawn implementation tasks unchecked` };
  }

  let state: TaskGraph;
  try {
    state = manager.load();
  } catch (error) {
    return {
      kind: "block",
      message: `BLOCKED: cannot read the task graph at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
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
    const decision = taskExecutionDecision(state, taskId);
    if (decision.kind === "ineligible") return { kind: "block", message: `BLOCKED: ${decision.reason}` };
  }

  const repository = repositoryContext();
  if (!repository.ok) {
    return {
      kind: "block",
      message: `BLOCKED: Cannot capture implementation baseline: ${repository.error}`,
    };
  }

  const baselines = new Map<string, Readonly<{
    proof: ReturnType<typeof captureDeclaredArtifactBaseline>;
    attempt: ReturnType<typeof captureDeclaredArtifactBaseline>;
    repositoryAttempt: ReturnType<typeof captureRepositoryChangeBaseline>;
    repositoryObservation: ReturnType<typeof captureRepositoryChangeBaseline>;
  }>>();
  let repositoryAttempt: ReturnType<typeof captureRepositoryChangeBaseline>;
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
    try {
      const declared = task.file_list ?? [];
      const attemptScope = [...new Set([...declared, ...(task.files_modified ?? [])])];
      baselines.set(taskId, {
        proof: captureDeclaredArtifactBaseline(repository.root, declared),
        attempt: captureDeclaredArtifactBaseline(repository.root, attemptScope),
        repositoryAttempt: task.repository_baseline ?? repositoryAttempt,
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
  );
  if (!authorityBatch.ok) return { kind: "block", message: `BLOCKED: ${authorityBatch.error}` };

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
        state: applyTaskExecutionAuthorityBatch(current, authorityBatch.plans, staleProofs, reservedAt),
        value: Object.freeze(authorityBatch.plans.map(({ authority }) => authority)),
      };
    });
    return { kind: "registered", authorities };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "block",
      message: `BLOCKED: ${error instanceof LockedRegistrationRefusal ? message : `Cannot atomically register implementation attempts: ${message}`}`,
    };
  }
}

/** Exact rollback used when a harness cannot carry a just-minted capability. */
export async function rollbackTaskExecutionRegistration(
  authorities: readonly ImplementationAttemptAuthority[],
): Promise<HookResult> {
  if (authorities.length === 0) return { kind: "allow" };
  const statePath = taskGraphPath();
  const manager = StateManager.fromPath(statePath);
  if (manager === null) {
    return { kind: "block", message: `BLOCKED: Cannot roll back implementation registration; task graph ${statePath} is unavailable.` };
  }
  const rolledBackAt = parseIsoInstant(new Date().toISOString(), "rollback instant");
  if (!rolledBackAt.ok) return { kind: "block", message: `BLOCKED: ${rolledBackAt.error.errors.join("; ")}` };
  try {
    await manager.update((state) => rollbackTaskExecutionAuthorityBatch(state, authorities, rolledBackAt.value));
    return { kind: "allow" };
  } catch (error) {
    return {
      kind: "block",
      message: `BLOCKED: Cannot roll back implementation registration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function validateTaskExecutionBatch(
  spawns: readonly TaskExecutionSpawn[],
  mode: ExecutionBatchMode = "parallel",
  rosterObservation?: TaskExecutionRosterObservation,
): Promise<HookResult> {
  const result = await registerTaskExecutionBatch(spawns, mode, rosterObservation);
  return result.kind === "registered" ? { kind: "allow" } : result;
}

export async function validateTaskExecution(input: ValidateTaskExecutionInput): Promise<HookResult> {
  return validateTaskExecutionBatch([classifyTaskExecutionSpawn(input)]);
}
