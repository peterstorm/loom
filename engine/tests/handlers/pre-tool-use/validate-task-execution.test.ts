import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  classifyTaskExecutionSpawn,
  parseImplementationTaskBindings,
  registerTaskExecutionBaseline,
  taskExecutionDecision,
  taskExecutionOwnershipError,
  taskExecutionRegistrationError,
} from "../../../src/core/validate-task-execution";
import { validateTaskExecutionBatch } from "../../../src/handlers/task-execution";
import type { TaskGraph, Task, WaveGate } from "../../../src/types";

/** Exercise the production pure decision while preserving concise assertions. */
function validateExecution(
  taskId: string,
  state: TaskGraph,
): { kind: "allow" } | { kind: "block"; reason: string } {
  const decision = taskExecutionDecision(state, taskId);
  return decision.kind === "block"
    ? { kind: "block", reason: decision.message }
    : { kind: "allow" };
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

describe("validate-task-execution — spawn lifecycle parsing", () => {
  it("makes only implementation agents eligible for task execution state", () => {
    expect(classifyTaskExecutionSpawn({
      agentType: "code-implementer-agent",
      prompt: "Task ID: T1",
      description: "",
    })).toEqual({ kind: "implementation", prompt: "Task ID: T1", description: "" });
    expect(classifyTaskExecutionSpawn({
      agentType: "code-reviewer",
      prompt: "Task: T1",
      description: "",
    })).toEqual({ kind: "non-implementation" });
    expect(classifyTaskExecutionSpawn({
      agentType: "review-verifier-agent",
      prompt: "Task: T1",
      description: "",
    })).toEqual({ kind: "non-implementation" });
  });

  it("restricts the standalone marker to review and verifier agents", () => {
    expect(classifyTaskExecutionSpawn({
      agentType: "loom:code-reviewer",
      prompt: "LOOM_REVIEW_CONTEXT: standalone\nReview the frozen scope",
      description: "",
    })).toEqual({ kind: "standalone" });
    expect(classifyTaskExecutionSpawn({
      agentType: "review-verifier-agent",
      prompt: "LOOM_REVIEW_CONTEXT: standalone\nJudge the manifest",
      description: "",
    })).toEqual({ kind: "standalone" });
    expect(classifyTaskExecutionSpawn({
      agentType: "code-implementer-agent",
      prompt: "LOOM_REVIEW_CONTEXT: standalone\nTask ID: T1",
      description: "",
    })).toEqual({
      kind: "implementation",
      prompt: "LOOM_REVIEW_CONTEXT: standalone\nTask ID: T1",
      description: "",
    });
  });

  it("requires every implementation spawn to bind one existing task exactly once", () => {
    const state = mkState([mkTask({ id: "T1", wave: 1 }), mkTask({ id: "T2", wave: 1 })]);
    const implementation = (prompt: string) => ({ kind: "implementation" as const, prompt, description: "" });

    expect(parseImplementationTaskBindings(state, [implementation("Task ID: T1"), implementation("Task ID: T2")]))
      .toEqual({ ok: true, taskIds: ["T1", "T2"] });
    expect(parseImplementationTaskBindings(state, [implementation("implement this")]))
      .toEqual({ ok: false, error: expect.stringContaining("no extractable Task ID") });
    expect(parseImplementationTaskBindings(state, [implementation("Task ID: T99")]))
      .toEqual({ ok: false, error: expect.stringContaining("unknown task T99") });
    expect(parseImplementationTaskBindings(state, [implementation("Task ID: T1"), implementation("Task ID: T1")]))
      .toEqual({ ok: false, error: expect.stringContaining("more than once") });
  });
});

describe("validate-task-execution — lazy task graph authority", () => {
  it("honors LOOM_STATE_PATH set after the module was imported", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-lazy-task-graph-"));
    const statePath = join(root, "active_task_graph.json");
    const previous = process.env.LOOM_STATE_PATH;
    writeFileSync(statePath, JSON.stringify(mkState([mkTask({ id: "T1", wave: 1 })])));
    process.env.LOOM_STATE_PATH = statePath;
    try {
      const result = await validateTaskExecutionBatch([{
        kind: "implementation",
        prompt: "implement this without a binding",
        description: "",
      }]);
      expect(result).toMatchObject({ kind: "block", message: expect.stringContaining("no extractable Task ID") });
    } finally {
      if (previous === undefined) delete process.env.LOOM_STATE_PATH;
      else process.env.LOOM_STATE_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("validate-task-execution — repository proof boundary", () => {
  it.each(["not-a-repository", "unborn-repository"])(
    "blocks an active implementation spawn in %s",
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), "loom-task-execution-git-"));
      const statePath = join(root, "active_task_graph.json");
      const previousState = process.env.LOOM_STATE_PATH;
      const previousProject = process.env.CLAUDE_PROJECT_DIR;
      writeFileSync(statePath, JSON.stringify(mkState([mkTask({ id: "T1", wave: 1 })])));
      if (scenario === "unborn-repository") {
        const { execFileSync } = await import("node:child_process");
        execFileSync("git", ["init", "--quiet"], { cwd: root });
      }
      process.env.LOOM_STATE_PATH = statePath;
      process.env.CLAUDE_PROJECT_DIR = root;
      try {
        const result = await validateTaskExecutionBatch([{
          kind: "implementation",
          prompt: "Task ID: T1",
          description: "",
        }]);
        expect(result).toMatchObject({
          kind: "block",
          message: expect.stringContaining("Cannot capture implementation baseline"),
        });
      } finally {
        if (previousState === undefined) delete process.env.LOOM_STATE_PATH;
        else process.env.LOOM_STATE_PATH = previousState;
        if (previousProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = previousProject;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("validate-task-execution — exclusive ownership", () => {
  const scoped = (id: string, path: string) => mkTask({ id, wave: 1, file_list: [path] });

  it("rejects an already-executing task", () => {
    const state = mkState([scoped("T1", "src/a.ts")], { executing_tasks: ["T1"] });
    expect(taskExecutionOwnershipError(state, ["T1"], "parallel")).toContain("already executing");
  });

  it("rejects parallel siblings with overlapping declared paths", () => {
    const state = mkState([scoped("T1", "src/a.ts"), scoped("T2", "src/a.ts")]);
    expect(taskExecutionOwnershipError(state, ["T1", "T2"], "parallel"))
      .toContain("both declare src/a.ts");
  });

  it("rejects overlap with an active same-wave owner", () => {
    const state = mkState(
      [scoped("T1", "src/a.ts"), scoped("T2", "src/a.ts")],
      { executing_tasks: ["T1"] },
    );
    expect(taskExecutionOwnershipError(state, ["T2"], "parallel"))
      .toContain("T1 owns declared path src/a.ts");
  });

  // A reservation commits during PreToolUse, before the sibling PreToolUse
  // gates vote. On Claude Code those gates are separate processes with no
  // shared rollback, so a spawn one of them denies strands `executing_tasks`
  // with no SubagentStop ever coming to clear it.
  describe("reservations abandoned by a vetoed spawn", () => {
    it("lets a proven-stale reservation re-claim its own task", () => {
      const state = mkState([scoped("T1", "src/a.ts")], { executing_tasks: ["T1"] });

      expect(taskExecutionOwnershipError(state, ["T1"], "parallel")).toContain("already executing");
      expect(taskExecutionOwnershipError(state, ["T1"], "parallel", new Set(["T1"]))).toBeNull();
    });

    it("releases the declared paths a stale reservation was holding hostage", () => {
      const state = mkState(
        [scoped("T1", "src/a.ts"), scoped("T2", "src/a.ts")],
        { executing_tasks: ["T1"] },
      );

      expect(taskExecutionOwnershipError(state, ["T2"], "parallel"))
        .toContain("T1 owns declared path src/a.ts");
      expect(taskExecutionOwnershipError(state, ["T2"], "parallel", new Set(["T1"]))).toBeNull();
    });

    it("releases only the proven reservations, never the rest of the roster", () => {
      const state = mkState(
        [scoped("T1", "src/a.ts"), scoped("T2", "src/b.ts"), scoped("T3", "src/b.ts")],
        { executing_tasks: ["T1", "T2"] },
      );

      // T1 proven stale; T2 is not, so it still owns src/b.ts.
      expect(taskExecutionOwnershipError(state, ["T3"], "parallel", new Set(["T1"])))
        .toContain("T2 owns declared path src/b.ts");
      expect(taskExecutionOwnershipError(state, ["T1"], "parallel", new Set(["T1"]))).toBeNull();
    });

    it("keeps preflight and the locked re-check on the same stale set", () => {
      const input = [{ kind: "implementation" as const, prompt: "Task ID: T1", description: "" }];
      const baseline = [{ artifact: "src/a.ts", snapshot: { kind: "missing" as const } }];
      const baselines = new Map([[
        "T1",
        { proof: baseline, attempt: baseline, repositoryAttempt: [] },
      ]]);
      const state = mkState([scoped("T1", "src/a.ts")], {
        current_wave: 1,
        executing_tasks: ["T1"],
      });

      // Without the stale set the locked re-check would reject a spawn that
      // preflight had already accepted.
      expect(taskExecutionRegistrationError(state, input, ["T1"], "parallel", baselines))
        .toContain("already executing");
      expect(taskExecutionRegistrationError(
        state, input, ["T1"], "parallel", baselines, new Set(["T1"]),
      )).toBeNull();
    });
  });

  it("rejects sequential overlap until each child can receive a fresh baseline", () => {
    const state = mkState([scoped("T1", "src/a.ts"), scoped("T2", "src/a.ts")]);
    expect(taskExecutionOwnershipError(state, ["T1", "T2"], "sequential"))
      .toContain("separate subagent calls");
  });

  it("allows a sequential chain with disjoint proof scopes", () => {
    const state = mkState([scoped("T1", "src/a.ts"), scoped("T2", "src/b.ts")]);
    expect(taskExecutionOwnershipError(state, ["T1", "T2"], "sequential")).toBeNull();
  });

  it("re-evaluating against a newer locked snapshot catches stale preflight ownership", () => {
    const tasks = [scoped("T1", "src/a.ts"), scoped("T2", "src/a.ts")];
    expect(taskExecutionOwnershipError(mkState(tasks), ["T2"], "parallel")).toBeNull();
    expect(taskExecutionOwnershipError(
      mkState(tasks, { executing_tasks: ["T1"] }),
      ["T2"],
      "parallel",
    )).toContain("T1 owns declared path");
  });

  it("revalidates status, wave authority, and artifact scope under the lock", () => {
    const input = [{ kind: "implementation" as const, prompt: "Task ID: T1", description: "" }];
    const baseline = [{ artifact: "src/a.ts", snapshot: { kind: "missing" as const } }];
    const baselines = new Map([[
      "T1",
      { proof: baseline, attempt: baseline, repositoryAttempt: [] },
    ]]);
    const pending = scoped("T1", "src/a.ts");

    expect(taskExecutionRegistrationError(
      mkState([pending], { current_wave: 1 }), input, ["T1"], "parallel", baselines,
    )).toBeNull();
    expect(taskExecutionRegistrationError(
      mkState([{ ...pending, status: "completed" }], { current_wave: 1 }),
      input, ["T1"], "parallel", baselines,
    )).toContain("already completed");
    expect(taskExecutionRegistrationError(
      mkState([{ ...pending, wave: 2 }], { current_wave: 1 }),
      input, ["T1"], "parallel", baselines,
    )).toContain("current wave is 1");
    expect(taskExecutionRegistrationError(
      mkState([{ ...pending, file_list: ["src/changed.ts"] }], { current_wave: 1 }),
      input, ["T1"], "parallel", baselines,
    )).toContain("artifact scope changed");
  });
});

describe("validate-task-execution — retry baselines", () => {
  it("preserves the first proof boundary and refreshes the attempt boundary on retry", () => {
    const originalBaseline = [{
      artifact: "src/a.ts",
      snapshot: { kind: "sha256" as const, digest: "a".repeat(64) },
    }];
    const retryBaseline = [{
      artifact: "src/a.ts",
      snapshot: { kind: "sha256" as const, digest: "b".repeat(64) },
    }];
    const existing = mkTask({
      id: "T1", wave: 1, start_sha: "1".repeat(40), artifact_baseline: originalBaseline,
    });

    const retryAttemptBaseline = [
      ...retryBaseline,
      { artifact: "tests/a.test.ts", snapshot: { kind: "missing" as const } },
    ];
    const repositoryAttemptBaseline = [{
      artifact: "dirty-before-spawn.ts",
      snapshot: { kind: "sha256" as const, digest: "c".repeat(64) },
    }];
    const registered = registerTaskExecutionBaseline(
      existing,
      "2".repeat(40),
      retryBaseline,
      retryAttemptBaseline,
      repositoryAttemptBaseline,
    );

    expect(registered.start_sha).toBe("1".repeat(40));
    expect(registered.artifact_baseline).toBe(originalBaseline);
    expect(registered.attempt_artifact_baseline).toBe(retryAttemptBaseline);
    expect(registered.attempt_repository_baseline).toBe(repositoryAttemptBaseline);
  });

  it("fills a missing execution boundary on first spawn", () => {
    const captured = [{ artifact: "src/a.ts", snapshot: { kind: "missing" as const } }];
    const registered = registerTaskExecutionBaseline(
      mkTask({ id: "T1", wave: 1 }),
      "1".repeat(40),
      captured,
    );

    expect(registered.start_sha).toBe("1".repeat(40));
    expect(registered.artifact_baseline).toBe(captured);
    expect(registered.attempt_artifact_baseline).toBe(captured);
    expect(registered.attempt_repository_baseline).toEqual([]);
  });
});

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

  it("blocks a completed task from acquiring a new implementation reservation", () => {
    const state = mkState([mkTask({ id: "T1", wave: 1, status: "completed" })]);
    expect(validateExecution("T1", state)).toMatchObject({
      kind: "block",
      reason: expect.stringContaining("already completed"),
    });
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
