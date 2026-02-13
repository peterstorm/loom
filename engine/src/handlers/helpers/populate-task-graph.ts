/**
 * Populate task graph with decompose output.
 * Merges existing phase tracking with new tasks.
 *
 * Usage: bun cli.ts helper populate-task-graph [--issue N] [--repo OWNER/REPO] [--fix]
 * Reads decompose JSON from stdin.
 */

import { existsSync, readFileSync } from "node:fs";
import type { HookHandler, TaskGraph, Task, WaveGate } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import { validateFull, fixFull } from "./validate-task-graph";

interface DecomposeInput {
  plan_title: string;
  plan_file?: string;
  spec_file?: string;
  tasks: Task[];
}

function parseArgs(args: string[]): { issue?: number; repo?: string; fix: boolean; force: boolean } {
  let issue: number | undefined;
  let repo: string | undefined;
  let fix = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--issue" && args[i + 1]) { issue = Number(args[++i]); continue; }
    if (args[i] === "--repo" && args[i + 1]) { repo = args[++i]; continue; }
    if (args[i] === "--fix") { fix = true; continue; }
    if (args[i] === "--force") { force = true; continue; }
  }

  return { issue, repo, fix, force };
}

/** Build wave gates for all waves */
function buildWaveGates(tasks: Task[]): Record<string, WaveGate> {
  const waves = [...new Set(tasks.map((t) => t.wave))].sort((a, b) => a - b);
  const gates: Record<string, WaveGate> = {};
  for (const w of waves) {
    gates[String(w)] = { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false };
  }
  return gates;
}

const handler: HookHandler = async (stdin, args) => {
  if (!existsSync(TASK_GRAPH_PATH)) {
    return { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` };
  }

  const { issue, repo, fix, force } = parseArgs(args);

  let decompose: DecomposeInput;
  try {
    decompose = JSON.parse(stdin) as DecomposeInput;
  } catch {
    return { kind: "error", message: "Invalid JSON on stdin" };
  }

  if (!Array.isArray(decompose.tasks) || decompose.tasks.length === 0) {
    return { kind: "error", message: "No tasks in decompose JSON" };
  }

  // Validate decompose output before merging
  const validation = validateFull(decompose as unknown as Record<string, unknown>);
  if (!validation.valid) {
    if (fix) {
      decompose = JSON.parse(fixFull(decompose as unknown as Record<string, unknown>)) as DecomposeInput;
      process.stderr.write(`Auto-fixed ${validation.errors.length} issues\n`);
    } else {
      return { kind: "error", message: `Decompose validation failed:\n${validation.errors.map(e => `  - ${e}`).join("\n")}` };
    }
  }

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: "Cannot open task graph" };

  // Guard against overwriting non-pending tasks
  if (!force) {
    const existing = mgr.load();
    if (existing.tasks.some((t) => t.status !== "pending")) {
      return {
        kind: "error",
        message: "Cannot overwrite task graph with non-pending tasks. Use --force to override.",
      };
    }
  }

  await mgr.update((existing) => {
    const merged: TaskGraph = {
      ...existing,
      plan_title: decompose.plan_title,
      plan_file: decompose.plan_file ?? existing.plan_file,
      spec_file: decompose.spec_file ?? existing.spec_file,
      tasks: decompose.tasks,
      current_wave: 1,
      executing_tasks: [],
      wave_gates: buildWaveGates(decompose.tasks),
    };

    if (issue) merged.github_issue = issue;
    if (repo) merged.github_repo = repo;

    return merged;
  });

  const taskCount = decompose.tasks.length;
  const waves = [...new Set(decompose.tasks.map((t) => t.wave))].sort((a, b) => a - b);
  process.stderr.write(`Task graph populated: ${taskCount} tasks, waves: ${waves.join(", ")}\n`);

  return { kind: "passthrough" };
};

export default handler;
