/**
 * Adding a Task to the active Wave, and withdrawing one never dispatched
 * (ADR-0086). The new Task joins the active Wave, completed Waves stay
 * untouched, and its order against the Wave's other Tasks is ordinary
 * dependency data the one dispatch-hold rule enforces. A Forward Fix an older
 * State File carries (ADR-0077) is still loaded, and its hold is read as a
 * same-Wave dependency.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  addTask,
  parseAddTaskArgs,
  parseWithdrawTaskArgs,
  withdrawTask,
  type AddTask,
  type AddTaskRefusal,
  type AddTaskRequest,
  type WithdrawTaskRefusal,
} from "../../src/core/task-addition";
import { isUntouchedJoinedTask, JOINED_TASK_FIELDS, type JoinedFieldValue } from "../../src/core/task-graph-population";
import { newWaveGate } from "../../src/core/wave-gate-model";
import { retireUnownedWaveReviewAuthority } from "../../src/core/wave-gate-registration";
import { dispatchHoldMessage, dispatchHoldOf } from "../../src/core/dispatch-holds";
import { addDependency, parseAddDependencyArgs } from "../../src/core/task-dependency-edit";
import { classifyImplementationWindow, type ImplementationWindow } from "../../src/core/implementation-window";
import { taskExecutionDecision } from "../../src/core/validate-task-execution";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskGraph } from "../../src/types";
import { i6PlanTask } from "../fixtures/i6-plan-task";
import { i6RunnerManifest } from "../fixtures/i6-runner-manifest";
import { implementationEscalatedLineage } from "../fixtures/implementation-escalation";
import { awaitingRedContract } from "../fixtures/stop-check-plan-fixtures";
import {
  distillPass as pass,
  implemented,
  legacyForwardFixAudit,
  legacyForwardFixGraph,
  sealedTask as completed,
  sealedWaveGraph as sealed,
  waveTask as task,
  withTask,
} from "../fixtures/sealed-wave";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  protectedGraphFixture,
  executingGraphFixture,
} from "../fixtures/task-lifecycle";

const NOW = Date.parse("2026-11-18T09:00:00.000Z");
const observed = () => ({ kind: "observed" as const, observedAtMs: NOW, anyActiveForGraph: false });

const REASON = "T3's per-request budget test measures 33.8 MB against 10 MB on src/serve.ts";
const BASE = [
  "--sealed-file", "src/serve.ts", "--file", "src/serve.test.ts", "--before", "T3",
  "--description", "Stop re-parsing selected leads per request", "--reason", REASON,
] as const;

const parsedRequest = (args: readonly string[]): AddTaskRequest => {
  const parsed = parseAddTaskArgs(args);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const request = (extra: readonly string[] = []): AddTaskRequest => parsedRequest([...BASE, ...extra]);

const decided = (graph: TaskGraph, req = request()): AddTask => {
  const result = addTask(graph, req);
  if (!result.ok) throw new Error(`expected an added Task, got ${result.error.kind}: ${result.error.message}`);
  return result.value;
};
const added = (graph: TaskGraph, req = request()) => {
  const outcome = decided(graph, req);
  if (outcome.kind !== "added") throw new Error("expected a new Task");
  return outcome;
};
const refusal = (graph: TaskGraph, req = request()): AddTaskRefusal => {
  const result = addTask(graph, req);
  if (result.ok) throw new Error(`expected a refusal, got ${result.value.kind}`);
  return result.error;
};
const byId = (graph: TaskGraph, id: string): Task => {
  const found = graph.tasks.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no Task ${id}`);
  return found;
};
const offered = (window: ImplementationWindow): readonly string[] =>
  window.kind === "window" && window.recovery.kind === "spawn-wave-implementation"
    ? window.recovery.dispatches.map(({ taskId }) => taskId)
    : [];
/** `graph` as the State File JSON the loader reads. */
const rawJson = (graph: TaskGraph): Record<string, unknown> => JSON.parse(JSON.stringify(graph)) as Record<string, unknown>;
const loads = (graph: TaskGraph) => parseTaskGraph(rawJson(graph));
/** `graph` after `add-dependency` with `args`, which must add an edge. */
const dependencyAdded = (graph: TaskGraph, args: readonly string[]): TaskGraph => {
  const parsed = parseAddDependencyArgs(args);
  if (!parsed.ok) throw new Error(parsed.error);
  const edited = addDependency(graph, parsed.value);
  if (!edited.ok || edited.value.kind !== "added") throw new Error(`expected an added dependency: ${JSON.stringify(edited)}`);
  return edited.value.graph;
};

