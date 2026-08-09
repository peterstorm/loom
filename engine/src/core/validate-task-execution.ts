/** Pure task-execution lifecycle classification and gate decisions. */

import type { HookResult, Task, TaskGraph } from "../types";
import { IMPL_AGENTS, isStandaloneReviewAgent } from "../config";
import { extractTaskId } from "../utils/extract-task-id";
import { stripNamespace } from "../utils/strip-namespace";
import { hasStandaloneReviewContext } from "./review-output";
import type { DeclaredArtifactBaseline } from "./artifact-baseline";

export interface ValidateTaskExecutionInput {
  readonly agentType: string;
  readonly prompt: string;
  readonly description: string;
}

/**
 * Parsed lifecycle for one spawn. Only the implementation arm carries text
 * from which a task id may be extracted; review/refutation/phase work cannot
 * accidentally enter implementation execution state.
 */
export type TaskExecutionSpawn =
  | Readonly<{ kind: "standalone" }>
  | Readonly<{ kind: "implementation"; prompt: string; description: string }>
  | Readonly<{ kind: "non-implementation" }>;

/** Pure boundary parser from harness fields to the closed lifecycle union. */
export function classifyTaskExecutionSpawn(input: ValidateTaskExecutionInput): TaskExecutionSpawn {
  const agent = stripNamespace(input.agentType);
  if (hasStandaloneReviewContext(input.prompt) && isStandaloneReviewAgent(agent)) {
    return { kind: "standalone" };
  }
  return IMPL_AGENTS.has(agent) || IMPL_AGENTS.has(`${agent}-agent`)
    ? { kind: "implementation", prompt: input.prompt, description: input.description }
    : { kind: "non-implementation" };
}

/** Pure task gate used by both single and batch shell entry points. */
export function taskExecutionDecision(state: TaskGraph, taskId: string): HookResult {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return { kind: "allow" };
  if (task.status === "completed") {
    return {
      kind: "block",
      message: `BLOCKED: Cannot execute ${taskId} because it is already completed.`,
    };
  }

  const currentWave = state.current_wave ?? 1;
  if (task.wave > currentWave) {
    return {
      kind: "block",
      message: `BLOCKED: Cannot execute ${taskId} (wave ${task.wave}) - current wave is ${currentWave}\nComplete all wave ${currentWave} tasks first.`,
    };
  }

  for (const dep of task.depends_on) {
    const depTask = state.tasks.find((candidate) => candidate.id === dep);
    if (!depTask) {
      return {
        kind: "block",
        message: `BLOCKED: Cannot execute ${taskId} - dependency ${dep} not found in task graph`,
      };
    }
    if (depTask.status !== "completed") {
      return {
        kind: "block",
        message: `BLOCKED: Cannot execute ${taskId} - dependency ${dep} not complete (status: ${depTask.status})`,
      };
    }
  }

  if (task.wave === currentWave && currentWave > 1) {
    const prevWave = String(currentWave - 1);
    const gate = state.wave_gates[prevWave];
    if (gate && !gate.reviews_complete) {
      const lines = [`BLOCKED: Wave ${prevWave} review gate not passed.`, ""];
      if (gate.blocked) {
        lines.push(`Wave ${prevWave} is BLOCKED due to:`);
        if (gate.tests_passed === false) lines.push("  - Integration tests failed");
        const critCount = state.tasks
          .filter((candidate) => candidate.wave === currentWave - 1)
          .reduce((sum, candidate) => sum + (candidate.critical_findings?.length ?? 0), 0);
        if (critCount > 0) lines.push(`  - ${critCount} critical review findings`);
      } else {
        lines.push(`Wave ${prevWave} gates not yet run.`);
      }
      lines.push("", "Run: /wave-gate");
      return { kind: "block", message: lines.join("\n") };
    }
  }

  return { kind: "allow" };
}

export type ImplementationTaskBindings =
  | Readonly<{ ok: true; taskIds: readonly string[] }>
  | Readonly<{ ok: false; error: string }>;

export type ExecutionBatchMode = "parallel" | "sequential";

/**
 * Pure ownership invariant for one execution reservation. Active tasks own
 * their declared paths until stop cleanup. One reservation captures all task
 * baselines before dispatch, so even sequential siblings must be disjoint;
 * path handoff requires separate calls so each task gets a fresh baseline.
 */
