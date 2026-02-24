import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { TaskGraph } from "../../../src/types";

const CLI_PATH = join(__dirname, "../../../src/cli.ts");

function makeTmpDir(): string {
  const dir = join(tmpdir(), `loom-sp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    current_phase: "plan-alignment",
    phase_artifacts: { architecture: "/tmp/plan.md" },
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
    ...overrides,
  };
}

describe("set-phase helper", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Create a fake git repo so TASK_GRAPH_PATH resolves correctly
    const stateDir = join(tmpDir, ".claude", "state");
    mkdirSync(stateDir, { recursive: true });
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });

    statePath = join(stateDir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(minimalGraph(), null, 2));
    chmodSync(statePath, 0o444);
  });

  afterEach(() => {
    try { chmodSync(statePath, 0o644); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runSetPhase(args: string[]): { exitCode: number; stderr: string } {
    try {
      const stderr = execSync(
        `bun "${CLI_PATH}" helper set-phase ${args.join(" ")}`,
        { cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      return { exitCode: 0, stderr: stderr ?? "" };
    } catch (e: unknown) {
      const err = e as { status: number; stderr: string };
      return { exitCode: err.status, stderr: err.stderr ?? "" };
    }
  }

  function readState(): TaskGraph {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  }

  it("valid phase updates current_phase in state", () => {
    const { exitCode } = runSetPhase(["--phase", "architecture"]);
    expect(exitCode).toBe(0);

    const state = readState();
    expect(state.current_phase).toBe("architecture");
    expect(state.updated_at).toBeDefined();
  });

  it("--clear-artifact removes the key from phase_artifacts", () => {
    const before = readState();
    expect(before.phase_artifacts.architecture).toBeDefined();

    const { exitCode } = runSetPhase(["--phase", "architecture", "--clear-artifact", "architecture"]);
    expect(exitCode).toBe(0);

    const state = readState();
    expect(state.current_phase).toBe("architecture");
    expect(state.phase_artifacts.architecture).toBeUndefined();
  });

  it("invalid phase name returns error", () => {
    const { exitCode, stderr } = runSetPhase(["--phase", "nonexistent"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid or missing --phase");
  });

  it("missing --phase returns error", () => {
    const { exitCode, stderr } = runSetPhase([]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid or missing --phase");
  });
});
