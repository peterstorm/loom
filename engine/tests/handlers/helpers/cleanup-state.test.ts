import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { TaskGraph } from "../../../src/types";

const CLI_PATH = join(__dirname, "../../../src/cli.ts");

function makeTmpDir(): string {
  const dir = join(tmpdir(), `loom-cs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalGraph(): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
  };
}

describe("cleanup-state helper", () => {
  let tmpDir: string;
  let stateDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateDir = join(tmpDir, ".claude", "state");
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

  function runCleanup(): { exitCode: number; stderr: string } {
    try {
      const stderr = execSync(
        `bun "${CLI_PATH}" helper cleanup-state`,
        { cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      return { exitCode: 0, stderr: stderr ?? "" };
    } catch (e: unknown) {
      const err = e as { status: number; stderr: string };
      return { exitCode: err.status, stderr: err.stderr ?? "" };
    }
  }

  it("removes the state file", () => {
    expect(existsSync(statePath)).toBe(true);

    const { exitCode } = runCleanup();
    expect(exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("works on chmod 444 file", () => {
    const mode = statSync(statePath).mode & 0o777;
    expect(mode).toBe(0o444);

    const { exitCode } = runCleanup();
    expect(exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("succeeds and file is gone after run", () => {
    const { exitCode } = runCleanup();
    expect(exitCode).toBe(0);
    // Directory still exists, only state file removed
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(statePath)).toBe(false);
  });

  it("returns error when no state file exists", () => {
    const emptyDir = join(tmpdir(), `loom-cs-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    execSync("git init", { cwd: emptyDir, stdio: "ignore" });

    try {
      execSync(
        `bun "${CLI_PATH}" helper cleanup-state`,
        { cwd: emptyDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      const err = e as { status: number; stderr: string };
      expect(err.status).not.toBe(0);
      expect(err.stderr).toContain("No active task graph");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("is idempotent — second call returns error", () => {
    const first = runCleanup();
    expect(first.exitCode).toBe(0);

    const second = runCleanup();
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain("No active task graph");
  });
});
