/**
 * Populate task graph with decompose output.
 * Merges existing phase tracking with new tasks.
 *
 * Usage: bun cli.ts helper populate-task-graph [--issue N] [--repo OWNER/REPO] [--fix]
 * Reads decompose JSON from stdin.
 */

import { existsSync, readFileSync } from "node:fs";
import type { HookHandler, TaskGraph, Task, WaveGate } from "../../types";
import { newWaveGate } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { validateFull, fixFull } from "./validate-task-graph";
import { checkPlanModelBindings, type ModelBindingDeps } from "./validate-model-bindings";
import { derivePendingTaskProof } from "../../core/proof-obligations";

/** Honest null on any read failure — the binding check reports it in context */
const BINDING_DEPS: ModelBindingDeps = {
  readFile: (p) => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  },
};

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

/**
 * Decompose stdin is agent-controlled text: it may DESCRIBE work (id,
 * description, agent, wave, deps, spec anchors, test requirements, file
 * list) but must never carry execution state. The decompose-contract fields
 * are picked explicitly (never spread) so a payload that pre-stamps
 * `test_result: {verdict: "trusted-pass"}`, `status: "completed"`, or
 * `review_status: "passed"` cannot reach the persisted graph — trusted
 * verdicts exist only via the evidence ledger, mirroring the refusal in
 * store-test-evidence.
 */
function sanitizeDecomposedTask(t: Task): Task {
  return {
    id: t.id,
    description: t.description,
    agent: t.agent,
    wave: t.wave,
    status: "pending",
    depends_on: t.depends_on ?? [],
    ...(t.spec_anchors !== undefined ? { spec_anchors: t.spec_anchors } : {}),
    ...(t.new_tests_required !== undefined ? { new_tests_required: t.new_tests_required } : {}),
    ...(t.plan_context !== undefined ? { plan_context: t.plan_context } : {}),
    ...(t.file_list !== undefined ? { file_list: t.file_list } : {}),
    proof: derivePendingTaskProof({
      newTestsRequired: t.new_tests_required !== false,
      declaredArtifacts: t.file_list ?? [],
    }),
    review_status: "pending",
    findings: [],
    critical_findings: [],
    advisory_findings: [],
    refuted_findings: [],
  };
}

/** Build wave gates for all waves */
function buildWaveGates(tasks: Task[]): Record<string, WaveGate> {
  const waves = [...new Set(tasks.map((t) => t.wave))].sort((a, b) => a - b);
  const gates: Record<string, WaveGate> = {};
  for (const w of waves) {
    gates[String(w)] = newWaveGate();
  }
  return gates;
}

const handler: HookHandler = async (stdin, args) => {
  // Resolved at call time (not import time) so env re-pointing is honored.
  const statePath = taskGraphPath();
  if (!existsSync(statePath)) {
    return { kind: "error", message: `No task graph at ${statePath}` };
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

  // Validate decompose output before merging. Scoped to the PAYLOAD: the
  // findings aggregate is agent-forgeable here and `sanitizeDecomposedTask`
  // strips it below, so holding this to the load-boundary findings rules would
  // reject exactly the input that sanitization exists to clean.
  const validation = validateFull(decompose as unknown as Record<string, unknown>, "decompose-payload");
  if (!validation.ok) {
    if (fix) {
      const repair = fixFull(decompose as unknown as Record<string, unknown>);
      for (const note of repair.notes) process.stderr.write(`  ${note}\n`);
      decompose = JSON.parse(repair.json) as DecomposeInput;
      // fixFull only defaults missing optional fields — structural errors
      // (unknown agent, wave gaps, self-dependency) are unfixable. Re-validate
      // so they fail loudly instead of reaching the persisted graph under a
      // misleading "Auto-fixed" banner.
      const revalidation = validateFull(decompose as unknown as Record<string, unknown>, "decompose-payload");
      if (!revalidation.ok) {
        return {
          kind: "error",
          message: `--fix could not repair all issues:\n${revalidation.errors.map(e => `  - ${e}`).join("\n")}`,
        };
      }
      process.stderr.write(`Auto-fixed ${validation.errors.length} issues\n`);
    } else {
      return { kind: "error", message: `Decompose validation failed:\n${validation.errors.map(e => `  - ${e}`).join("\n")}` };
    }
  }

  const mgr = StateManager.fromPath(statePath);
  if (!mgr) return { kind: "error", message: "Cannot open task graph" };

  // Executable-models policy: this is the only whitelisted helper that
  // populates tasks into active_task_graph.json, so bindings are enforced
  // here fail-closed — validate-task-graph's 4a run is advisory to the
  // orchestrator, this is the gate. The plan path prefers evidence-derived
  // state (plan_file set by advance-phase from transcript-parsed Write tool
  // calls (existence-checked), else the
  // architecture phase artifact recorded from disk) over the decompose
  // payload, so a decompose agent cannot re-point plan_file at a model-free
  // file to disarm the check. The SAME resolved path is persisted below —
  // persisting the payload's path would disarm the wave-gate lifecycle check.
  const existingState = mgr.load();
  const planFile =
    existingState.plan_file ??
    existingState.phase_artifacts?.architecture ??
    decompose.plan_file;
  const bindings = checkPlanModelBindings(
    planFile,
    decompose.tasks as unknown as Record<string, unknown>[],
    BINDING_DEPS,
  );
  if (!bindings.ok) {
    return {
      kind: "error",
      message: [
        `Executable-model binding validation FAILED (${bindings.errors.length} errors) — task graph not populated:`,
        ...bindings.errors.map((e) => `  - ${e}`),
      ].join("\n"),
    };
  }
  // checkPlanModelBindings only passes when planFile is a readable string
  const validatedPlanFile = planFile as string;

  // Guard against overwriting non-pending tasks
  if (!force && existingState.tasks.some((t) => t.status !== "pending")) {
    return {
      kind: "error",
      message: "Cannot overwrite task graph with non-pending tasks. Use --force to override.",
    };
  }

  await mgr.update((existing) => {
    const merged: TaskGraph = {
      ...existing,
      plan_title: decompose.plan_title,
      plan_file: validatedPlanFile,
      spec_file: existing.spec_file ?? decompose.spec_file ?? null,
      tasks: decompose.tasks.map(sanitizeDecomposedTask),
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