describe("parseAddTaskArgs", () => {
  it("parses plain and sealed files in order, the edges, and the default agent and new-test policy", () => {
    expect(request()).toEqual({
      files: ["src/serve.ts", "src/serve.test.ts"],
      sealed: ["src/serve.ts"],
      dependsOn: [],
      dependents: ["T3"],
      agent: "code-implementer-agent",
      description: "Stop re-parsing selected leads per request",
      reason: REASON,
      newTests: "required",
    });
    expect(request(["--depends-on", "T4", "--agent", "security-agent", "--new-tests", "existing-tests-sufficient"]))
      .toMatchObject({ dependsOn: ["T4"], agent: "security-agent", newTests: "existing-tests-sufficient" });
  });

  it.each([
    [["--description", "d", "--reason", "r"], "name at least one --file or --sealed-file"],
    [["--file", "a.ts", "--sealed-file", "a.ts", "--description", "d", "--reason", "r"], "a.ts is named twice"],
    [["--file", "/abs.ts", "--description", "d", "--reason", "r"], "repository-relative"],
    [["--file", "a.ts", "--before", "T3", "--before", "T3", "--description", "d", "--reason", "r"], "--before T3 is given twice"],
    [["--file", "a.ts", "--depends-on", "T3", "--before", "T3", "--description", "d", "--reason", "r"], "both --depends-on and --before"],
    [["--file", "a.ts", "--depends-on", "x", "--description", "d", "--reason", "r"], "--depends-on"],
    [["--file", "a.ts", "--reason", "r"], "--description must say"],
    [["--file", "a.ts", "--description", "d"], "--reason must say"],
    [["--file", "a.ts", "--description", "d", "--reason", "r".repeat(501)], "--reason is at most 500 characters"],
    [["--file", "a.ts", "--description", "d".repeat(513), "--reason", "r"], "--description is longer than 512"],
    [["--file", "a.ts", "--description", "d", "--reason", "r", "--agent", "distill-agent"], "--agent must be one of"],
    [["--file", "a.ts", "--description", "d", "--reason", "r", "--new-tests", "waived"], "--new-tests must be"],
    [["--file", "--before"], "--file needs a value"],
    [["--wave", "2"], "unknown argument '--wave'"],
  ])("refuses %j", (args, message) => {
    const parsed = parseAddTaskArgs(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it.each([
    ["--reason", "accountManager request {accountManager} breaches"],
    ["--description", "fix the ab:outcome:{incidentId} key and the {task_id} literal"],
  ])("admits %s %j: a brace in protected text is never read as a template variable", (flag, text) => {
    const args = ["--file", "src/serve.ts", "--description", "d", "--reason", "r"];
    const index = args.indexOf(flag);
    expect(parseAddTaskArgs([...args.slice(0, index + 1), text, ...args.slice(index + 2)]).ok).toBe(true);
  });

  it.each([
    ["--reason", "see LOOM_IMPLEMENTATION_BRIEF", "LOOM_ token"],
    ["--description", "Task ID: T1", "Task ID binding"],
    ["--description", "two\nlines", "one line"],
  ])("refuses %s %j, which the Task's brief could not carry", (flag, text, problem) => {
    const args = ["--file", "src/serve.ts", "--description", "d", "--reason", "r"];
    const index = args.indexOf(flag);
    const parsed = parseAddTaskArgs([...args.slice(0, index + 1), text, ...args.slice(index + 2)]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(problem);
  });
});

describe("addTask appends a Task to the active Wave", () => {
  it("mints the next id with the request's files, makes each --before Task wait for it, and changes nothing else", () => {
    const graph = sealed();
    const { graph: after, task: fix, edit } = added(graph);
    expect(fix).toMatchObject({
      id: "T5",
      wave: 2,
      agent: "code-implementer-agent",
      status: "pending",
      depends_on: [],
      spec_anchors: [],
      spec_contributions: [],
      file_list: ["src/serve.ts", "src/serve.test.ts"],
      verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } },
      review_status: "pending",
      review_generation: 0,
    });
    expect(fix.plan_context).toContain(`Added to Wave 2 by the operator: ${REASON}`);
    expect(fix.plan_context).toContain("Sealed paths (written by a completed Wave): src/serve.ts.");
    expect(fix.plan_context).toContain("T3 waits for this Task");
    expect(fix.plan_context).toContain("Never weaken");
    expect(edit).toEqual({
      schemaVersion: 1,
      kind: "task-added",
      wave: 2,
      taskId: "T5",
      files: ["src/serve.ts", "src/serve.test.ts"],
      sealed: ["src/serve.ts"],
      dependsOn: [],
      dependents: ["T3"],
      reason: REASON,
      abandonedRunId: null,
    });
    expect(after.wave_plan_edits).toEqual([edit]);
    expect(byId(after, "T3").depends_on).toEqual(["T5"]);
    for (const original of graph.tasks.filter(({ id }) => id !== "T3")) expect(byId(after, original.id)).toEqual(original);
    expect({ ...byId(after, "T3"), depends_on: [] }).toEqual(byId(graph, "T3"));
    expect(after.wave_gate_history).toEqual(graph.wave_gate_history);
    expect(after.wave_gates["2"]).toMatchObject({ impl_complete: false, tests_passed: null, reviews_complete: false });
  });

  it("writes a graph the State File loader accepts: the edit makes the same-Wave edge T3 → T5 legal", () => {
    const { graph: after } = added(sealed());
    const loaded = loads(after);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.wave_plan_edits).toEqual(after.wave_plan_edits);
    const unaudited = parseTaskGraph({ ...rawJson(after), wave_plan_edits: [] });
    expect(unaudited.ok).toBe(false);
  });

  it("needs no failed attempt and no sealed path: a Task the plan missed joins with plain files", () => {
    const { task: extra, edit } = added(sealed(), parsedRequest([
      "--file", "src/new.ts", "--file", "src/new.test.ts", "--before", "T4", "--description", "Add the missing parser", "--reason", "decompose missed it",
    ]));
    expect(extra.file_list).toEqual(["src/new.ts", "src/new.test.ts"]);
    expect(edit).not.toHaveProperty("sealed");
    expect(edit.dependents).toEqual(["T4"]);
  });

  it("takes its own --depends-on edges, and the State File accepts them", () => {
    const { graph: after, task: extra } = added(sealed(), parsedRequest([
      "--file", "src/new.ts", "--file", "src/new.test.ts", "--depends-on", "T4", "--depends-on", "T1", "--description", "d", "--reason", "r",
    ]));
    expect(extra.depends_on).toEqual(["T4", "T1"]);
    expect(dispatchHoldOf(after, new Set(), extra)).toEqual({ kind: "dependency", blockers: [{ id: "T4", escalated: false }] });
    expect(loads(after).ok).toBe(true);
  });

  it("waives new tests when existing tests are the Task's proof", () => {
    const { task: fix } = added(sealed(), request(["--new-tests", "existing-tests-sufficient"]));
    expect(fix.verification_policy).toEqual({
      regression: { kind: "required" },
      new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
    });
  });

  it("replays an identical committed request without writing, even after a later addition", () => {
    const first = added(sealed());
    expect(decided(first.graph)).toEqual({ kind: "already-added", edit: first.edit });
    const second = added(first.graph, parsedRequest([
      "--sealed-file", "src/recompute.ts", "--file", "src/recompute.test.ts", "--description", "Lower the recompute peak", "--reason", "recompute breach",
    ]));
    expect(decided(second.graph)).toEqual({ kind: "already-added", edit: first.edit });
  });

  it("replays a retry that arrives after a later edit gave the Task an incoming edge", () => {
    const first = added(sealed());
    const edited = dependencyAdded(first.graph, ["--task", "T4", "--on", "T5", "--reason", "T4 also needs it"]);
    const second = added(edited, parsedRequest(plain("--file", "src/new.ts", "--before", "T3")));
    expect(byId(second.graph, "T3").depends_on).toEqual(["T5", "T6"]);
    expect(decided(second.graph)).toEqual({ kind: "already-added", edit: first.edit });
  });

  it("refuses a hand-built request that breaks the parser's invariants instead of throwing", () => {
    expect(refusal(sealed(), { ...request(), files: [] }).kind).toBe("invalid-request");
    expect(refusal(sealed(), { ...request(), sealed: ["src/recompute.ts"] }).kind).toBe("invalid-request");
    expect(refusal(sealed(), { ...request(), dependsOn: request().dependents }).kind).toBe("invalid-request");
  });

  it("refuses a changed request on its own grounds rather than replaying it", () => {
    const { graph: after } = added(sealed());
    expect(refusal(after, request(["--agent", "frontend-agent"])).kind).toBe("path-not-addable");
  });
});

describe("a Task waits for the added Task it depends on (one dispatch-hold rule)", () => {
  it("status dispatches the new Task and T4, and withholds T3's retry while the new Task is outstanding", () => {
    const { graph: after } = added(sealed());
    expect(offered(classifyImplementationWindow(after, observed(), []))).toEqual(["T4", "T5"]);
    const hold = dispatchHoldOf(after, new Set(), byId(after, "T3"));
    expect(hold).toEqual({ kind: "dependency", blockers: [{ id: "T5", escalated: false }] });
    if (hold === null) throw new Error("expected a hold");
    expect(taskExecutionDecision(after, "T3")).toEqual({ kind: "ineligible", reason: dispatchHoldMessage("T3", hold) });
  });

  it("offers T3's retry once the new Task is implemented and unreserved", () => {
    const { graph: after } = added(sealed());
    const settled = withTask(after, "T5", implemented);
    expect(dispatchHoldOf(settled, new Set(), byId(settled, "T3"))).toBeNull();
    expect(offered(classifyImplementationWindow(settled, observed(), []))).toContain("T3");
    const retry = deriveTaskImplementationDispatch(byId(settled, "T3"));
    expect(retry.kind === "dispatch" && retry.dispatch.kind).toBe("retry-implementation");
  });

  it("holds T3 while the new Task is reserved in the same registering batch", () => {
    const { graph: after } = added(sealed());
    expect(taskExecutionDecision(after, "T3", ["T3", "T5"]).kind).toBe("ineligible");
  });

  it("dispatches the new Task before putting an escalated Task that waits for it to the operator", () => {
    const { retry, escalation } = implementationEscalatedLineage();
    // The escalation fixture's receipts belong to T1, so T1 is the escalated judge here.
    const judge: Task = {
      ...task("T1", 2, ["tests/budget.test.ts"]),
      implementation_attempt_history: [retry, escalation],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    };
    const graph = protectedGraphFixture({ ...sealed(), tasks: [completed("T2", ["src/serve.ts"]), judge] });
    const { graph: after } = added(graph, parsedRequest([
      "--sealed-file", "src/serve.ts", "--before", "T1", "--description", "d", "--reason", "r", "--new-tests", "existing-tests-sufficient",
    ]));
    const window = classifyImplementationWindow(after, observed(), []);
    expect(window.kind === "window" && window.recovery.kind).toBe("spawn-wave-implementation");
    expect(offered(window)).toEqual(["T3"]);
  });
});

/** One refusal case: the graph, extra or replacing arguments, and the expected kind. */
type RefusalRow = Readonly<{ label: string; graph: () => TaskGraph; args?: readonly string[]; kind: AddTaskRefusal["kind"] }>;

const servedFrozen = awaitingRedContract({
  id: "CT-1", contractTask: "T1", types: "src/serve.ts", files: [{ path: "tests/serve.acceptance.test.ts", anchors: ["AS-001"] }],
});
const plain = (...args: string[]): readonly string[] => [...args, "--description", "d", "--reason", "r"];

describe("addTask refuses what would break the plan", () => {
  it.each<RefusalRow>([
    { label: "a sealed path named with plain --file", graph: () => sealed(), args: plain("--file", "src/serve.ts"), kind: "path-not-addable" },
    { label: "an open path named with --sealed-file", graph: () => sealed(), args: plain("--sealed-file", "src/new.ts"), kind: "path-not-addable" },
    { label: "a path another Task of the active Wave owns", graph: () => sealed(), args: plain("--file", "src/other.ts"), kind: "path-not-addable" },
    { label: "protected verification infrastructure", graph: () => sealed(), args: plain("--file", ".loom/verification-manifest.json"), kind: "path-not-addable" },
    {
      label: "a frozen Acceptance Contract path",
      graph: () => ({ ...sealed(), acceptance_contracts: [servedFrozen] }),
      args: plain("--sealed-file", "src/serve.ts"),
      kind: "path-not-addable",
    },
    { label: "an unknown dependency", graph: () => sealed(), args: plain("--file", "src/new.ts", "--depends-on", "T9"), kind: "unknown-task" },
    {
      label: "a dependency in a later Wave",
      graph: () => sealed({ tasks: [...sealed().tasks, task("T7", 3, ["src/later.ts"])] }),
      args: plain("--file", "src/new.ts", "--depends-on", "T7"),
      kind: "illegal-dependency",
    },
    {
      label: "a Distill Task as a dependency",
      graph: () => sealed({ tasks: [...sealed().tasks, pass("T6")] }),
      args: plain("--file", "src/new.ts", "--depends-on", "T6"),
      kind: "illegal-dependency",
    },
    { label: "an unknown dependent", graph: () => sealed(), args: plain("--file", "src/new.ts", "--before", "T9"), kind: "unknown-task" },
    { label: "a dependent in a completed Wave", graph: () => sealed(), args: plain("--file", "src/new.ts", "--before", "T1"), kind: "illegal-dependent" },
    {
      label: "a dependent that is already implemented",
      graph: () => withTask(sealed(), "T4", implemented),
      args: plain("--file", "src/new.ts", "--before", "T4"),
      kind: "illegal-dependent",
    },
    {
      label: "a Distill Task as a dependent",
      graph: () => sealed({ tasks: [...sealed().tasks, pass("T6")] }),
      args: plain("--file", "src/new.ts", "--before", "T6"),
      kind: "illegal-dependent",
    },
    {
      label: "a dependent armed for attestation",
      graph: () => withTask(sealed(), "T4", (candidate) => ({ ...candidate, implementation_attestation: true }) as Task),
      args: plain("--file", "src/new.ts", "--before", "T4"),
      kind: "illegal-dependent",
    },
    { label: "a graph outside the execute Phase", graph: () => ({ ...sealed(), current_phase: "decompose" }), kind: "not-executing" },
    {
      label: "a Wave whose gate already completed",
      graph: () => ({ ...sealed(), wave_gate_history: [...(sealed().wave_gate_history ?? []), completedWaveGateFixture({ runId: "run.wave-2", wave: 2 })] }),
      kind: "wave-completed",
    },
    {
      label: "an abandoned run that names a successor",
      graph: () => sealed({
        active_wave_gate: activeWaveGateFixture({
          runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64),
          terminalOutcome: { kind: "terminal-abandoned", reason: "replaced", supersededBy: "run.wave-2-b" },
        }),
      }),
      kind: "successor-named",
    },
    {
      label: "a live Wave Gate",
      graph: () => sealed({ active_wave_gate: activeWaveGateFixture({ runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64) }) }),
      kind: "live-wave-gate",
    },
    { label: "an active implementation reservation", graph: () => ({ ...sealed(), executing_tasks: ["T4"] }), kind: "implementation-active" },
  ])("refuses $label", (row) => {
    expect(refusal(row.graph(), row.args === undefined ? request() : parsedRequest(row.args)).kind).toBe(row.kind);
  });

  it("refuses a Task that owes I6 but lists no test file, and admits it with one", () => {
    const i6Graph = protectedGraphFixture({
      spec_trace_version: 2, current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1, executing_tasks: [],
      verification_manifest: i6RunnerManifest(), wave_gates: { "1": newWaveGate() },
      tasks: [i6PlanTask("T1", 1, ["src/t1.ts", "src/t1.test.ts"])],
    });
    expect(refusal(i6Graph, parsedRequest(plain("--file", "src/new.ts"))))
      .toMatchObject({ kind: "unprovable-scope", message: expect.stringContaining("no test file") });
    expect(added(i6Graph, parsedRequest(plain("--file", "src/new.ts", "--file", "src/new.test.ts"))).task.id).toBe("T2");
  });

  it("names the flag that admits a sealed path", () => {
    expect(refusal(sealed(), parsedRequest(plain("--file", "src/serve.ts"))).message)
      .toContain("belongs to T1 of completed Wave 1; name it with --sealed-file");
  });

  it("refuses an edge that would close a dependency cycle, naming it", () => {
    const edited = dependencyAdded(sealed(), ["--task", "T4", "--on", "T3", "--reason", "T4 reads T3's output"]);
    expect(refusal(edited, parsedRequest(plain("--file", "src/new.ts", "--depends-on", "T4", "--before", "T3"))))
      .toEqual({ kind: "cycle", message: "T3 → T5 would close the dependency cycle T3 → T5 → T4 → T3" });
  });

  it("refuses a Task that takes part of a coupled file set, naming the rest (ADR-0082)", () => {
    const graph = sealed({ tasks: [...sealed().tasks, completed("T6", ["package.json", "bun.lock"])] });
    expect(refusal(graph, parsedRequest(plain("--sealed-file", "package.json"))))
      .toMatchObject({ kind: "coupled-set-split", message: expect.stringContaining("not bun.lock") });
    expect(added(graph, parsedRequest(plain("--sealed-file", "package.json", "--sealed-file", "bun.lock"))).task.file_list)
      .toEqual(["package.json", "bun.lock"]);
  });
});

