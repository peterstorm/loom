/**
 * Core: Validate wave order, dependencies, and review gates before task execution.
 * Harness-agnostic — no stdin parsing. Not pure: reads the filesystem
 * (existsSync; loads the task graph).
 */

import { existsSync } from "node:fs";
import type { HookResult } from "../types";
import { TASK_GRAPH_PATH } from "../config";
import { extractTaskId } from "../utils/extract-task-id";
import { StateManager } from "../state-manager";
import * as git from "../utils/git";
import { captureDeclaredArtifactBaseline } from "../utils/artifact-baseline";

export interface ValidateTaskExecutionInput {
  prompt: string;
  description: string;
}

export async function validateTaskExecution(input: ValidateTaskExecutionInput): Promise<HookResult> {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };

  const taskId = extractTaskId(input.prompt) ?? extractTaskId(input.description);
  if (!taskId) return { kind: "allow" };

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "allow" };

  const state = mgr.load();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return { kind: "allow" };

  const currentWave = state.current_wave ?? 1;

  // Check 1: Wave order
  if (task.wave > currentWave) {
    return {
      kind: "block",
      message: `BLOCKED: Cannot execute ${taskId} (wave ${task.wave}) - current wave is ${currentWave}\nComplete all wave ${currentWave} tasks first.`,
    };
  }

  // Check 2: Dependencies complete
  for (const dep of task.depends_on) {
    const depTask = state.tasks.find((t) => t.id === dep);
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

  // Check 3: Previous wave review gate (only for wave > 1)
  if (task.wave === currentWave && currentWave > 1) {
    const prevWave = String(currentWave - 1);
    const gate = state.wave_gates[prevWave];

    if (gate && !gate.reviews_complete) {
      const lines = [`BLOCKED: Wave ${prevWave} review gate not passed.`, ""];
      if (gate.blocked) {
        lines.push(`Wave ${prevWave} is BLOCKED due to:`);
        if (gate.tests_passed === false) lines.push("  - Integration tests failed");
        const critCount = state.tasks
          .filter((t) => t.wave === currentWave - 1)
          .reduce((sum, t) => sum + (t.critical_findings?.length ?? 0), 0);
        if (critCount > 0) lines.push(`  - ${critCount} critical review findings`);
      } else {
        lines.push(`Wave ${prevWave} gates not yet run.`);
      }
      lines.push("", "Run: /wave-gate");

      return { kind: "block", message: lines.join("\n") };
    }
  }

  // Capture the exact declared-artifact state BEFORE the agent starts. A
  // transcript records attempted tool calls; only this byte-level baseline can
  // prove that a declared artifact actually changed during the task.
  if (taskId && git.isGitRepo()) {
    const sha = git.headSha();
    const root = git.repositoryRoot();
    if (sha && root) {
      let artifactBaseline: ReturnType<typeof captureDeclaredArtifactBaseline>;
      try {
        artifactBaseline = captureDeclaredArtifactBaseline(root, task.file_list ?? []);
      } catch (error) {
        return {
          kind: "block",
          message: `BLOCKED: Cannot snapshot declared artifacts for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      await mgr.update((s) => ({
        ...s,
        executing_tasks: [...new Set([...(s.executing_tasks ?? []), taskId])],
        tasks: s.tasks.map((t) =>
          t.id === taskId ? { ...t, start_sha: sha, artifact_baseline: artifactBaseline } : t
        ),
      }));
    }
  }

  return { kind: "allow" };
}
