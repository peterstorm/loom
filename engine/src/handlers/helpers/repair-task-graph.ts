import { existsSync, readFileSync } from "node:fs";
import { taskGraphPath } from "../../config";
import { parseTaskGraph, StateManager } from "../../state-manager";
import type { HookHandler, TaskGraph } from "../../types";
import { fixFull, validateFull } from "./validate-task-graph";
import { checkPlanModelBindings, type ModelBindingDeps } from "./validate-model-bindings";

/** Filesystem adapter for the pure binding check; failures retain their cause. */
const BINDING_DEPS: ModelBindingDeps = {
  readFile: (p) => {
    try {
      return { ok: true, content: readFileSync(p, "utf-8") };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

export type TaskGraphRepairPreparation =
  | {
      readonly ok: true;
      readonly state: TaskGraph;
      readonly notes: readonly string[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
    };

/**
 * Pure repair boundary: transform untrusted disk JSON, reject any remaining
 * invariant violation, then parse the result into the type StateManager may
 * persist. Repairs that would drop audit or finding data fail closed.
 *
 * The executable-model binding check runs HERE, not only in
 * `validate-task-graph`'s CLI body. This helper installs through
 * `StateManager.replace`, deliberately bypassing `StateManager.load()` — which
 * makes it a second path that populates tasks into `active_task_graph.json`,
 * alongside `populate-task-graph`. `validateFull` is structural and carries no
 * binding check, so without this call a graph whose tasks carry a drifted or
 * missing Pipeline/Invariant binding would be structurally repaired and
 * installed as active state with the policy gate never run. Bindings are not
 * structurally fixable, so a violation is refused rather than repaired.
 */
export function prepareTaskGraphRepair(
  raw: unknown,
  deps: ModelBindingDeps = BINDING_DEPS,
): TaskGraphRepairPreparation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["Task graph must be a JSON object"] };
  }

  const repair = fixFull(raw as Record<string, unknown>);
  const repaired = JSON.parse(repair.json) as unknown;
  const repairedRecord = repaired as Record<string, unknown>;
  const validation = validateFull(repairedRecord, "state-file");
  const parsed = parseTaskGraph(repaired);
  // Checked against the REPAIRED graph: `fixFull` may have supplied structural
  // defaults the bindings are read through, and the repaired graph is what
  // would be installed.
  const bindings = checkPlanModelBindings(
    repairedRecord.plan_file,
    Array.isArray(repairedRecord.tasks) ? (repairedRecord.tasks as Record<string, unknown>[]) : [],
    deps,
  );
  const errors = [
    ...repair.dataLoss.map((note) => `Refusing lossy repair: ${note}`),
    ...(validation.ok ? [] : validation.errors),
    ...(parsed.ok ? [] : [parsed.error]),
    ...(bindings.ok ? [] : bindings.errors.map((error) => `Executable-model binding: ${error}`)),
  ];

  if (errors.length > 0 || !parsed.ok) return { ok: false, errors };
  return { ok: true, state: parsed.value, notes: repair.notes };
}

/**
 * Install a repaired graph without first loading it through StateManager: the
 * entire purpose of this helper is to recover state rejected by that boundary.
 * LOOM_STATE_PATH is the sanctioned way to target a non-default graph.
 */
const handler: HookHandler = async (_stdin, args) => {
  if (args.length > 0) {
    return {
      kind: "error",
      message: "Usage: bun cli.ts helper repair-task-graph (set LOOM_STATE_PATH to target another graph)",
    };
  }

  const statePath = taskGraphPath();
  if (!existsSync(statePath)) {
    return { kind: "error", message: `No active task graph at ${statePath}` };
  }

  let rawText: string;
  let raw: unknown;
  try {
    rawText = readFileSync(statePath, "utf-8");
    raw = JSON.parse(rawText) as unknown;
  } catch (error) {
    return {
      kind: "error",
      message: `Cannot read task graph as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const prepared = prepareTaskGraphRepair(raw);
  if (!prepared.ok) {
    return {
      kind: "error",
      message: [
        `Task graph repair refused (${prepared.errors.length} issue(s)); state was not modified:`,
        ...prepared.errors.map((error) => `  - ${error}`),
      ].join("\n"),
    };
  }

  const manager = StateManager.fromPath(statePath);
  if (manager === null) {
    return { kind: "error", message: `Task graph disappeared before repair: ${statePath}` };
  }

  try {
    await manager.replace(prepared.state);
  } catch (error) {
    return {
      kind: "error",
      message: `Could not atomically install repaired task graph: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  for (const note of prepared.notes) process.stderr.write(`  ${note}\n`);
  process.stderr.write(`Repaired task graph atomically: ${statePath}\n`);
  return { kind: "passthrough" };
};

export default handler;
