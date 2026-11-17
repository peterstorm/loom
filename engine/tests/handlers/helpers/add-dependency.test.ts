/**
 * The `helper orchestration add-dependency` shell (ADR-0081): route traits,
 * the quiescence protocol, and refusals that leave the State File untouched.
 * The decision itself is pinned in tests/core/task-dependency-edit.test.ts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAddDependencyOperation } from "../../../src/handlers/helpers/add-dependency";
import { ORCHESTRATION_OPERATIONS } from "../../../src/handlers/helpers/orchestration-operations";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../../src/handler-routes";
import { newWaveGate } from "../../../src/core/wave-gate-model";
import type { Task, TaskGraph } from "../../../src/types";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { i6PlanTask } from "../../fixtures/i6-plan-task";
import { i6RunnerManifest } from "../../fixtures/i6-runner-manifest";
import { appearsUnderTheLock } from "../../fixtures/subagent-activity";
import { protectedGraphFixture } from "../../fixtures/task-lifecycle";

const cleanup: string[] = [];
let previousStatePath: string | undefined;
afterEach(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Wave 1 current with pending T1 and T2. */
function installState(): string {
  previousStatePath = process.env.LOOM_STATE_PATH;
  const root = canonicalTempDir("loom-add-dependency-");
  cleanup.push(root);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  const graph: TaskGraph = protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    executing_tasks: [],
    verification_manifest: i6RunnerManifest(),
    wave_gates: { "1": newWaveGate() },
    tasks: [i6PlanTask("T1", 1, ["src/t1.ts", "src/t1.test.ts"]), i6PlanTask("T2", 1, ["src/t2.ts", "src/t2.test.ts"])],
  });
  writeFileSync(statePath, JSON.stringify(graph));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

const ARGS = ["--task", "T2", "--on", "T1", "--reason", "T2 benchmarks T1's code"] as const;
const quiet = () => false;
type Written = Readonly<{ tasks: readonly Task[]; wave_plan_edits?: readonly Readonly<Record<string, unknown>>[] }>;
const written = (statePath: string): Written => JSON.parse(readFileSync(statePath, "utf8")) as Written;

describe("add-dependency route traits", () => {
  it("takes only flags, requires the Pi runtime handshake and is parent-only, like every mutating operation", () => {
    expect(ORCHESTRATION_OPERATIONS["add-dependency"]).toEqual({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" });
    expect(routeConsumesStdin("helper", "orchestration", ["add-dependency", ...ARGS])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["add-dependency", ...ARGS])).toBe(true);
  });
});

describe("add-dependency shell", () => {
  it("commits the edge and its audit, and repeating it changes nothing", async () => {
    const statePath = installState();
    expect(await createAddDependencyOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    const graph = written(statePath);
    expect(graph.tasks.find(({ id }) => id === "T2")?.depends_on).toEqual(["T1"]);
    expect(graph.wave_plan_edits).toEqual([{ schemaVersion: 1, kind: "dependency-added", wave: 1, taskId: "T2", dependsOn: ["T1"], reason: "T2 benchmarks T1's code" }]);
    const before = readFileSync(statePath, "utf8");
    expect(await createAddDependencyOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses malformed arguments before reading any graph", async () => {
    const result = await createAddDependencyOperation(quiet)(["--task", "T2", "--reason", "r"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("--on must name at least one Task") });
  });

  it("refuses a cycle without writing", async () => {
    const statePath = installState();
    expect(await createAddDependencyOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    const before = readFileSync(statePath, "utf8");
    const result = await createAddDependencyOperation(quiet)(["--task", "T1", "--on", "T2", "--reason", "loop"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("would close the dependency cycle T1 → T2 → T1") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses without writing while a subagent is active, before or under the lock", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    expect(await createAddDependencyOperation(() => true)([...ARGS])).toMatchObject({
      kind: "error", message: expect.stringContaining("refused while a subagent is active"),
    });
    expect(await createAddDependencyOperation(appearsUnderTheLock().probe)([...ARGS])).toMatchObject({ kind: "error" });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
