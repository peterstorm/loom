import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { taskFixture, graphFixture, type TaskFixtureInput } from "../../fixtures/task-lifecycle";
import type { Task } from "../../../src/types";

const CLI_PATH = join(__dirname, "../../../src/cli.ts");

const dirs: string[] = [];
function tempDir(): string {
  const dir = canonicalTempDir("loom-mtp-");
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function task(id: string, over: Partial<TaskFixtureInput> = {}): Task {
  return taskFixture({
    id,
    description: "t",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    depends_on: [],
    ...over,
  });
}

function runHelper(statePath: string, extraArgs: string[] = []): { status: number | null; stderr: string } {
  const result = spawnSync("bun", [CLI_PATH, "helper", "mark-tests-passed", ...extraArgs], {
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
    writeFileSync(statePath, JSON.stringify(graphFixture([task("T1")])));
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
        graphFixture([
          task("T1", {
            test_result: { verdict: "trusted-pass" },
            new_tests_written: true,
            new_test_evidence: "fixture new-test evidence",
          }),
          task("T2", { test_result: { verdict: "untrusted", passed: true, label: "transcript-regex (fallback)", provenance: "unverified" }, new_tests_required: false }),
        ]),
      ),
    );
    const { status, stderr } = runHelper(statePath);
    expect(stderr).toContain("All tasks have test evidence");
    expect(status).toBe(0);
  });

  it("accepts both asymmetric explicit Verification Policy directions", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(
      statePath,
      JSON.stringify(graphFixture([
        task("T1", {
          verification_policy: {
            regression: { kind: "waived", reason: "documentation-only" },
            new_tests: { kind: "required" },
          },
          new_tests_written: true,
          new_test_evidence: "fixture new-test evidence",
        }),
        task("T2", {
          verification_policy: {
            regression: { kind: "required" },
            new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
          },
          test_result: { verdict: "trusted-pass" },
        }),
      ])),
    );

    const { status, stderr } = runHelper(statePath);

    expect(status).toBe(0);
    expect(stderr).toContain("T1: tests=N/A (documentation-only) new=YES");
    expect(stderr).toContain("T2: tests=PASS new=N/A (existing-tests-sufficient)");
  });

  it("a trusted-fail verdict is missing evidence — exit 1, never laundered into a pass", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(
      statePath,
      JSON.stringify(graphFixture([task("T1", {
        test_result: { verdict: "trusted-fail" },
        new_tests_written: true,
        new_test_evidence: "fixture new-test evidence",
      })])),
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
      JSON.stringify(graphFixture([task("T1", { test_result: { verdict: "trusted-pass" }, new_tests_written: false })])),
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

  it("an unreadable or corrupt task graph returns a helper-scoped diagnostic", () => {
    const statePath = join(tempDir(), "active_task_graph.json");
    writeFileSync(statePath, "{not json");

    const { status, stderr } = runHelper(statePath);

    expect(status).toBe(1);
    expect(stderr).toContain(`mark-tests-passed: cannot read task graph ${statePath}`);
    expect(stderr).toContain("invalid JSON");
  });

  it("an invalid --wave value → exit 1 (an unvalidated Number() would report vacuous success for wave NaN)", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(
      statePath,
      JSON.stringify(graphFixture([task("T1", {
        test_result: { verdict: "trusted-pass" },
        new_tests_written: true,
        new_test_evidence: "fixture new-test evidence",
      })])),
    );
    const { status, stderr } = runHelper(statePath, ["--wave", "banana"]);
    expect(status).toBe(1);
    expect(stderr).toContain("Invalid --wave value");
  });

  it("a wave with zero tasks → exit 1, never 'all tasks have test evidence'", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(
      statePath,
      JSON.stringify(graphFixture([task("T1", {
        test_result: { verdict: "trusted-pass" },
        new_tests_written: true,
        new_test_evidence: "fixture new-test evidence",
      })])),
    );
    const { status, stderr } = runHelper(statePath, ["--wave", "7"]);
    expect(status).toBe(1);
    expect(stderr).toContain("Wave 7 has no tasks");
    expect(stderr).not.toContain("All tasks have test evidence");
  });

  it("read-only: the state file is byte-identical after a failing run", () => {
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    const content = JSON.stringify(graphFixture([task("T1")]));
    writeFileSync(statePath, content);
    runHelper(statePath);
    expect(readFileSync(statePath, "utf-8")).toBe(content);
  });
});