export function taskExecutionOwnershipError(
  state: TaskGraph,
  taskIds: readonly string[],
  mode: ExecutionBatchMode,
): string | null {
  const requested = new Set(taskIds);
  const active = new Set(state.executing_tasks ?? []);
  for (const taskId of taskIds) {
    if (active.has(taskId)) return `Task ${taskId} is already executing.`;
  }

  const requestedTasks = taskIds.flatMap((taskId) => {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    return task === undefined ? [] : [task];
  });
  const activeTasks = state.tasks.filter((task) => active.has(task.id) && !requested.has(task.id));
  for (const incoming of requestedTasks) {
    for (const owner of activeTasks) {
      if (incoming.wave !== owner.wave) continue;
      const overlap = (incoming.file_list ?? []).find((path) => owner.file_list?.includes(path));
      if (overlap !== undefined) {
        return `Task ${incoming.id} cannot execute while ${owner.id} owns declared path ${overlap}.`;
      }
    }
  }

  for (let leftIndex = 0; leftIndex < requestedTasks.length; leftIndex++) {
    const left = requestedTasks[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < requestedTasks.length; rightIndex++) {
      const right = requestedTasks[rightIndex]!;
      if (left.wave !== right.wave) continue;
      const overlap = (left.file_list ?? []).find((path) => right.file_list?.includes(path));
      if (overlap === undefined) continue;
      return mode === "parallel"
        ? `Parallel implementation tasks ${left.id} and ${right.id} both declare ${overlap}; use disjoint scopes.`
        : `Sequential implementation tasks ${left.id} and ${right.id} both declare ${overlap}; overlapping handoff requires separate subagent calls so each task receives a fresh baseline.`;
    }
  }
  return null;
}

/** Pure smart constructor for the task identities carried by one spawn batch. */
export function parseImplementationTaskBindings(
  state: TaskGraph,
  inputs: readonly Extract<TaskExecutionSpawn, { kind: "implementation" }>[],
): ImplementationTaskBindings {
  const taskIds: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const taskId = extractTaskId(input.prompt) ?? extractTaskId(input.description);
    if (taskId === null) {
      return { ok: false, error: `Implementation spawn ${index + 1} has no extractable Task ID while a task graph is active.` };
    }
    if (!state.tasks.some((task) => task.id === taskId)) {
      return { ok: false, error: `Implementation spawn ${index + 1} names unknown task ${taskId}.` };
    }
    if (taskIds.includes(taskId)) {
      return { ok: false, error: `Implementation batch binds task ${taskId} more than once.` };
    }
    taskIds.push(taskId);
  }
  return { ok: true, taskIds };
}

export type TaskExecutionBaselines = ReadonlyMap<string, Readonly<{
  proof: readonly DeclaredArtifactBaseline[];
  attempt: readonly DeclaredArtifactBaseline[];
  repositoryAttempt: readonly DeclaredArtifactBaseline[];
}>>;

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

/** Revalidate every preflight assumption against the graph held under the
 * state lock. Returning one error keeps batch registration all-or-nothing. */
export function taskExecutionRegistrationError(
  current: TaskGraph,
  inputs: readonly Extract<TaskExecutionSpawn, { kind: "implementation" }>[],
  expectedTaskIds: readonly string[],
  mode: ExecutionBatchMode,
  baselines: TaskExecutionBaselines,
): string | null {
  const rebound = parseImplementationTaskBindings(current, inputs);
  if (!rebound.ok) return rebound.error;
  if (!samePaths(rebound.taskIds, expectedTaskIds)) {
    return "Implementation task bindings changed before execution registration.";
  }
  const ownership = taskExecutionOwnershipError(current, expectedTaskIds, mode);
  if (ownership !== null) return ownership;
  for (const taskId of expectedTaskIds) {
    const decision = taskExecutionDecision(current, taskId);
    if (decision.kind === "block") return decision.message.replace(/^BLOCKED:\s*/, "");
    const task = current.tasks.find((candidate) => candidate.id === taskId);
    const baseline = baselines.get(taskId);
    if (task === undefined || baseline === undefined) {
      return `Cannot prove locked execution baseline for ${taskId}.`;
    }
    const declared = task.file_list ?? [];
    const attemptScope = [...new Set([...declared, ...(task.files_modified ?? [])])];
    if (!samePaths(declared, baseline.proof.map(({ artifact }) => artifact)) ||
        !samePaths(attemptScope, baseline.attempt.map(({ artifact }) => artifact))) {
      return `Task ${taskId} artifact scope changed before execution registration.`;
    }
  }
  return null;
}

/** Preserve the first proof boundary across retries while refreshing the
 * current-attempt boundary. Proof must keep seeing all bytes produced by the
 * task; evidence invalidation must see only bytes produced after this spawn. */
export function registerTaskExecutionBaseline(
  task: Task,
  sha: string,
  proofBaseline: readonly DeclaredArtifactBaseline[],
  attemptBaseline: readonly DeclaredArtifactBaseline[] = proofBaseline,
  repositoryAttemptBaseline: readonly DeclaredArtifactBaseline[] = [],
): Task {
  return {
    ...task,
    start_sha: task.start_sha ?? sha,
    artifact_baseline: task.artifact_baseline ?? proofBaseline,
    attempt_artifact_baseline: attemptBaseline,
    attempt_repository_baseline: repositoryAttemptBaseline,
  };
}
