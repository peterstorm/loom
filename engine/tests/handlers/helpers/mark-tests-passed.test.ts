/**
 * Error polarity of the mark-tests-passed helper, spawned for real via the
 * CLI (TASK_GRAPH_PATH freezes at import, so a subprocess with
 * LOOM_STATE_PATH is the only hermetic way to point it at a fixture):
 * - missing evidence → exit 1 (error) naming the failing tasks
 * - all evidence present → exit 0
 * - no task graph at all → exit 1
 * The helper is read-only: the fixture must be byte-identical afterwards.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskGraph, Task } from "../../../src/types";

const CLI_PATH = join(__dirname, "../../../src/cli.ts");

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-mtp-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function graph(tasks: Task[]): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    tasks,
    wave_gates: {},
  };
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    description: "t",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    depends_on: [],
    ...over,
  };
}

function runHelper(statePath: string): { status: number | null; stderr: string } {
  const result = spawnSync("bun", [CLI_PATH, "helper", "mark-tests-passed"], {
    env: { ...process.env, LOOM_STATE_PATH: statePath },
    input: "",
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe("mark-tests-passed — error polarity", () => {
  it("missing test evidence → exit 1 naming the task", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(graph([task("T1")])));
    const { status, stderr } = runHelper(statePath);
    expect(status).toBe(1);
    expect(stderr).toContain("Missing test evidence: T1");
  });

  it("passing evidence + new tests → exit 0", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(
      statePath,
      JSON.stringify(
        graph([
          task("T1", { test_result: { verdict: "trusted-pass" }, new_tests_written: true }),
          task("T2", { test_result: { verdict: "untrusted", passed: true, label: "transcript-regex (fallback)" }, new_tests_required: false }),
        ]),
      ),
    );
    const { status, stderr } = runHelper(statePath);
    expect(stderr).toContain("All tasks have test evidence");
    expect(status).toBe(0);
  });

  it("a trusted-fail verdict is missing evidence — exit 1, never laundered into a pass", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(
      statePath,
      JSON.stringify(graph([task("T1", { test_result: { verdict: "trusted-fail" }, new_tests_written: true })])),
    );
    const { status, stderr } = runHelper(statePath);
    expect(status).toBe(1);
    expect(stderr).toContain("Missing test evidence: T1");
  });

  it("new tests required but not written → exit 1 with the new-test line", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(
      statePath,
      JSON.stringify(graph([task("T1", { test_result: { verdict: "trusted-pass" }, new_tests_written: false })])),
    );
    const { status, stderr } = runHelper(statePath);
    expect(status).toBe(1);
    expect(stderr).toContain("Missing new-test evidence: T1");
  });

  it("no task graph → exit 1", () => {
    const { status, stderr } = runHelper(join(tempDir(), "never-created.json"));
    expect(status).toBe(1);
    expect(stderr).toContain("No active task graph");
  });

  it("read-only: the state file is byte-identical after a failing run", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    const content = JSON.stringify(graph([task("T1")]));
    writeFileSync(statePath, content);
    runHelper(statePath);
    expect(readFileSync(statePath, "utf-8")).toBe(content);
  });
});
