import { existsSync } from "node:fs";
import type { HookResult } from "../types";
import { taskGraphPath } from "../config";
import { StateManager } from "../state-manager";
import {
  classifyTaskExecutionSpawn,
  parseImplementationTaskBindings,
  registerTaskExecutionBaseline,
  staleReservationsFromState,
  taskExecutionDecision,
  taskExecutionOwnershipError,
  taskExecutionRegistrationError,
  type ExecutionBatchMode,
  type TaskExecutionSpawn,
  type ValidateTaskExecutionInput,
} from "../core/validate-task-execution";
import {
  captureDeclaredArtifactBaseline,
  captureRepositoryChangeBaseline,
} from "../utils/artifact-baseline";
import { repositoryContext } from "../utils/git";
import { anyActiveSubagent } from "../machine";
import type { TaskGraph } from "../types";

/**
 * Reservations no agent can still be serving.
 *
 * This registration commits `executing_tasks` during PreToolUse — before the
 * sibling PreToolUse gates (template substitution, agent model, agent skill)
 * have voted. When one of them denies the spawn, SubagentStart never fires, so
 * no SubagentStop ever arrives to clear the entry: the task is deadlocked
 * while owning its declared paths, taking every path-sharing sibling down with
 * it. A veto strands the reservation whatever the task's status was — wave
 * remediation re-spawns against `implemented` and `failed` tasks routinely —
 * so recovery cannot be limited to tasks still `pending`.
 *
 * A reservation is provably abandoned only when its task is not `completed`,
 * no subagent is active FOR THIS GRAPH, AND it has aged past the grace window.
 * All three matter: a `completed` task can never be re-executed;
 * `anyActiveSubagent` fails closed, so an unreadable roster or any live agent
 * on this graph releases nothing; and the grace window shields a freshly
 * committed reservation whose agent has not yet reached its SubagentStart
 * roster mark — without it, a parallel wave batch reclaims a live sibling that
 * is merely mid-startup (it has no roster entry, indistinguishable from a
 * vetoed spawn on that instant alone). See staleReservationsFromState.
 *
 * The graph scope is not a detail. SUBAGENT_DIR is shared by every project on
 * the machine, so a project-blind probe lets another repo's live agent — or
 * any stray roster file — veto recovery here indefinitely.
 */
function activeSubagentForGraph(taskGraphPath: string): boolean {
  return anyActiveSubagent(taskGraphPath);
}

/**
 * Imperative shell: preflight every input against one state snapshot, capture
 * every baseline, then register the accepted batch in one locked update. A
 * blocked sibling therefore leaves no ghost execution state behind — and a
 * spawn denied by a SIBLING HOOK, which this registration cannot observe, is
 * reclaimed by `staleTaskReservations` on the next attempt.
 */
export async function validateTaskExecutionBatch(
  spawns: readonly TaskExecutionSpawn[],
  mode: ExecutionBatchMode = "parallel",
): Promise<HookResult> {
  const inputs = spawns.filter(
    (spawn): spawn is Extract<TaskExecutionSpawn, { kind: "implementation" }> =>
      spawn.kind === "implementation",
  );
  if (inputs.length === 0) return { kind: "allow" };
  const statePath = taskGraphPath();
  if (!existsSync(statePath)) return { kind: "allow" };
  const manager = StateManager.fromPath(statePath);
  if (!manager) return { kind: "allow" };

  const state = manager.load();
  const bindings = parseImplementationTaskBindings(state, inputs);
  if (!bindings.ok) return { kind: "block", message: `BLOCKED: ${bindings.error}` };
  const taskIds = bindings.taskIds;
  // The roster fact (fs read) and the clock are resolved ONCE in the shell; the
  // pure staleness predicate is re-derived under the lock against the graph the
  // lock actually holds. Reusing `anyActive` under the lock is sound because
  // the grace window — not the roster flag — is what shields a live agent
  // during its startup gap: an agent that went active between this read and the
  // lock also carries a fresh `reserved_at`, so grace protects it regardless.
  const now = Date.now();
  const anyActive = activeSubagentForGraph(statePath);
  const staleReservations = staleReservationsFromState(state, anyActive, now);
  const ownershipError = taskExecutionOwnershipError(state, taskIds, mode, staleReservations);
  if (ownershipError !== null) return { kind: "block", message: `BLOCKED: ${ownershipError}` };

  for (const taskId of taskIds) {
    const decision = taskExecutionDecision(state, taskId);
    if (decision.kind === "block") return decision;
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
        repositoryAttempt,
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

  const reservedAt = new Date(now).toISOString();
  let lockedRegistrationError: string | null = null;
  await manager.update((current) => {
    // Re-derive staleness against the LOCKED graph (pure — same clock and
    // roster fact). If a racing sibling already committed one of these
    // reservations, its `reserved_at` is now young and it is no longer stale,
    // so this batch will not reclaim a live registration out from under it.
    const lockedStale = staleReservationsFromState(current, anyActive, now);
    lockedRegistrationError = taskExecutionRegistrationError(
      current, inputs, taskIds, mode, baselines, lockedStale,
    );
    if (lockedRegistrationError !== null) return current;
    return {
      ...current,
      // Released reservations are dropped rather than carried forward, so a
      // reclaimed task is registered once instead of accumulating a duplicate
      // entry that would survive its own SubagentStop cleanup.
      executing_tasks: [...new Set([
        ...(current.executing_tasks ?? []).filter((taskId) => !lockedStale.has(taskId)),
        ...baselines.keys(),
      ])],
      tasks: current.tasks.map((task) => {
        const artifactBaselines = baselines.get(task.id);
        return artifactBaselines === undefined
          ? task
          : {
              ...registerTaskExecutionBaseline(
                task,
                repository.headSha,
                artifactBaselines.proof,
                artifactBaselines.attempt,
                artifactBaselines.repositoryAttempt,
              ),
              // Stamp the reservation instant so the grace window can shield
              // this task while its agent starts. Refreshed every attempt.
              reserved_at: reservedAt,
            };
      }),
    };
  });
  return lockedRegistrationError === null
    ? { kind: "allow" }
    : { kind: "block", message: `BLOCKED: ${lockedRegistrationError}` };
}

export async function validateTaskExecution(input: ValidateTaskExecutionInput): Promise<HookResult> {
  return validateTaskExecutionBatch([classifyTaskExecutionSpawn(input)]);
}