describe("the State File proves added and withdrawn Tasks", () => {
  const raw = (): Record<string, unknown> => rawJson(added(sealed()).graph);
  const editOf = (graph: Record<string, unknown>): Record<string, unknown> =>
    (graph.wave_plan_edits as Record<string, unknown>[])[0] ?? {};

  it.each<[string, (edit: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["an unknown field", (edit) => ({ ...edit, extra: true }), "unknown field(s): extra"],
    ["an empty sealed list", (edit) => ({ ...edit, sealed: [] }), "sealed is omitted, not empty"],
    ["a sealed path not in files", (edit) => ({ ...edit, sealed: ["src/recompute.ts"] }), "sealed names src/recompute.ts, which is not in files"],
    ["no file", (edit) => ({ ...edit, files: [] }), "files names no path"],
    ["an unknown dependent", (edit) => ({ ...edit, dependents: ["T3", "T9"] }), "names T9, which is not a Task of this TaskGraph"],
    ["a Task both depended on and dependent", (edit) => ({ ...edit, dependsOn: ["T3"] }), "T3 is both a dependency and a dependent"],
    ["a malformed abandoned run id", (edit) => ({ ...edit, abandonedRunId: "not a run" }), "abandonedRunId"],
    ["a Task of another Wave", (edit) => ({ ...edit, wave: 1 }), "T5 is not a Task of Wave 1"],
  ])("refuses a task-added edit with %s", (_label, tamper, message) => {
    const graph = raw();
    const loaded = parseTaskGraph({ ...graph, wave_plan_edits: [tamper(editOf(graph))] });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(message);
  });

  it("refuses one Task added twice", () => {
    const graph = raw();
    const loaded = parseTaskGraph({ ...graph, wave_plan_edits: [editOf(graph), editOf(graph)] });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain("adds T5 a second time");
  });

  const withdrawal = { schemaVersion: 1, kind: "task-withdrawn", wave: 2, taskId: "T5", reason: "r", abandonedRunId: null };

  it.each<[string, (graph: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["a withdrawal of a Task no edit added", (graph) => ({ ...graph, wave_plan_edits: [editOf(graph), { ...withdrawal, taskId: "T4" }] }),
      "withdraws T4, which no earlier edit added to Wave 2"],
    ["a withdrawn Task still on the roster", (graph) => ({ ...graph, wave_plan_edits: [editOf(graph), withdrawal] }),
      "withdraws T5, which is still on the roster"],
    ["a withdrawal with an unknown field", (graph) => ({ ...graph, wave_plan_edits: [editOf(graph), { ...withdrawal, extra: 1 }] }),
      "unknown field(s): extra"],
  ])("refuses %s", (_label, tamper, message) => {
    const loaded = parseTaskGraph(tamper(raw()));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(message);
  });
});

