import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
