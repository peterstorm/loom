import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import populate from "../../src/handlers/helpers/populate-task-graph";
import type { Task, TaskGraph } from "../../src/types";

/**
 * Exercises the REAL populate-task-graph overwrite guard through the handler's
 * entry point — not a re-implemented copy. The handler resolves LOOM_STATE_PATH
 * lazily (taskGraphPath() at call time), so pointing it at a per-test state file
 * needs no module reload. A model-free plan file passes checkPlanModelBindings
 * trivially, so control reaches the overwrite guard at populate-task-graph.ts:126.
 */

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  delete process.env.LOOM_STATE_PATH;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-populate-guard-"));
  dirs.push(dir);
  return dir;
}

/** A readable plan declaring no models — the binding check passes trivially. */
function modelFreePlan(dir: string): string {
  const planFile = join(dir, "plan.md");
  writeFileSync(planFile, "# Plan\n\nNo models.\n");
  return planFile;
}

function writeState(dir: string, planFile: string, tasks: Task[]): string {
  const statePath = join(dir, "active_task_graph.json");
  const state: TaskGraph = {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: planFile,
    tasks,
    wave_gates: {},
  };
  writeFileSync(statePath, JSON.stringify(state));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

function existingTask(id: string, status: Task["status"]): Task {
  return { id, description: "x", agent: "code-implementer-agent", wave: 1, status, depends_on: [] };
}

function decomposeJson(planFile: string): string {
  return JSON.stringify({
    plan_title: "t",
    spec_file: "spec.md",
    plan_file: planFile,
    tasks: [{ id: "T9", description: "impl", agent: "code-implementer-agent", wave: 1, depends_on: [], spec_anchors: [], new_tests_required: true, plan_context: "", file_list: ["src/other.ts"] }],
  });
}

describe("populate-task-graph — overwrite guard (funneled through the real handler)", () => {
  it("blocks overwriting a graph with a non-pending task (no --force)", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, [
      existingTask("T1", "implemented"),
      existingTask("T2", "pending"),
    ]);
    const result = await populate(decomposeJson(plan), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("non-pending");
    // The guard actually prevented the write — the old tasks survive.
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
    expect(after.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
  });

  it("allows overwriting a non-pending graph WITH --force (guard bypassed, tasks replaced)", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, [existingTask("T1", "completed")]);
    const result = await populate(decomposeJson(plan), ["--force"]);
    expect(result.kind).toBe("passthrough");
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
    expect(after.tasks.map((t) => t.id)).toEqual(["T9"]);
  });

  it("allows overwriting when every existing task is pending (no --force needed)", async () => {
    const dir = tempDir();
    const plan = modelFreePlan(dir);
    const statePath = writeState(dir, plan, [existingTask("T1", "pending"), existingTask("T2", "pending")]);
    const result = await populate(decomposeJson(plan), []);
    expect(result.kind).toBe("passthrough");
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as TaskGraph;
    expect(after.tasks.map((t) => t.id)).toEqual(["T9"]);
  });
});
