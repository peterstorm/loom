/**
 * Populate task graph with decompose output.
 * Merges existing phase tracking with new tasks.
 *
 * Usage: bun cli.ts helper populate-task-graph [--issue N] [--repo OWNER/REPO] [--fix]
 * Reads decompose JSON from stdin.
 */

import { existsSync } from "node:fs";
import type { HookHandler, TaskGraph, Task, WaveGate } from "../../types";
import { newWaveGate } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { validateFull, fixFull } from "./validate-task-graph";
import { checkPlanModelBindings, productionModelBindingDeps } from "./validate-model-bindings";
import { derivePendingTaskProof } from "../../core/proof-obligations";
import { argumentValue, hasFlag } from "./cli-args";
import {
  serializeVerificationPolicy,
  taskVerificationPolicy,
} from "../../core/verification-policy";

interface DecomposeInput {
  spec_trace_version: 2;
  plan_title: string;
  plan_file?: string;
  spec_file?: string;
  tasks: Task[];
}

/**
 * Through `cli-args`, not by hand: the hand-rolled loop this replaced accepted
 * the NEXT FLAG as a value, so `--issue --fix` read as `issue = NaN` with
 * `--fix` silently consumed — the exact divergence `argumentValue` exists to
 * end.
 */
type PopulateArgs = Readonly<{
  issue?: number;
  repo?: string;
  fix: boolean;
  force: boolean;
}>;

type ParsedPopulateArgs =
  | Readonly<{ ok: true; value: PopulateArgs }>
  | Readonly<{ ok: false; error: string }>;

function parseArgs(args: string[]): ParsedPopulateArgs {
  const issueFlagPresent = hasFlag(args, "--issue");
  const rawIssue = argumentValue(args, "--issue");
  if (issueFlagPresent && rawIssue === null) {
    return { ok: false, error: "--issue requires a positive integer value" };
  }
  if (rawIssue !== null && !/^[1-9]\d*$/.test(rawIssue)) {
    return { ok: false, error: `--issue must be a positive integer, got '${rawIssue}'` };
  }
  const issue = rawIssue === null ? undefined : Number(rawIssue);
  if (issue !== undefined && !Number.isSafeInteger(issue)) {
    return { ok: false, error: `--issue must be a safe positive integer, got '${rawIssue}'` };
  }
  const repo = argumentValue(args, "--repo");
  return {
    ok: true,
    value: {
      ...(issue === undefined ? {} : { issue }),
      ...(repo === null ? {} : { repo }),
      fix: hasFlag(args, "--fix"),
      force: hasFlag(args, "--force"),
    },
  };
}

/**
 * Decompose stdin is agent-controlled text: it may DESCRIBE work (id,
 * description, agent, wave, deps, Requirement Completion Claims,
 * Contributions, test requirements, file list) but must never carry execution state. The decompose-contract fields
 * are picked explicitly (never spread) so a payload that pre-stamps
 * `test_result: {verdict: "trusted-pass"}`, `status: "completed"`, or
 * `review_status: "passed"` cannot reach the persisted graph — trusted
 * verdicts exist only via the evidence ledger, mirroring the refusal in
 * store-test-evidence.
 */
function sanitizeDecomposedTask(t: Task): Task {
  const verificationPolicy = taskVerificationPolicy(t);
  return {
    id: t.id,
    description: t.description,
    agent: t.agent,
    wave: t.wave,
    status: "pending",
    depends_on: t.depends_on ?? [],
    spec_anchors: Object.freeze([...(t.spec_anchors ?? [])]),
    spec_contributions: Object.freeze([...(t.spec_contributions ?? [])]),
    verification_policy: serializeVerificationPolicy(verificationPolicy),
    ...(t.plan_context !== undefined ? { plan_context: t.plan_context } : {}),
    ...(t.file_list !== undefined ? { file_list: t.file_list } : {}),
    proof: derivePendingTaskProof({
      verificationPolicy,
      declaredArtifacts: t.file_list ?? [],
    }),
    review_status: "pending",
    review_generation: 0,
    findings: [],
    critical_findings: [],
    advisory_findings: [],
    refuted_findings: [],
    resolved_findings: [],
  };
}

function taskWaves(tasks: readonly Task[]): readonly number[] {
  return [...new Set(tasks.map((task) => task.wave))].sort((left, right) => left - right);
}

/** Build wave gates for all waves */
function buildWaveGates(waves: readonly number[]): Record<string, WaveGate> {
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

  const parsedArgs = parseArgs(args);
  if (!parsedArgs.ok) return { kind: "error", message: `populate-task-graph: ${parsedArgs.error}` };
  const { issue, repo, fix, force } = parsedArgs.value;

  let decompose: DecomposeInput;
  try {
    decompose = JSON.parse(stdin) as DecomposeInput;
  } catch (e) {
    // Preserve the parse error: "Invalid JSON on stdin" alone left the operator
    // with no position or malformed token to look for.
    return {
      kind: "error",
      message: `Invalid JSON on stdin: ${e instanceof Error ? e.message : String(e)}`,
    };
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

  // Executable-models policy: bindings are enforced here fail-closed —
  // validate-task-graph's 4a run is advisory to the orchestrator, this is the
  // gate for the populate path. `repair-task-graph` is the ONE other
  // whitelisted helper that writes tasks into active_task_graph.json (it
  // installs through StateManager.replace, bypassing load() by design), and it
  // runs the same `checkPlanModelBindings` for the same reason; neither path
  // may install a graph whose bindings were never checked. The plan path
  // prefers evidence-derived
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
    productionModelBindingDeps,
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
  const waves = taskWaves(decompose.tasks);

  // Guard against overwriting non-pending tasks
  if (!force && existingState.tasks.some((t) => t.status !== "pending")) {
    return {
      kind: "error",
      message: "Cannot overwrite task graph with non-pending tasks. Use --force to override.",
    };
  }

  const populate = async (): Promise<void> => mgr.update((existing) => {
    // Re-check the guard INSIDE the locked transform. The check above ran on a
    // snapshot loaded before the lock, and this callback receives a freshly
    // reloaded graph — so a task that left "pending" in between (an agent
    // starting, a wave completing) had its real status silently overwritten by
    // the unconditional `tasks:` assignment below. The pre-lock check stays: it
    // gives the operator the clean CLI error in the common case; this one makes
    // the overwrite impossible in the racing case.
    if (!force && existing.tasks.some((t) => t.status !== "pending")) {
      throw new Error(
        "Cannot overwrite task graph with non-pending tasks: a task left \"pending\" while this " +
        "population was being prepared. Use --force to override.",
      );
    }
    const merged: TaskGraph = {
      ...existing,
      spec_trace_version: 2,
      plan_title: decompose.plan_title,
      plan_file: validatedPlanFile,
      spec_file: existing.spec_file ?? decompose.spec_file ?? null,
      tasks: decompose.tasks.map(sanitizeDecomposedTask),
      current_wave: 1,
      executing_tasks: [],
      wave_gates: buildWaveGates(waves),
      ...(issue === undefined ? {} : { github_issue: issue }),
      ...(repo === undefined ? {} : { github_repo: repo }),
    };

    return merged;
  });

  try {
    await populate();
  } catch (error) {
    // The locked re-check refuses by throwing (the only way out of a transform);
    // surface it as the same clean CLI error the pre-lock check produces rather
    // than as an unhandled rejection.
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  const taskCount = decompose.tasks.length;
  process.stderr.write(`Task graph populated: ${taskCount} tasks, waves: ${waves.join(", ")}\n`);

  return { kind: "passthrough" };
};

export default handler;
