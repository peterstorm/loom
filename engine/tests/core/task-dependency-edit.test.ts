/**
 * `add-dependency` (ADR-0081): same-Wave ordering as audited, enforced data.
 * Every committed graph is round-tripped through the State File parser, so an
 * edit that would load back corrupt fails here.
 */
import { describe, expect, it } from "vitest";
import {
  addDependency,
  parseAddDependencyArgs,
  type AddDependencyRefusal,
  type AddDependencyRequest,
} from "../../src/core/task-dependency-edit";
import { dispatchHoldMessage, dispatchHoldOf } from "../../src/core/dispatch-holds";
import { newWaveGate } from "../../src/core/wave-gate-model";
import { parseTaskGraph } from "../../src/state-file-wire";
import { validateFull } from "../../src/handlers/helpers/validate-task-graph";
import type { Task, TaskGraph } from "../../src/types";
import { i6RunnerManifest } from "../fixtures/i6-runner-manifest";
import { i6PlanTask } from "../fixtures/i6-plan-task";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  protectedGraphFixture,
  satisfiedProof,
} from "../fixtures/task-lifecycle";

const task = i6PlanTask;

/** A Task that has settled its implementation: `implemented`, or `completed` with a passed review. */
const implemented = (id: string, wave: number, files: readonly string[], status: "implemented" | "completed" = "implemented"): Task =>
  task(id, wave, files, {
    status, proof: satisfiedProof([...files], "owed-if-new-tests"), ...(status === "completed" ? { review_status: "passed" as const } : {}),
  });

/** Wave 2 current: T1 of completed Wave 1; T25, T28, T12 pending in Wave 2. */
function graph(tasks?: readonly Task[], overrides: Partial<TaskGraph> = {}): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 2,
    executing_tasks: [],
    verification_manifest: i6RunnerManifest(),
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    tasks: tasks ?? [
      implemented("T1", 1, ["src/t1.ts", "src/t1.test.ts"], "completed"),
      task("T25", 2, ["src/t25.ts", "src/t25.test.ts"]),
      task("T28", 2, ["src/t28.ts", "src/t28.test.ts"]),
      task("T12", 2, ["src/t12.ts", "src/t12.test.ts"]),
    ],
    wave_gates: { "1": newWaveGate(), "2": newWaveGate() },
    ...overrides,
  });
}

