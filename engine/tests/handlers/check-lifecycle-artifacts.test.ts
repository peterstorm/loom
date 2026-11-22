import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFilePresence, loadPlanModelsSource } from "../../src/handlers/helpers/wave-gate-observers";
import { checkLifecycleArtifacts, evaluateWaveGate, type PlanModelsSource } from "../../src/core/wave-gate-checks";
import { capturedSpecCheck } from "../../src/core/spec-check";
import type { Task } from "../../src/types";
import type { PlanModels } from "../../src/core/parse-plan-models";
import { acceptedWaveCompletionSuite, COMPLETION_SUITE_WORKSPACE } from "../fixtures/accepted-wave-completion-suite";
import {
  activeWaveGateFixture,
  manifestedGraphFixture,
  protectedGraphFixture,
  satisfiedProof,
  siblingTaskFixture,
} from "../fixtures/task-lifecycle";

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
  const MACHINE = "src/order-machine.ts";
  const ORDER_LIFECYCLE = loaded([{ id: "LC-1", title: "Order", machineFile: MACHINE }]);
  const activeGate = activeWaveGateFixture({ runId: "lifecycle-wiring-run", wave: 1, authorityDigest: "e".repeat(64) });
  /** A Wave every other gate check passes — a reviewed T1 owning the machine
   *  file, a clean spec check and an accepted completion suite on the observed
   *  workspace — under an architecture plan named only as a phase artifact.
   *  Only the Lifecycle check can decide it. */
  const graph = manifestedGraphFixture(protectedGraphFixture({
    current_phase: "execute", phase_artifacts: { architecture: "arch-plan.md" }, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 1, executing_tasks: [],
    tasks: [siblingTaskFixture({
      id: "T1", status: "implemented", file_list: [MACHINE], files_modified: [MACHINE],
      test_result: { verdict: "trusted-pass" }, new_tests_written: true, new_test_evidence: "one property",
      review_status: "passed",
    })],
    wave_gates: { "1": { impl_complete: true, tests_passed: null, reviews_complete: false, blocked: false } },
    spec_check: capturedSpecCheck({ wave: 1, runAt: "", criticalFindings: [] }),
    active_wave_gate: activeGate,
    active_wave_completion_suite: acceptedWaveCompletionSuite(activeGate),
  }));

  /** The gate over `graph`, with the machine file present or absent, and the plan files it read. */
  const decide = (exists: boolean) => {
    const asked: (string | null | undefined)[] = [];
    const decision = evaluateWaveGate(graph, null, {
      loadPlanModels: (planFile) => {
        asked.push(planFile);
        return ORDER_LIFECYCLE;
      },
      filePresence: (path) => ({ ok: true, exists: exists && path === MACHINE }),
      currentWaveWorkspace: COMPLETION_SUITE_WORKSPACE,
    });
    return { decision, asked };
  };

  it("fails on the Lifecycle check alone when the machine the architecture plan declares is absent", () => {
    const { decision, asked } = decide(false);
    expect(asked).toEqual(["arch-plan.md"]);
    const lifecycle = checkLifecycleArtifacts(ORDER_LIFECYCLE, graph.tasks, () => ({ ok: true, exists: false }));
    if (lifecycle.passed) throw new Error("the absent machine must fail the Lifecycle check");
    expect(lifecycle.reason).toContain("LC-1");
    expect(decision.checks.filter((check) => !check.passed)).toEqual([lifecycle]);
    expect(decision.verdict).toEqual({ kind: "fail", reason: lifecycle.reason });
  });

  it("passes once that machine file exists", () => {
    const { decision, asked } = decide(true);
    expect(asked).toEqual(["arch-plan.md"]);
    expect(decision.checks.every((check) => check.passed)).toBe(true);
    expect(decision.verdict).toEqual({ kind: "pass", taskIds: ["T1"], nextWave: null });
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
