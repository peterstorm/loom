import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { TaskGraph, Task, TaskStatus } from "../../../src/types";
import { buildContextOutput, statusIcon } from "../../../src/handlers/session-start/resume-after-clear";

const CLI_PATH = join(__dirname, "../../../src/cli.ts");

function makeTmpDir(): string {
  const dir = join(tmpdir(), `loom-rac-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T1",
    description: "Implement user model",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
    ...overrides,
  };
}

function makeGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: ".claude/specs/test/spec.md",
    plan_file: ".claude/plans/test.md",
    tasks: [makeTask()],
    wave_gates: {},
    ...overrides,
  };
}

describe("resume-after-clear handler", () => {
  let tmpDir: string;
  let stateDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateDir = join(tmpDir, ".claude", "state");
    mkdirSync(stateDir, { recursive: true });
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    statePath = join(stateDir, "active_task_graph.json");
  });

  afterEach(() => {
    try { chmodSync(statePath, 0o644); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeState(graph: TaskGraph) {
    writeFileSync(statePath, JSON.stringify(graph, null, 2));
    chmodSync(statePath, 0o444);
  }

  function runHandler(envOverrides: NodeJS.ProcessEnv = {}): { exitCode: number; stdout: string; stderr: string } {
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: "/test/loom-plugin", ...envOverrides };
    try {
      const stdout = execSync(
        `bun "${CLI_PATH}" session-start resume-after-clear`,
        { cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env },
      );
      return { exitCode: 0, stdout: stdout ?? "", stderr: "" };
    } catch (e: unknown) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { exitCode: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  // --- no-op cases ---

  it("passthrough when no state file exists", () => {
    // no writeState call
    const { exitCode, stdout } = runHandler();
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("passthrough when phase is not execute", () => {
    writeState(makeGraph({ current_phase: "architecture" }));
    const { exitCode, stdout } = runHandler();
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("LOOM RESUME CONTEXT");
  });

  it("passthrough when tasks array is empty", () => {
    writeState(makeGraph({ tasks: [] }));
    const { exitCode, stdout } = runHandler();
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("LOOM RESUME CONTEXT");
  });

  // --- context injection cases ---

  it("outputs context when execute phase with tasks", () => {
    writeState(makeGraph());
    const { exitCode, stdout } = runHandler();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("<!-- LOOM RESUME CONTEXT -->");
    expect(stdout).toContain("<!-- END LOOM RESUME CONTEXT -->");
    expect(stdout).toContain("Active Loom Session");
  });

  it("includes spec and plan paths", () => {
    writeState(makeGraph({
      spec_file: ".claude/specs/auth/spec.md",
      plan_file: ".claude/plans/auth.md",
    }));
    const { stdout } = runHandler();
    expect(stdout).toContain(".claude/specs/auth/spec.md");
    expect(stdout).toContain(".claude/plans/auth.md");
  });

  it("includes github issue number", () => {
    writeState(makeGraph({ github_issue: 42 }));
    const { stdout } = runHandler();
    expect(stdout).toContain("#42");
  });

  it("includes github repo + issue when both present", () => {
    writeState(makeGraph({ github_issue: 7, github_repo: "owner/repo" }));
    const { stdout } = runHandler();
    expect(stdout).toContain("owner/repo#7");
  });

  it("renders task table with correct columns", () => {
    writeState(makeGraph({
      tasks: [
        makeTask({ id: "T1", wave: 1, agent: "frontend-agent", status: "pending", description: "Login page" }),
        makeTask({ id: "T2", wave: 2, agent: "code-implementer-agent", status: "completed", description: "JWT service" }),
      ],
    }));
    const { stdout } = runHandler();
    expect(stdout).toContain("| ID | Wave | Agent | Status | Description |");
    expect(stdout).toContain("| T1 | 1 | frontend-agent | - | Login page |");
    expect(stdout).toContain("| T2 | 2 | code-implementer-agent | done | JWT service |");
  });

  it("sorts tasks by wave then id", () => {
    writeState(makeGraph({
      tasks: [
        makeTask({ id: "T3", wave: 2 }),
        makeTask({ id: "T1", wave: 1 }),
        makeTask({ id: "T2", wave: 1 }),
      ],
    }));
    const { stdout } = runHandler();
    const lines = stdout.split("\n").filter(l => l.startsWith("| T"));
    expect(lines[0]).toContain("T1");
    expect(lines[1]).toContain("T2");
    expect(lines[2]).toContain("T3");
  });

  it("shows current wave and max wave", () => {
    writeState(makeGraph({
      current_wave: 2,
      tasks: [
        makeTask({ id: "T1", wave: 1, status: "completed" }),
        makeTask({ id: "T2", wave: 2 }),
        makeTask({ id: "T3", wave: 3 }),
      ],
    }));
    const { stdout } = runHandler();
    expect(stdout).toContain("**Current Wave:** 2 of 3");
  });

  it("defaults current_wave to 1 when unset", () => {
    writeState(makeGraph({ current_wave: undefined }));
    const { stdout } = runHandler();
    expect(stdout).toContain("**Current Wave:** 1 of 1");
  });

  // --- status icon mapping ---

  it("maps all task statuses to correct icons", () => {
    writeState(makeGraph({
      tasks: [
        makeTask({ id: "T1", status: "pending" }),
        makeTask({ id: "T2", status: "implemented" }),
        makeTask({ id: "T3", status: "completed" }),
        makeTask({ id: "T4", status: "failed" }),
      ],
    }));
    const { stdout } = runHandler();
    const taskLines = stdout.split("\n").filter(l => l.startsWith("| T"));
    expect(taskLines[0]).toContain("| - |");
    expect(taskLines[1]).toContain("| impl |");
    expect(taskLines[2]).toContain("| done |");
    expect(taskLines[3]).toContain("| FAIL |");
  });

  // --- instructions section ---

  it("includes execution instructions with loom dir paths", () => {
    writeState(makeGraph());
    const { stdout } = runHandler();
    expect(stdout).toContain("Phase 5: Execute");
    expect(stdout).toContain("impl-agent-context");
    expect(stdout).toContain("Spawn all pending wave");
  });

  // --- optional fields ---

  it("omits spec line when spec_file is null", () => {
    writeState(makeGraph({ spec_file: null }));
    const { stdout } = runHandler();
    expect(stdout).not.toContain("**Spec:**");
  });

  it("omits plan line when plan_file is null", () => {
    writeState(makeGraph({ plan_file: null }));
    const { stdout } = runHandler();
    expect(stdout).not.toContain("**Plan:**");
  });

  it("omits github line when no issue", () => {
    writeState(makeGraph({ github_issue: undefined }));
    const { stdout } = runHandler();
    expect(stdout).not.toContain("**GitHub Issue:**");
  });
});

describe("statusIcon (pure)", () => {
  it("maps each known status", () => {
    expect(statusIcon("pending")).toBe("-");
    expect(statusIcon("completed")).toBe("done");
    expect(statusIcon("implemented")).toBe("impl");
    expect(statusIcon("failed")).toBe("FAIL");
  });

  it("returns ? sentinel for unknown status (defensive)", () => {
    // Cast bypasses exhaustiveness — simulates a future status that hasn't been wired yet.
    expect(statusIcon("ghost" as TaskStatus)).toBe("?");
  });
});

describe("buildContextOutput (pure)", () => {
  function task(overrides: Partial<Task> = {}): Task {
    return {
      id: "T1", description: "Build thing", agent: "code-implementer-agent",
      wave: 1, status: "pending", depends_on: [], ...overrides,
    };
  }
  function graph(overrides: Partial<TaskGraph> = {}): TaskGraph {
    return {
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: ".claude/specs/x/spec.md", plan_file: ".claude/plans/x.md",
      tasks: [task()], wave_gates: {}, ...overrides,
    };
  }

  it("emits context markers and tasks table", () => {
    const out = buildContextOutput(graph(), "/loom");
    expect(out).toContain("<!-- LOOM RESUME CONTEXT -->");
    expect(out).toContain("<!-- END LOOM RESUME CONTEXT -->");
    expect(out).toContain("# Active Loom Session — Execute Phase");
    expect(out).toContain("| ID | Wave | Agent | Status | Description |");
    expect(out).toContain("| T1 | 1 | code-implementer-agent | - | Build thing |");
  });

  it("sorts tasks by wave then id", () => {
    const out = buildContextOutput(graph({
      tasks: [
        task({ id: "T2", wave: 2 }),
        task({ id: "T1", wave: 1 }),
        task({ id: "T3", wave: 1 }),
      ],
    }), "/loom");
    const t1 = out.indexOf("| T1 |");
    const t3 = out.indexOf("| T3 |");
    const t2 = out.indexOf("| T2 |");
    expect(t1).toBeLessThan(t3);
    expect(t3).toBeLessThan(t2);
  });

  it("renders github issue line with repo when both set", () => {
    const out = buildContextOutput(graph({ github_issue: 42, github_repo: "owner/repo" }), "/loom");
    expect(out).toContain("**GitHub Issue:** owner/repo#42");
  });

  it("renders github issue line without repo when repo absent", () => {
    const out = buildContextOutput(graph({ github_issue: 42 }), "/loom");
    expect(out).toContain("**GitHub Issue:** #42");
  });

  it("interpolates loomDir into instructions", () => {
    const out = buildContextOutput(graph(), "/abs/loom");
    expect(out).toContain("/abs/loom/commands/loom.md");
    expect(out).toContain("/abs/loom/commands/templates/impl-agent-context.md");
  });

  it("computes maxWave from highest task wave", () => {
    const out = buildContextOutput(graph({
      tasks: [task({ id: "T1", wave: 1 }), task({ id: "T2", wave: 3 })],
      current_wave: 2,
    }), "/loom");
    expect(out).toContain("**Current Wave:** 2 of 3");
  });
});