describe("withdrawTask removes an added Task that was never dispatched", () => {
  const withdrawal = (args: readonly string[] = []) => {
    const parsed = parseWithdrawTaskArgs(["--task", "T5", "--reason", "the fix belongs in T4", ...args]);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const withdrawn = (graph: TaskGraph, req = withdrawal()) => {
    const result = withdrawTask(graph, req);
    if (!result.ok || result.value.kind !== "withdrawn") throw new Error(`expected a withdrawal, got ${JSON.stringify(result)}`);
    return result.value;
  };
  const withAdded = (overrides: Partial<TaskGraph> = {}): TaskGraph => protectedGraphFixture({ ...added(sealed()).graph, ...overrides });
  const withdrawalRefusal = (graph: TaskGraph, args: readonly string[] = []): WithdrawTaskRefusal["kind"] | string => {
    const base: Record<string, string> = { "--task": "T5", "--reason": "r" };
    for (let index = 0; index < args.length; index += 2) base[args[index] ?? ""] = args[index + 1] ?? "";
    const parsed = parseWithdrawTaskArgs(Object.entries(base).flat());
    if (!parsed.ok) throw new Error(parsed.error);
    const result = withdrawTask(graph, parsed.value);
    return result.ok ? result.value.kind : result.error.kind;
  };

  it("removes the Task and every edge to it, releasing the Tasks that waited, and the loader accepts the result", () => {
    const { graph: after, record, released } = withdrawn(withAdded());
    expect(after.tasks.map(({ id }) => id)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(byId(after, "T3").depends_on).toEqual([]);
    expect(released).toEqual(["T3"]);
    expect(record).toEqual({
      kind: "task-withdrawn",
      edit: { schemaVersion: 1, kind: "task-withdrawn", wave: 2, taskId: "T5", reason: "the fix belongs in T4", abandonedRunId: null },
    });
    expect(dispatchHoldOf(after, new Set(), byId(after, "T3"))).toBeNull();
    expect(offered(classifyImplementationWindow(after, observed(), []))).toEqual(["T3", "T4"]);
    const loaded = loads(after);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.wave_plan_edits?.map(({ kind }) => kind)).toEqual(["task-added", "task-withdrawn"]);
  });

  it("still loads when a later edit named the withdrawn Task", () => {
    const { graph: after, released } = withdrawn(dependencyAdded(withAdded(), ["--task", "T4", "--on", "T5", "--reason", "T4 also needs it"]));
    expect(released).toEqual(["T3", "T4"]);
    expect(byId(after, "T4").depends_on).toEqual([]);
    expect(loads(after).ok).toBe(true);
  });

  it("replays a committed withdrawal and never mints the withdrawn id again", () => {
    const first = withdrawn(withAdded());
    const replay = withdrawTask(first.graph, withdrawal());
    expect(replay.ok && replay.value.kind).toBe("already-withdrawn");
    const readded = added(first.graph);
    expect(readded.task.id).toBe("T6");
    expect(loads(readded.graph).ok).toBe(true);
  });

  it.each<[string, () => TaskGraph, readonly string[], WithdrawTaskRefusal["kind"]]>([
    ["a Task add-task did not append", () => withAdded(), ["--task", "T4"], "not-an-added-task"],
    ["a graph outside the execute Phase", () => withAdded({ current_phase: "decompose" }), [], "not-executing"],
    ["an active implementation reservation", () => executingGraphFixture(withAdded(), ["T4"]), [], "implementation-active"],
    ["a live Wave Gate", () => withAdded({
      active_wave_gate: activeWaveGateFixture({ runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64) }),
    }), [], "live-wave-gate"],
    ["an abandoned run that names a successor", () => withAdded({
      active_wave_gate: activeWaveGateFixture({
        runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64),
        terminalOutcome: { kind: "terminal-abandoned", reason: "replaced", supersededBy: "run.wave-2-b" },
      }),
    }), [], "successor-named"],
    ["a Wave whose gate already completed", () => withAdded({
      wave_gate_history: [...(sealed().wave_gate_history ?? []), completedWaveGateFixture({ runId: "run.wave-2", wave: 2 })],
    }), [], "wave-completed"],
  ])("refuses %s", (_label, graph, overrides, kind) => {
    expect(withdrawalRefusal(graph(), overrides)).toBe(kind);
  });

  it("joins the Task untouched, so a never-dispatched Task is withdrawable", () => {
    expect(isUntouchedJoinedTask(added(sealed()).task)).toBe(true);
  });

  /** A value off each evidence kind's joined value. */
  const TOUCHED: Readonly<Record<Exclude<JoinedFieldValue, "joined">, unknown>> = { absent: "touched", empty: ["touched"], zero: 1, pending: "touched" };
  const evidenceFields = Object.entries(JOINED_TASK_FIELDS).flatMap(([field, joined]) => joined === "joined" ? [] : [[field, joined] as const]);
  /** A live attempt is refused by the shared Wave precondition before the Task is inspected. */
  const SHARED_PRECONDITION: Readonly<Record<string, WithdrawTaskRefusal["kind"]>> = { active_implementation_attempt: "implementation-active" };

  it.each(evidenceFields)("refuses a Task whose %s left its joined value", (field, joined) => {
    const touched = withTask(withAdded(), "T5", (candidate) => ({ ...candidate, [field]: TOUCHED[joined] }) as Task);
    expect(withdrawalRefusal(touched)).toBe(SHARED_PRECONDITION[field] ?? "already-dispatched");
  });

  it("refuses a replay with a different reason instead of reporting it withdrawn", () => {
    const { graph: after } = withdrawn(withAdded());
    expect(withdrawalRefusal(after, ["--reason", "another reason"])).toBe("not-an-added-task");
  });

  it("re-derives the Wave's gate bits from the roster left behind", () => {
    const reviewed = { ...newWaveGate(), impl_complete: true, tests_passed: true as const, reviews_complete: true };
    const settled = withTask(withTask(withAdded(), "T3", implemented), "T4", implemented);
    const done = withdrawn({ ...settled, wave_gates: { ...settled.wave_gates, "2": reviewed } });
    expect(done.graph.wave_gates["2"]).toMatchObject({ impl_complete: true, tests_passed: null, reviews_complete: false });
  });

  it("retires the abandoned run's review authority the way the Wave-reopening operations do", () => {
    const abandoned = withAdded({
      active_wave_gate: activeWaveGateFixture({
        runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64),
        terminalOutcome: { kind: "terminal-abandoned", reason: "fix the text first", supersededBy: null },
      }),
    });
    const { graph: after, record } = withdrawn(abandoned);
    expect(record.kind === "task-withdrawn" && record.edit.abandonedRunId).toBe("run.wave-2");
    const retired = retireUnownedWaveReviewAuthority(abandoned, 2, "run.wave-2");
    expect(after.active_wave_gate).toEqual(retired.active_wave_gate);
    expect(after.wave_review_epoch).toEqual(retired.wave_review_epoch);
    expect(loads(after).ok).toBe(true);
  });
});

