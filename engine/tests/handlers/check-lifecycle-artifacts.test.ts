import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gateHandler, {
  checkLifecycleArtifacts,
  loadPlanModelsSource,
  type PlanModelsSource,
} from "../../src/handlers/helpers/complete-wave-gate";
import type { Task } from "../../src/types";
import type { PlanModels } from "../../src/parsers/parse-plan-models";

function waveTask(fileList: string[]): Task {
  return {
    id: "T1",
    description: "impl",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    depends_on: [],
    file_list: fileList,
  };
}

function loaded(lifecycles: PlanModels["lifecycles"]): PlanModelsSource {
  return { kind: "loaded", models: { lifecycles, pipeline: null, invariants: [], strays: [] } };
}

describe("checkLifecycleArtifacts (wave-gate evidence check)", () => {
  it("skips when there is no plan in state (legacy flows)", () => {
    const check = checkLifecycleArtifacts({ kind: "none" }, [waveTask(["a.ts"])], () => false);
    expect(check.passed).toBe(true);
  });

  it("fails closed when the plan is named but unreadable", () => {
    const check = checkLifecycleArtifacts({ kind: "unreadable", path: "/gone/plan.md" }, [], () => true);
    expect(check.passed).toBe(false);
    if (!check.passed) expect(check.reason).toContain("unreadable");
  });

  it("passes when no lifecycle is bound to this wave", () => {
    const source = loaded([{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }]);
    const check = checkLifecycleArtifacts(source, [waveTask(["src/unrelated.ts"])], () => false);
    expect(check.passed).toBe(true);
    if (check.passed) expect(check.summary).toContain("none bound");
  });

  it("FAILS when a bound machine file was not created by the wave", () => {
    const source = loaded([{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }]);
    const check = checkLifecycleArtifacts(source, [waveTask(["src/order-machine.ts"])], () => false);
    expect(check.passed).toBe(false);
    if (!check.passed) {
      expect(check.reason).toContain("LC-1");
      expect(check.reason).toContain("src/order-machine.ts");
    }
  });

  it("passes when the bound machine file exists on disk", () => {
    const source = loaded([{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }]);
    const check = checkLifecycleArtifacts(source, [waveTask(["src/order-machine.ts"])], (p) => p === "src/order-machine.ts");
    expect(check.passed).toBe(true);
    if (check.passed) expect(check.summary).toContain("LC-1");
  });

  it("checks only lifecycles bound to THIS wave's tasks", () => {
    const source = loaded([
      { id: "LC-1", title: "A", machineFile: "src/a-machine.ts" },
      { id: "LC-2", title: "B", machineFile: "src/b-machine.ts" },
    ]);
    // wave contains only LC-1's file; LC-2's file missing on disk is fine here
    const check = checkLifecycleArtifacts(source, [waveTask(["src/a-machine.ts"])], (p) => p === "src/a-machine.ts");
    expect(check.passed).toBe(true);
  });

  it("ignores lifecycles with no machine file (blocked earlier at populate)", () => {
    const source = loaded([{ id: "LC-1", title: "A", machineFile: null }]);
    const check = checkLifecycleArtifacts(source, [waveTask(["x.ts"])], () => false);
    expect(check.passed).toBe(true);
  });
});

describe("complete-wave-gate handler wiring (check 5 is actually in the gate)", () => {
  let dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "loom-gate-handler-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
    delete process.env.LOOM_STATE_PATH;
  });

  // The handler resolves LOOM_STATE_PATH lazily (taskGraphPath() at call
  // time), so pointing it at a per-test state file needs no module reload —
  // this runs identically under `bun test` and `vitest run`.
  function loadGateWithState(statePath: string): typeof gateHandler {
    process.env.LOOM_STATE_PATH = statePath;
    return gateHandler;
  }

  function writeGateState(dir: string, planFile: string, machineFile: string): string {
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: planFile,
      current_wave: 1,
      executing_tasks: [],
      tasks: [{
        id: "T1", description: "implement machine", agent: "code-implementer-agent",
        wave: 1, status: "implemented", depends_on: [],
        new_tests_required: true, test_result: { verdict: "trusted-pass" }, new_tests_written: true,
        review_status: "passed", critical_findings: [], advisory_findings: [],
        file_list: [machineFile],
      }],
      wave_gates: { "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false } },
    }));
    return statePath;
  }

  it("BLOCKS the gate when the bound machine file was never created", async () => {
    const dir = tempDir();
    const planFile = join(dir, "plan.md");
    const machineFile = join(dir, "src", "order-machine.ts"); // never written
    writeFileSync(planFile, `# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** ${machineFile}\n`);
    const statePath = writeGateState(dir, planFile, machineFile);
    const gate = loadGateWithState(statePath);
    const result = await gate("", ["--wave", "1"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("LC-1");
      expect(result.message).toContain("not created");
    }
  });

  it("passes the gate when the machine file exists on disk", async () => {
    const dir = tempDir();
    const planFile = join(dir, "plan.md");
    const machineFile = join(dir, "order-machine.ts");
    writeFileSync(planFile, `# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** ${machineFile}\n`);
    writeFileSync(machineFile, "export const machine = 1;\n");
    const statePath = writeGateState(dir, planFile, machineFile);
    const gate = loadGateWithState(statePath);
    const result = await gate("", ["--wave", "1"]);
    expect(result.kind).toBe("passthrough");
  });

  it("falls back to the architecture phase artifact when plan_file is null", async () => {
    const dir = tempDir();
    const planFile = join(dir, "plan.md");
    const machineFile = join(dir, "order-machine.ts"); // never written
    writeFileSync(planFile, `# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** ${machineFile}\n`);
    const statePath = writeGateState(dir, planFile, machineFile);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.plan_file = null;
    state.phase_artifacts = { architecture: planFile };
    writeFileSync(statePath, JSON.stringify(state));
    const gate = loadGateWithState(statePath);
    const result = await gate("", ["--wave", "1"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("LC-1");
  });
});

describe("loadPlanModelsSource", () => {
  it("returns none for null/empty plan paths", () => {
    expect(loadPlanModelsSource(null).kind).toBe("none");
    expect(loadPlanModelsSource(undefined).kind).toBe("none");
    expect(loadPlanModelsSource("  ").kind).toBe("none");
  });

  it("returns unreadable for a missing file", () => {
    const source = loadPlanModelsSource("/nonexistent/plan.md");
    expect(source.kind).toBe("unreadable");
  });

  it("returns loaded models for a real plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-gate-"));
    try {
      const planFile = join(dir, "plan.md");
      writeFileSync(planFile, "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** m.ts\n");
      const source = loadPlanModelsSource(planFile);
      expect(source.kind).toBe("loaded");
      if (source.kind === "loaded") expect(source.models.lifecycles).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
