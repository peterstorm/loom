import { existsSync } from "node:fs";
import type { HookResult } from "../types";
import { taskGraphPath } from "../config";
import { StateManager } from "../state-manager";
import {
  classifyTaskExecutionSpawn,
  parseImplementationTaskBindings,
  registerTaskExecutionBaseline,
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

/**
 * Imperative shell: preflight every input against one state snapshot, capture
 * every baseline, then register the accepted batch in one locked update. A
 * blocked sibling therefore leaves no ghost execution state behind.
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
  const ownershipError = taskExecutionOwnershipError(state, taskIds, mode);
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

  let lockedRegistrationError: string | null = null;
  await manager.update((current) => {
    lockedRegistrationError = taskExecutionRegistrationError(current, inputs, taskIds, mode, baselines);
    if (lockedRegistrationError !== null) return current;
    return {
      ...current,
      executing_tasks: [...new Set([...(current.executing_tasks ?? []), ...baselines.keys()])],
      tasks: current.tasks.map((task) => {
        const artifactBaselines = baselines.get(task.id);
        return artifactBaselines === undefined
          ? task
          : registerTaskExecutionBaseline(
              task,
              repository.headSha,
              artifactBaselines.proof,
              artifactBaselines.attempt,
              artifactBaselines.repositoryAttempt,
            );
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