describe("a Forward Fix an older State File carries", () => {
  it("loads, and its hold is read as a same-Wave dependency on the fix Task", () => {
    const graph = legacyForwardFixGraph();
    expect(loads(graph).ok).toBe(true);
    expect(dispatchHoldOf(graph, new Set(), byId(graph, "T3"))).toEqual({ kind: "dependency", blockers: [{ id: "T5", escalated: false }] });
    expect(offered(classifyImplementationWindow(graph, observed(), []))).toEqual(["T4", "T5"]);
    const settled = withTask(graph, "T5", implemented);
    expect(dispatchHoldOf(settled, new Set(), byId(settled, "T3"))).toBeNull();
  });

  it("names a fix Task that escalated as the blocker, so the held Task is reported blocked, not waiting", () => {
    const { retry, escalation } = implementationEscalatedLineage();
    const fix: Task = { ...task("T1", 2, ["src/serve.ts"]), implementation_attempt_history: [retry, escalation], implementation_retry_protocol: 2, implementation_retry_history_start: 0 };
    const graph = protectedGraphFixture({
      ...sealed(),
      tasks: [completed("T2", ["src/serve.ts"]), fix, task("T3", 2, ["tests/budget.test.ts"])],
      forward_fix_history: [legacyForwardFixAudit({ fixTaskId: "T1" })],
    });
    expect(dispatchHoldOf(graph, new Set(), byId(graph, "T3"))).toEqual({ kind: "dependency", blockers: [{ id: "T1", escalated: true }] });
  });

  it.each<[string, (audit: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["a sealed path outside the fix Task's file_list", (audit) => ({ ...audit, sealedPaths: ["src/recompute.ts"] }), "not in the fix Task's file_list"],
    ["a fix Task of another Wave", (audit) => ({ ...audit, fixTaskId: "T1" }), "is not a Task of Wave 2"],
    ["the fix Task holding itself", (audit) => ({ ...audit, heldTaskIds: ["T5"] }), "the fix Task itself"],
    ["an unknown field", (audit) => ({ ...audit, extra: true }), "unknown field(s): extra"],
    ["a sealed path no earlier Wave wrote", (audit) => ({ ...audit, sealedPaths: ["src/serve.test.ts"] }), "which no Task of a Wave before 2 wrote"],
    ["a wrong kind", (audit) => ({ ...audit, kind: "forward-fix-removed" }), "has invalid schema or kind"],
  ])("the parser still refuses %s", (_label, tamper, message) => {
    const loaded = parseTaskGraph({ ...rawJson(legacyForwardFixGraph()), forward_fix_history: [tamper({ ...legacyForwardFixAudit() })] });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(message);
  });

  it("withdraws an untouched legacy fix Task, moving its audit whole and releasing its held Tasks", () => {
    const parsed = parseWithdrawTaskArgs(["--task", "T5", "--reason", "its text fails the brief"]);
    if (!parsed.ok) throw new Error(parsed.error);
    const result = withdrawTask(legacyForwardFixGraph(), parsed.value);
    if (!result.ok || result.value.kind !== "withdrawn") throw new Error(`expected a withdrawal: ${JSON.stringify(result)}`);
    const { graph: after, released, record } = result.value;
    expect(released).toEqual(["T3"]);
    expect(record).toEqual({
      kind: "forward-fix-withdrawn",
      withdrawal: { schemaVersion: 1, kind: "forward-fix-withdrawn", audit: legacyForwardFixAudit(), reason: "its text fails the brief" },
    });
    expect(after.tasks.some(({ id }) => id === "T5")).toBe(false);
    expect(after.forward_fix_history).toEqual([]);
    expect(dispatchHoldOf(after, new Set(), byId(after, "T3"))).toBeNull();
    expect(loads(after).ok).toBe(true);
    const replay = withdrawTask(after, parsed.value);
    expect(replay.ok && replay.value.kind).toBe("already-withdrawn");
    expect(added(after).task.id).toBe("T6");
  });

  it("refuses an edge that would close a cycle through a legacy hold, in add-task and add-dependency alike", () => {
    // Legacy: T3 waits for fix Task T5. T5 → new → T3 would close T3 → T5 → new → T3.
    expect(refusal(legacyForwardFixGraph(), parsedRequest(plain("--file", "src/new.ts", "--depends-on", "T3", "--before", "T5"))).kind)
      .toBe("cycle");
    const parsed = parseAddDependencyArgs(["--task", "T5", "--on", "T3", "--reason", "would wait on its own judge"]);
    if (!parsed.ok) throw new Error(parsed.error);
    const result = addDependency(legacyForwardFixGraph(), parsed.value);
    expect(result.ok ? result.value.kind : result.error.kind).toBe("cycle");
  });

  it.each<[string, (raw: Record<string, unknown>, withdrawal: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["a withdrawn fix Task still on the roster", (raw, withdrawal) => ({
      ...raw, tasks: [...(raw.tasks as unknown[]), JSON.parse(JSON.stringify(task("T5", 2, ["src/serve.ts"])))], forward_fix_withdrawals: [withdrawal],
    }), "is still on the roster"],
    ["one fix Task withdrawn twice", (raw, withdrawal) => ({ ...raw, forward_fix_withdrawals: [withdrawal, withdrawal] }), "withdraws fix Task T5 twice"],
    ["a wrong kind", (raw, withdrawal) => ({ ...raw, forward_fix_withdrawals: [{ ...withdrawal, kind: "forward-fix-added" }] }), "has invalid schema or kind"],
    ["a malformed audit", (raw, withdrawal) => ({
      ...raw, forward_fix_withdrawals: [{ ...withdrawal, audit: { ...(withdrawal.audit as Record<string, unknown>), sealedPaths: [] } }],
    }), "audit.sealedPaths must be a non-empty array"],
    ["a blank reason", (raw, withdrawal) => ({ ...raw, forward_fix_withdrawals: [{ ...withdrawal, reason: "  " }] }), "reason must be a trimmed non-blank string"],
    ["an unknown field", (raw, withdrawal) => ({ ...raw, forward_fix_withdrawals: [{ ...withdrawal, extra: true }] }), "unknown field(s): extra"],
    ["a non-array", (raw) => ({ ...raw, forward_fix_withdrawals: {} }), "forward_fix_withdrawals must be an array"],
  ])("the parser still refuses a legacy withdrawal with %s", (_label, tamper, message) => {
    const withdrawal = { schemaVersion: 1, kind: "forward-fix-withdrawn", audit: { ...legacyForwardFixAudit() }, reason: "wrong files" };
    const loaded = parseTaskGraph(tamper(rawJson(sealed()), withdrawal));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(message);
  });

  it("never re-mints a Forward Fix id the retired withdrawal removed", () => {
    const graph = sealed({
      forward_fix_withdrawals: [{ schemaVersion: 1, kind: "forward-fix-withdrawn", audit: legacyForwardFixAudit(), reason: "wrong files" }],
    });
    expect(loads(graph).ok).toBe(true);
    expect(added(graph).task.id).toBe("T6");
  });
});

