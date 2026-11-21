import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFilePresence, loadPlanModelsSource } from "../../src/handlers/helpers/wave-gate-observers";
import { checkLifecycleArtifacts, evaluateWaveGate, type PlanModelsSource } from "../../src/core/wave-gate-checks";
import { parseArtifactDigest, parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import type { Task, TaskGraph } from "../../src/types";
import type { PlanModels } from "../../src/core/parse-plan-models";
import { value } from "../fixtures/parse-result";
import { satisfiedProof } from "../fixtures/task-lifecycle";
import { preI6DefaultVerificationManifest } from "../../src/core/verification-manifest";

function waveTask(fileList: string[]): Task {
  return {
    id: "T1",
    description: "impl",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    proof: satisfiedProof([]),
    depends_on: [],
    file_list: fileList,
  };
}

function loaded(lifecycles: PlanModels["lifecycles"]): PlanModelsSource {
  return { kind: "loaded", models: { lifecycles, pipeline: null, invariants: [], contracts: [], strays: [] } };
}

describe("checkLifecycleArtifacts (wave-gate evidence check)", () => {
  it("fails closed when no plan authority can prove whether Lifecycle Machines were declared", () => {
    const check = checkLifecycleArtifacts(
      { kind: "none" },
      [waveTask(["a.ts"])],
      () => ({ ok: true, exists: false }),
    );
    expect(check.passed).toBe(false);
    if (!check.passed) {
      expect(check.reason).toContain("plan file is missing");
      expect(check.reason).toContain("fail-closed");
    }
  });

  it("fails closed when the plan is named but unreadable — and names the cause", () => {
    const check = checkLifecycleArtifacts(
      { kind: "unreadable", path: "/gone/plan.md", error: "ENOENT: no such file or directory" },
      [],
      () => ({ ok: true, exists: true }),
    );
    expect(check.passed).toBe(false);
    if (!check.passed) {
      expect(check.reason).toContain("unreadable");
      expect(check.reason).toContain("ENOENT"); // ENOENT vs EACCES must be distinguishable
    }
  });

  it("passes when no lifecycle is bound to this wave", () => {
    const source = loaded([{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }]);
    const check = checkLifecycleArtifacts(
      source,
      [waveTask(["src/unrelated.ts"])],
      () => ({ ok: true, exists: false }),
    );
    expect(check.passed).toBe(true);
    if (check.passed) expect(check.summary).toContain("none bound");
  });

  it("FAILS when a bound machine file was not created by the wave", () => {
    const source = loaded([{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }]);
    const check = checkLifecycleArtifacts(
      source,
      [waveTask(["src/order-machine.ts"])],
      () => ({ ok: true, exists: false }),
    );
    expect(check.passed).toBe(false);
    if (!check.passed) {
      expect(check.reason).toContain("LC-1");
      expect(check.reason).toContain("src/order-machine.ts");
    }
  });

  it("passes when the bound machine file exists on disk", () => {
    const source = loaded([{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }]);
    const check = checkLifecycleArtifacts(
      source,
      [waveTask(["src/order-machine.ts"])],
      (p) => ({ ok: true, exists: p === "src/order-machine.ts" }),
    );
    expect(check.passed).toBe(true);
    if (check.passed) expect(check.summary).toContain("LC-1");
  });

  it("checks only lifecycles bound to THIS wave's tasks", () => {
    const source = loaded([
      { id: "LC-1", title: "A", machineFile: "src/a-machine.ts" },
      { id: "LC-2", title: "B", machineFile: "src/b-machine.ts" },
    ]);
    // wave contains only LC-1's file; LC-2's file missing on disk is fine here
    const check = checkLifecycleArtifacts(
      source,
      [waveTask(["src/a-machine.ts"])],
      (p) => ({ ok: true, exists: p === "src/a-machine.ts" }),
    );
    expect(check.passed).toBe(true);
  });

  it("ignores lifecycles with no machine file (blocked earlier at populate)", () => {
    const source = loaded([{ id: "LC-1", title: "A", machineFile: null }]);
    const check = checkLifecycleArtifacts(
      source,
      [waveTask(["x.ts"])],
      () => ({ ok: true, exists: false }),
    );
    expect(check.passed).toBe(true);
  });

  it("counts a suffix-matched task file_list variant as the artifact (binding-validation parity)", () => {
    // Plan declares the repo-relative path; the task's file_list carries the
    // deeper form pathsMatch accepts — the artifact exists ONLY at the
    // task's spelling. The check must pass, not demand the declared spelling.
    const source = loaded([{ id: "LC-1", title: "X", machineFile: "src/machines/x.machine.json" }]);
    const check = checkLifecycleArtifacts(
      source,
      [waveTask(["engine/src/machines/x.machine.json"])],
      (p) => ({ ok: true, exists: p === "engine/src/machines/x.machine.json" }),
    );
    expect(check.passed).toBe(true);
  });

  it("fails closed with the concrete cause when artifact presence is unavailable", () => {
    const source = loaded([{ id: "LC-1", title: "X", machineFile: "src/x.machine.ts" }]);
    const check = checkLifecycleArtifacts(
      source,
      [waveTask(["src/x.machine.ts"])],
      () => ({ ok: false, error: "EACCES: permission denied" }),
    );
    expect(check.passed).toBe(false);
    if (!check.passed) {
      expect(check.reason).toContain("presence is unavailable");
      expect(check.reason).toContain("EACCES");
    }
  });

  it("still fails when neither the declared path nor any matched variant exists", () => {
    const source = loaded([{ id: "LC-1", title: "X", machineFile: "src/machines/x.machine.json" }]);
    const check = checkLifecycleArtifacts(
      source,
      [waveTask(["engine/src/machines/x.machine.json"])],
      () => ({ ok: true, exists: false }),
    );
    expect(check.passed).toBe(false);
    if (!check.passed) expect(check.reason).toContain("LC-1");
  });
});

describe("Wave Gate lifecycle wiring (check 7 is actually in the gate)", () => {
  it("reads the architecture phase artifact as the plan when plan_file is null", () => {
    const graph: TaskGraph = {
      current_phase: "execute",
      verification_manifest: preI6DefaultVerificationManifest(),
      phase_artifacts: { architecture: "arch-plan.md" },
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 1,
      tasks: [waveTask(["src/order-machine.ts"])],
      wave_gates: {},
      active_wave_gate: {
        schemaVersion: 1,
        kind: "active-wave-gate",
        runId: value(parseOrchestrationRunId("lifecycle-wiring-run")),
        wave: 1,
        authorityDigest: value(parseArtifactDigest("e".repeat(64))),
        revision: 0,
        terminalOutcome: null,
      },
    };
    const asked: (string | null | undefined)[] = [];
    const decision = evaluateWaveGate(graph, null, {
      loadPlanModels: (planFile) => {
        asked.push(planFile);
        return loaded([{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }]);
      },
      filePresence: () => ({ ok: true, exists: false }),
    });
    expect(asked).toEqual(["arch-plan.md"]);
    expect(decision.verdict.kind).toBe("fail");
  });

  it("observes a dangling symlink as an absent Lifecycle Machine artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-gate-"));
    try {
      const machine = join(dir, "order-machine.ts");
      symlinkSync(join(dir, "missing-machine-target.ts"), machine);
      expect(inspectFilePresence(machine)).toEqual({ ok: true, exists: false });
      const check = checkLifecycleArtifacts(
        loaded([{ id: "LC-1", title: "Order", machineFile: machine }]),
        [waveTask([machine])],
        inspectFilePresence,
      );
      expect(check.passed).toBe(false);
      if (!check.passed) expect(check.reason).toContain("LC-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadPlanModelsSource", () => {
  it("returns none for null/empty plan paths", () => {
    expect(loadPlanModelsSource(null).kind).toBe("none");
    expect(loadPlanModelsSource(undefined).kind).toBe("none");
    expect(loadPlanModelsSource("  ").kind).toBe("none");
  });

  it("returns unreadable for a missing file, carrying the fs error message", () => {
    const source = loadPlanModelsSource("/nonexistent/plan.md");
    expect(source.kind).toBe("unreadable");
    if (source.kind === "unreadable") {
      expect(source.path).toBe("/nonexistent/plan.md");
      expect(source.error).toContain("ENOENT");
    }
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