const request = (taskId: string, on: readonly string[], reason = "T12 benchmarks the served code"): AddDependencyRequest => {
  const parsed = parseAddDependencyArgs(["--task", taskId, ...on.flatMap((id) => ["--on", id]), "--reason", reason]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

/** The committed graph, proven to load back through the State File parser. */
const committed = (state: TaskGraph, req: AddDependencyRequest): TaskGraph => {
  const result = addDependency(state, req);
  if (!result.ok || result.value.kind !== "added") throw new Error(`expected an added dependency, got ${JSON.stringify(result)}`);
  const reloaded = parseTaskGraph(JSON.parse(JSON.stringify(result.value.graph)));
  if (!reloaded.ok) throw new Error(`the edited graph does not load back: ${reloaded.error}`);
  return result.value.graph;
};
const refusal = (state: TaskGraph, req: AddDependencyRequest): AddDependencyRefusal => {
  const result = addDependency(state, req);
  if (result.ok) throw new Error(`expected a refusal, got ${result.value.kind}`);
  return result.error;
};
const byId = (state: TaskGraph, id: string): Task => state.tasks.find((candidate) => candidate.id === id)!;

describe("parseAddDependencyArgs", () => {
  it("accepts a Task, its dependencies and a trimmed reason, in any order", () => {
    expect(parseAddDependencyArgs(["--on", "T25", "--reason", " order ", "--task", "T12", "--on", "T28"])).toEqual({
      ok: true, value: { taskId: "T12", dependsOn: ["T25", "T28"], reason: "order" },
    });
  });

  it.each([
    [["--task", "T12", "--reason", "r"], "--on must name at least one Task"],
    [["--on", "T25", "--reason", "r"], "--task must name the Task"],
    [["--task", "T12", "--on", "T12", "--reason", "r"], "cannot depend on itself"],
    [["--task", "T12", "--on", "T25", "--on", "T25", "--reason", "r"], "--on T25 is given twice"],
    [["--task", "T12", "--on", "T25"], "--reason must say why"],
    [["--task", "T12", "--on", "nope", "--reason", "r"], "--on"],
    [["--task", "T12", "--hold", "T25", "--reason", "r"], "unknown argument '--hold'"],
  ])("refuses %j", (args, problem) => {
    expect(parseAddDependencyArgs(args)).toMatchObject({ ok: false, error: expect.stringContaining(problem) });
  });
});

describe("addDependency", () => {
  it("adds same-Wave and earlier-Wave edges, audited, and loads back", () => {
    const next = committed(graph(), request("T12", ["T25", "T1"]));
    expect(byId(next, "T12").depends_on).toEqual(["T25", "T1"]);
    expect(next.wave_plan_edits).toEqual([{
      schemaVersion: 1, kind: "dependency-added", wave: 2, taskId: "T12", dependsOn: ["T25", "T1"], reason: "T12 benchmarks the served code",
    }]);
  });

  it("is idempotent: repeating an applied edit changes nothing", () => {
    const next = committed(graph(), request("T12", ["T25"]));
    expect(addDependency(next, request("T12", ["T25"]))).toEqual({ ok: true, value: { kind: "unchanged", taskId: "T12" } });
  });

  it("refuses an edge that would close a cycle, naming it", () => {
    const chained = committed(committed(graph(), request("T12", ["T25"])), request("T25", ["T28"]));
    expect(refusal(chained, request("T28", ["T12"]))).toEqual({
      kind: "cycle", message: "T28 → T12 would close the dependency cycle T28 → T12 → T25 → T28",
    });
  });

  it("refuses a cycle closed between two edges of one request", () => {
    const next = committed(graph(), request("T25", ["T28"]));
    expect(refusal(next, request("T28", ["T12", "T25"]))).toMatchObject({ kind: "cycle" });
  });

  it.each<[string, () => TaskGraph, AddDependencyRequest, AddDependencyRefusal["kind"]]>([
    ["an unknown Task", () => graph(), request("T99", ["T25"]), "unknown-task"],
    ["an unknown dependency", () => graph(), request("T12", ["T99"]), "unknown-task"],
    ["a Task outside the active Wave", () => graph(), request("T1", ["T25"]), "not-active-wave"],
    ["a Task that is not pending", () => graph([implemented("T12", 2, ["src/t12.ts", "src/t12.test.ts"]), task("T25", 2, ["src/t25.ts", "src/t25.test.ts"])]), request("T12", ["T25"]), "not-pending"],
    ["a later-Wave dependency", () => graph([task("T12", 2, ["src/t12.ts", "src/t12.test.ts"]), task("T30", 3, ["src/t30.ts", "src/t30.test.ts"])]), request("T12", ["T30"]), "illegal-dependency"],
    ["a live Wave Gate run", () => graph(undefined, { active_wave_gate: activeWaveGateFixture({ runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64) }) }), request("T12", ["T25"]), "live-wave-gate"],
  ])("refuses %s", (_label, state, req, kind) => {
    expect(refusal(state(), req).kind).toBe(kind);
  });
});

describe("the State File and population hold same-Wave edges to their audit", () => {
  it("refuses at load a same-Wave edge no dependency-added audit records", () => {
    const { wave_plan_edits: _audits, ...unaudited } = committed(graph(), request("T12", ["T25"]));
    const loaded = parseTaskGraph(JSON.parse(JSON.stringify(unaudited)));
    expect(loaded).toMatchObject({ ok: false, error: expect.stringContaining("deps must be in earlier wave") });
  });

  it("refuses at load a cycle written around the audits", () => {
    const chained = committed(committed(graph(), request("T12", ["T25"])), request("T25", ["T28"]));
    const tampered = {
      ...chained,
      tasks: chained.tasks.map((candidate) => candidate.id === "T28" ? { ...candidate, depends_on: ["T12"] } : candidate),
      wave_plan_edits: [...(chained.wave_plan_edits ?? []), { schemaVersion: 1, kind: "dependency-added", wave: 2, taskId: "T28", dependsOn: ["T12"], reason: "forged" }],
    };
    expect(parseTaskGraph(JSON.parse(JSON.stringify(tampered)))).toMatchObject({ ok: false, error: expect.stringContaining("dependency cycle") });
  });

  it("refuses an authored payload that splits a coupled file set across Tasks (ADR-0082)", () => {
    const authored = (id: string, wave: number, file_list: readonly string[]) => ({
      id, description: `implement ${id}`, agent: "code-implementer-agent", wave, depends_on: [], spec_anchors: [], spec_contributions: [], file_list,
    });
    const validation = validateFull({
      spec_trace_version: 2, plan_title: "Bump", plan_file: "plan.md", spec_file: "spec.md",
      tasks: [authored("T1", 1, ["package.json", "src/a.ts"]), authored("T2", 1, ["bun.lock", "src/b.ts"])],
    }, "decompose-payload");
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors).toContain(
      "Task T1: T1 lists package.json but not bun.lock, which changes with it (a package manifest and its lockfile are one coupled file set); one Task takes the whole set",
    );
  });
});

describe("the dependency Dispatch Hold", () => {
  it("withholds a Task until its same-Wave dependency settles, then releases it", () => {
    const next = committed(graph(), request("T12", ["T25"]));
    const hold = dispatchHoldOf(next, new Set(), byId(next, "T12"));
    expect(hold).toEqual({ kind: "dependency", blockers: ["T25"], escalated: [] });
    expect(dispatchHoldMessage("T12", hold!)).toBe("T12 depends on T25 of its Wave and runs after it settles");
    const settled = { ...next, tasks: next.tasks.map((candidate) => candidate.id === "T25" ? implemented("T25", 2, ["src/t25.ts", "src/t25.test.ts"]) : candidate) };
    expect(dispatchHoldOf(settled, new Set(), byId(settled, "T12"))).toBeNull();
  });

  it("keeps withholding a settled dependency that still holds a reservation", () => {
    const next = committed(graph(), request("T12", ["T25"]));
    const reserved = { ...next, tasks: next.tasks.map((candidate) => candidate.id === "T25" ? implemented("T25", 2, ["src/t25.ts", "src/t25.test.ts"]) : candidate) };
    expect(dispatchHoldOf(reserved, new Set(["T25"]), byId(reserved, "T12"))).toMatchObject({ kind: "dependency", blockers: ["T25"] });
  });

  it("does not hold on an earlier-Wave dependency (registration requires it completed)", () => {
    const next = committed(graph(), request("T12", ["T1"]));
    expect(dispatchHoldOf(next, new Set(), byId(next, "T12"))).toBeNull();
  });
});
