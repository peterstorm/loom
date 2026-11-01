/**
 * The `helper orchestration reopen-task` shell: route traits, the quiescence
 * protocol, and refusals that leave the State File untouched. The decision
 * itself is pinned in tests/core/task-reopening.test.ts and the end-to-end CLI
 * flow (abandoned run → reopen → status owes the dispatch → brief renders it)
 * in tests/handlers/helpers/orchestration.test.ts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReopenTaskOperation } from "../../../src/handlers/helpers/reopen-task";
import { ORCHESTRATION_OPERATIONS } from "../../../src/handlers/helpers/orchestration-operations";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../../src/handler-routes";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { appearsUnderTheLock } from "../../fixtures/subagent-activity";

const cleanup: string[] = [];
let previousStatePath: string | undefined;
afterEach(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Wave 1 current with implemented T1 and T2 and no Wave Gate registered. */
function installState(): string {
  previousStatePath = process.env.LOOM_STATE_PATH;
  const root = canonicalTempDir("loom-reopen-task-");
  cleanup.push(root);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    executing_tasks: [],
    wave_gates: { "1": { impl_complete: true, tests_passed: null, reviews_complete: false, blocked: false } },
    tasks: [
      { id: "T1", description: "d", agent: "code-implementer-agent", wave: 1, status: "implemented", depends_on: [] },
      { id: "T2", description: "d", agent: "code-implementer-agent", wave: 1, status: "implemented", depends_on: [] },
    ],
  }));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

const ARGS = ["--wave", "1", "--task", "T1", "--reason", "fix the advisory"] as const;
const quiet = () => false;

describe("reopen-task route traits", () => {
  it("takes only flags and requires the Pi runtime handshake, like every mutating operation", () => {
    expect(ORCHESTRATION_OPERATIONS["reopen-task"]).toEqual({ input: "flags", runtimeSkew: "handshake-required" });
    expect(routeConsumesStdin("helper", "orchestration", ["reopen-task", ...ARGS])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["reopen-task", ...ARGS])).toBe(true);
  });
});

describe("reopen-task shell", () => {
  it("commits the reopening and leaves the other Task implemented", async () => {
    const statePath = installState();
    expect(await createReopenTaskOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    const graph = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { id: string; status: string; revalidation_required?: boolean }[];
      task_reopening_history: readonly unknown[];
    };
    expect(graph.tasks.map(({ id, status, revalidation_required }) => [id, status, revalidation_required ?? null]))
      .toEqual([["T1", "pending", true], ["T2", "implemented", null]]);
    expect(graph.task_reopening_history).toEqual([{
      schemaVersion: 1, kind: "implemented-tasks-reopened", wave: 1, reopenedTaskIds: ["T1"],
      reason: "fix the advisory", abandonedRunId: null,
    }]);
  });

  it("refuses malformed arguments before reading any graph", async () => {
    const result = await createReopenTaskOperation(quiet)(["--wave", "1", "--reason", "r"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("--task must name at least one implemented Task") });
  });

  it("refuses without writing while a subagent is active", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createReopenTaskOperation(() => true)([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("Task reopening refused while a subagent is active") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("re-checks for a subagent under the lock and refuses without writing when one appeared", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const { probe, observations } = appearsUnderTheLock();
    const result = await createReopenTaskOperation(probe)([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("became active before the task reopening could commit") });
    expect(observations()).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses a precondition without writing", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createReopenTaskOperation(quiet)(["--wave", "2", "--task", "T1", "--reason", "r"]);
    expect(result).toMatchObject({
      kind: "error",
      message: "reopen-task refused without changing state: Wave 2 is not the active Wave 1",
    });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