describe("add-task properties", () => {
  const sealedPaths = ["src/serve.ts", "src/recompute.ts"] as const;
  const openPaths = ["src/fresh-a.ts", "src/fresh-b.ts"] as const;
  const files = fc.uniqueArray(fc.constantFrom(...sealedPaths, ...openPaths), { minLength: 1, maxLength: 4 });

  it("adds any mix of correctly flagged paths, recording exactly the sealed ones in request order", () => {
    fc.assert(fc.property(files, (chosen) => {
      const args = chosen.flatMap((path) => [(sealedPaths as readonly string[]).includes(path) ? "--sealed-file" : "--file", path]);
      const { task: extra, edit, graph } = added(sealed(), parsedRequest(plain(...args)));
      const expectedSealed = chosen.filter((path) => (sealedPaths as readonly string[]).includes(path));
      expect(edit.sealed ?? []).toEqual(expectedSealed);
      expect(extra.file_list).toEqual(chosen);
      expect(loads(graph).ok).toBe(true);
    }));
  });

  it("never changes a Task that was already on the roster, and mints an id above every existing one", () => {
    fc.assert(fc.property(fc.integer({ min: 5, max: 400 }), (highest) => {
      const graph = sealed();
      const padded = protectedGraphFixture({ ...graph, tasks: [...graph.tasks, task(`T${highest}`, 2, [`src/pad-${highest}.ts`])] });
      const { graph: after, task: extra } = added(padded, parsedRequest(plain("--sealed-file", "src/serve.ts")));
      expect(extra.id).toBe(`T${highest + 1}`);
      for (const original of padded.tasks) expect(byId(after, original.id)).toEqual(original);
    }));
  });
});
