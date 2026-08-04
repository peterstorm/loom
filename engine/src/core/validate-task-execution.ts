/**
 * Core: Validate wave order, dependencies, and review gates before task execution.
 * Harness-agnostic — no stdin parsing. Not pure: reads the filesystem
 * (existsSync; loads the task graph).
 */

import { existsSync } from "node:fs";
import type { HookResult, TaskGraph } from "../types";
import { TASK_GRAPH_PATH } from "../config";
import { extractTaskId } from "../utils/extract-task-id";
import { StateManager } from "../state-manager";
import * as git from "../utils/git";
import { captureDeclaredArtifactBaseline } from "../utils/artifact-baseline";

export interface ValidateTaskExecutionInput {
  prompt: string;
  description: string;
}

/** Pure task gate used by both single and batch shell entry points. */
export function taskExecutionDecision(state: TaskGraph, taskId: string): HookResult {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return { kind: "allow" };

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

/**
 * Imperative shell: preflight every input against one state snapshot, capture
 * every baseline, then register the accepted batch in one locked update. A
 * blocked sibling therefore leaves no ghost execution state behind.
 */
export async function validateTaskExecutionBatch(
  inputs: readonly ValidateTaskExecutionInput[],
): Promise<HookResult> {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };
  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "allow" };

  const state = mgr.load();
  const taskIds = [...new Set(inputs.flatMap((input) => {
    const taskId = extractTaskId(input.prompt) ?? extractTaskId(input.description);
    return taskId === null ? [] : [taskId];
  }))];

  for (const taskId of taskIds) {
    const decision = taskExecutionDecision(state, taskId);
    if (decision.kind === "block") return decision;
  }

  if (!git.isGitRepo()) return { kind: "allow" };
  const sha = git.headSha();
  const root = git.repositoryRoot();
  if (!sha || !root) return { kind: "allow" };

  const baselines = new Map<string, ReturnType<typeof captureDeclaredArtifactBaseline>>();
  for (const taskId of taskIds) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) continue;
    try {
      baselines.set(taskId, captureDeclaredArtifactBaseline(root, task.file_list ?? []));
    } catch (error) {
      return {
        kind: "block",
        message: `BLOCKED: Cannot snapshot declared artifacts for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (baselines.size === 0) return { kind: "allow" };

  await mgr.update((current) => ({
    ...current,
    executing_tasks: [...new Set([...(current.executing_tasks ?? []), ...baselines.keys()])],
    tasks: current.tasks.map((task) => {
      const artifactBaseline = baselines.get(task.id);
      return artifactBaseline === undefined ? task : { ...task, start_sha: sha, artifact_baseline: artifactBaseline };
    }),
  }));
  return { kind: "allow" };
}

export async function validateTaskExecution(input: ValidateTaskExecutionInput): Promise<HookResult> {
  return validateTaskExecutionBatch([input]);
}
