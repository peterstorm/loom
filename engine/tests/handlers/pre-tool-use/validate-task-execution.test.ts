import { describe, it, expect } from "vitest";
import type { TaskGraph, Task, WaveGate } from "../../../src/types";

/**
 * Test the pure decision logic from validate-task-execution.
 * We extract the guard logic to avoid needing FS/git mocks.
 */

/** Simulate the wave/dep validation decision (extracted from handler) */
function validateExecution(
  taskId: string,
  state: TaskGraph,
): { kind: "allow" } | { kind: "block"; reason: string } {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return { kind: "allow" }; // Unknown task → passthrough

  const currentWave = state.current_wave ?? 1;

  // Check 1: Wave order
  if (task.wave > currentWave) {
    return { kind: "block", reason: `wave ${task.wave} > current ${currentWave}` };
  }

  // Check 2: Dependencies complete
  for (const dep of task.depends_on) {
    const depTask = state.tasks.find((t) => t.id === dep);
    if (!depTask) {
      return { kind: "block", reason: `dep ${dep} not found in task graph` };
    }
    if (depTask.status !== "completed") {
      return { kind: "block", reason: `dep ${dep} not complete (${depTask.status})` };
    }
  }

  // Check 3: Previous wave review gate (wave > 1)
  if (task.wave === currentWave && currentWave > 1) {
    const prevWave = String(currentWave - 1);
    const gate = state.wave_gates[prevWave];
    if (gate && !gate.reviews_complete) {
      return { kind: "block", reason: `wave ${prevWave} reviews not complete` };
    }
  }

  return { kind: "allow" };
}

/** Helper to build a task */
function mkTask(overrides: Partial<Task> & { id: string; wave: number }): Task {
  return {
    description: `task ${overrides.id}`,
    agent: "code-implementer-agent",
    status: "pending",
    depends_on: [],
    ...overrides,
  };
}

/** Helper to build a gate */
function mkGate(overrides: Partial<WaveGate> = {}): WaveGate {
  return {
    impl_complete: false,
    tests_passed: null,
    reviews_complete: false,
    blocked: false,
    ...overrides,
  };
}

/** Build a minimal TaskGraph */
function mkState(
  tasks: Task[],
  overrides: Partial<TaskGraph> = {},
): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks,
    wave_gates: {},
    ...overrides,
  };
}

describe("validate-task-execution — wave gates", () => {
  it("blocks task in wave 2 when current_wave=1", () => {
    const state = mkState(
      [mkTask({ id: "T1", wave: 2 })],
      { current_wave: 1 },
    );
    const result = validateExecution("T1", state);
    expect(result.kind).toBe("block");
  });

  it("allows task in wave 1 when current_wave=1", () => {
    const state = mkState(
      [mkTask({ id: "T1", wave: 1 })],
      { current_wave: 1 },
    );
    expect(validateExecution("T1", state).kind).toBe("allow");
  });

  it("allows task in wave 1 when current_wave=2 (earlier wave ok)", () => {
    const state = mkState(
      [mkTask({ id: "T1", wave: 1 })],
      { current_wave: 2 },
    );
    expect(validateExecution("T1", state).kind).toBe("allow");
  });

  it("allows unknown task ID (passthrough)", () => {
    const state = mkState([mkTask({ id: "T1", wave: 1 })]);
    expect(validateExecution("T99", state).kind).toBe("allow");
  });
});

describe("validate-task-execution — dependency gates", () => {
  it("blocks when dependency is pending", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1, status: "completed" }),
      mkTask({ id: "T2", wave: 1, status: "pending" }),
      mkTask({ id: "T3", wave: 2, depends_on: ["T1", "T2"] }),
    ], { current_wave: 2 });

    const result = validateExecution("T3", state);
    expect(result.kind).toBe("block");
  });

  it("blocks when dependency is implemented (not completed)", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1, status: "implemented" }),
      mkTask({ id: "T2", wave: 2, depends_on: ["T1"] }),
    ], { current_wave: 2 });

    const result = validateExecution("T2", state);
    expect(result.kind).toBe("block");
  });

  it("allows when all dependencies completed", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1, status: "completed" }),
      mkTask({ id: "T2", wave: 1, status: "completed" }),
      mkTask({ id: "T3", wave: 2, depends_on: ["T1", "T2"] }),
    ], { current_wave: 2, wave_gates: { "1": mkGate({ reviews_complete: true }) } });

    expect(validateExecution("T3", state).kind).toBe("allow");
  });

  it("allows task with no dependencies", () => {
    const state = mkState(
      [mkTask({ id: "T1", wave: 1 })],
      { current_wave: 1 },
    );
    expect(validateExecution("T1", state).kind).toBe("allow");
  });

  it("blocks when dependency references non-existent task", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1, depends_on: ["T99"] }),
    ], { current_wave: 1 });

    const result = validateExecution("T1", state);
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.reason).toContain("not found");
    }
  });
});

describe("validate-task-execution — review gate (previous wave)", () => {
  it("blocks wave 2 task when wave 1 reviews not complete", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1, status: "completed" }),
      mkTask({ id: "T2", wave: 2 }),
    ], {
      current_wave: 2,
      wave_gates: { "1": mkGate({ reviews_complete: false }) },
    });

    const result = validateExecution("T2", state);
    expect(result.kind).toBe("block");
  });

  it("allows wave 2 task when wave 1 reviews complete", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1, status: "completed" }),
      mkTask({ id: "T2", wave: 2 }),
    ], {
      current_wave: 2,
      wave_gates: { "1": mkGate({ reviews_complete: true }) },
    });

    expect(validateExecution("T2", state).kind).toBe("allow");
  });

  it("no review gate check for wave 1 tasks", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1 }),
    ], { current_wave: 1 });

    expect(validateExecution("T1", state).kind).toBe("allow");
  });

  it("blocks when prev gate is blocked", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 2 }),
    ], {
      current_wave: 2,
      wave_gates: { "1": mkGate({ reviews_complete: false, blocked: true }) },
    });

    const result = validateExecution("T1", state);
    expect(result.kind).toBe("block");
  });

  it("no gate entry for previous wave → allows (gate undefined)", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 2 }),
    ], { current_wave: 2, wave_gates: {} });

    expect(validateExecution("T1", state).kind).toBe("allow");
  });
});

describe("validate-task-execution — combined scenarios", () => {
  it("full happy path: 2 waves, deps met, gates passed", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1, status: "completed" }),
      mkTask({ id: "T2", wave: 1, status: "completed" }),
      mkTask({ id: "T3", wave: 2, depends_on: ["T1", "T2"] }),
    ], {
      current_wave: 2,
      wave_gates: { "1": mkGate({ impl_complete: true, reviews_complete: true }) },
    });

    expect(validateExecution("T3", state).kind).toBe("allow");
  });

  it("wave ok + deps ok but review gate fails → block", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1, status: "completed" }),
      mkTask({ id: "T2", wave: 2, depends_on: ["T1"] }),
    ], {
      current_wave: 2,
      wave_gates: { "1": mkGate({ reviews_complete: false }) },
    });

    expect(validateExecution("T2", state).kind).toBe("block");
  });

  it("default current_wave is 1 when undefined", () => {
    const state = mkState([
      mkTask({ id: "T1", wave: 1 }),
      mkTask({ id: "T2", wave: 2 }),
    ]); // current_wave not set → defaults to 1

    expect(validateExecution("T1", state).kind).toBe("allow");
    expect(validateExecution("T2", state).kind).toBe("block");
  });
});
