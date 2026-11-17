/**
 * Forward Fix: the operator's fallback when a judgement in the active Wave
 * fails on code a completed Wave sealed. A new Task joins the active Wave,
 * completed Waves stay untouched, and the failed judge is held until the fix
 * settles, by the one dispatch-hold rule status, registration and the brief
 * share.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  addForwardFix,
  parseForwardFixArgs,
  parseForwardFixWithdrawalArgs,
  withdrawForwardFix,
  type ForwardFix,
  type ForwardFixRefusal,
  type ForwardFixRequest,
  type ForwardFixWithdrawalRefusalKind,
  type ForwardFixWithdrawalRequest,
} from "../../src/core/forward-fix";
import { isUntouchedJoinedTask, JOINED_TASK_FIELDS, type JoinedFieldValue } from "../../src/core/task-graph-population";
import { newWaveGate } from "../../src/core/wave-gate-model";
import { retireUnownedWaveReviewAuthority } from "../../src/core/wave-gate-registration";
import { dispatchHoldMessage, dispatchHoldOf, stuckDispatchHoldMessage } from "../../src/core/dispatch-holds";
import { classifyImplementationWindow, type ImplementationWindow } from "../../src/core/implementation-window";
import { taskExecutionDecision } from "../../src/core/validate-task-execution";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskGraph } from "../../src/types";
import { failedJudge, forwardFixTask as task, sealedTask as completed, sealedWaveGraph as sealed } from "../fixtures/forward-fix";
import { implementationEscalatedLineage } from "../fixtures/implementation-escalation";
import { awaitingRedContract } from "../fixtures/stop-check-plan-fixtures";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  protectedGraphFixture,
  satisfiedProof,
  taskFixture,
} from "../fixtures/task-lifecycle";

const NOW = Date.parse("2026-11-16T09:00:00.000Z");
const observed = () => ({ kind: "observed" as const, observedAtMs: NOW, anyActiveForGraph: false });

const REASON = "T3's per-request budget test measures 33.8 MB against 10 MB on src/serve.ts";

const request = (args: readonly string[] = []): ForwardFixRequest => {
  const parsed = parseForwardFixArgs([
    "--wave", "2", "--hold", "T3", "--file", "src/serve.ts", "--file", "src/serve.test.ts",
    "--description", "Stop re-parsing selected leads per request", "--reason", REASON, ...args,
  ]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const decided = (graph: TaskGraph, req = request()): ForwardFix => {
  const result = addForwardFix(graph, req);
  if (!result.ok) throw new Error(`expected a Forward Fix, got ${result.error.kind}: ${result.error.message}`);
  return result.value;
};
const added = (graph: TaskGraph, req = request()) => {
  const outcome = decided(graph, req);
  if (outcome.kind !== "added") throw new Error("expected an added Forward Fix");
  return outcome;
};
const refusal = (graph: TaskGraph, req = request()): ForwardFixRefusal => {
  const result = addForwardFix(graph, req);
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

describe("parseForwardFixArgs", () => {
  it("parses repeated holds and files in order, with the default agent and new-test policy", () => {
    expect(request()).toEqual({
      wave: 2,
      heldTaskIds: ["T3"],
      files: ["src/serve.ts", "src/serve.test.ts"],
      agent: "code-implementer-agent",
      description: "Stop re-parsing selected leads per request",
      reason: REASON,
      newTests: "required",
    });
    expect(request(["--agent", "security-agent", "--new-tests", "existing-tests-sufficient"]))
      .toMatchObject({ agent: "security-agent", newTests: "existing-tests-sufficient" });
  });

  it.each([
    [["--wave", "2", "--file", "a.ts", "--description", "d", "--reason", "r"], "--hold must name at least one"],
    [["--wave", "2", "--hold", "T3", "--description", "d", "--reason", "r"], "--file must name at least one"],
    [["--wave", "2", "--hold", "T3", "--hold", "T3", "--file", "a.ts", "--description", "d", "--reason", "r"], "--hold T3 is given twice"],
    [["--wave", "2", "--hold", "T3", "--file", "a.ts", "--file", "a.ts", "--description", "d", "--reason", "r"], "--file a.ts is given twice"],
    [["--wave", "2", "--hold", "T3", "--file", "/abs.ts", "--description", "d", "--reason", "r"], "repository-relative"],
    [["--wave", "2", "--hold", "T3", "--file", "a.ts", "--reason", "r"], "--description must say"],
    [["--wave", "2", "--hold", "T3", "--file", "a.ts", "--description", "d"], "--reason must say"],
    [["--wave", "0", "--hold", "T3", "--file", "a.ts", "--description", "d", "--reason", "r"], "--wave must name"],
    [["--wave", "2", "--hold", "T3", "--file", "a.ts", "--description", "d", "--reason", "r", "--agent", "distill-agent"], "--agent must be one of"],
    [["--wave", "2", "--hold", "T3", "--file", "a.ts", "--description", "d", "--reason", "r", "--new-tests", "waived"], "--new-tests must be"],
    [["--wave", "2", "--hold", "--file"], "--hold needs a value"],
    [["--bogus", "x"], "unknown argument '--bogus'"],
  ])("refuses %j", (args, message) => {
    const parsed = parseForwardFixArgs(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });
});

describe("addForwardFix appends a fix Task to the active Wave", () => {
  it("mints the next Task id in the active Wave with the request's files and leaves every other Task as it was", () => {
    const graph = sealed();
    const { graph: after, task: fix, audit } = added(graph);
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
    expect(fix.plan_context).toContain("Forward Fix for T3");
    expect(fix.plan_context).toContain("src/serve.ts");
    expect(fix.plan_context).toContain("Never weaken");
    expect(audit).toEqual({
      schemaVersion: 1,
      kind: "forward-fix-added",
      wave: 2,
      fixTaskId: "T5",
      heldTaskIds: ["T3"],
      sealedPaths: ["src/serve.ts"],
      reason: REASON,
      abandonedRunId: null,
    });
    expect(after.forward_fix_history).toEqual([audit]);
    for (const original of graph.tasks) expect(byId(after, original.id)).toEqual(original);
    expect(after.wave_gate_history).toEqual(graph.wave_gate_history);
    expect(after.wave_gates["2"]).toMatchObject({ impl_complete: false, tests_passed: null, reviews_complete: false });
  });

  it("writes a graph the State File loader accepts, audit included", () => {
    const { graph: after } = added(sealed());
    const loaded = parseTaskGraph(JSON.parse(JSON.stringify(after)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.forward_fix_history).toEqual(after.forward_fix_history);
  });

  it("waives new tests when the judge's tests are the fix's proof", () => {
    const { task: fix } = added(sealed(), request(["--new-tests", "existing-tests-sufficient"]));
    expect(fix.verification_policy).toEqual({
      regression: { kind: "required" },
      new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
    });
  });

  it("replays an identical committed request without writing, and refuses a changed one only on its own grounds", () => {
    const { graph: after, audit } = added(sealed());
    expect(decided(after)).toEqual({ kind: "already-added", audit });
    expect(refusal(after, request(["--agent", "frontend-agent"])).kind).toBe("owned-in-wave");
  });
});

describe("the held judge waits for its fix (one dispatch-hold rule)", () => {
  it("status dispatches the fix and T4, and withholds T3's retry while the fix is outstanding", () => {
    const { graph: after } = added(sealed());
    expect(offered(classifyImplementationWindow(after, observed(), []))).toEqual(["T4", "T5"]);
    const hold = dispatchHoldOf(after, new Set(), byId(after, "T3"));
    expect(hold).toEqual({ kind: "forward-fix", fixTaskIds: ["T5"] });
    if (hold === null) throw new Error("expected a hold");
    expect(taskExecutionDecision(after, "T3")).toEqual({ kind: "ineligible", reason: dispatchHoldMessage("T3", hold) });
    expect(stuckDispatchHoldMessage("T3", hold)).toBe(`${dispatchHoldMessage("T3", hold)}; none of them is dispatchable, ` +
      "active or escalated, so the held Task can never start; repair the Task Graph");
  });

  it("offers T3's retry once the fix is implemented and unreserved", () => {
    const { graph: after } = added(sealed());
    const settled: TaskGraph = {
      ...after,
      tasks: after.tasks.map((candidate) => candidate.id === "T5"
        ? { ...candidate, status: "implemented", proof: satisfiedProof(["src/serve.ts", "src/serve.test.ts"]) } as Task
        : candidate),
    };
    expect(dispatchHoldOf(settled, new Set(), byId(settled, "T3"))).toBeNull();
    expect(offered(classifyImplementationWindow(settled, observed(), []))).toContain("T3");
    const retry = deriveTaskImplementationDispatch(byId(settled, "T3"));
    expect(retry.kind === "dispatch" && retry.dispatch.kind).toBe("retry-implementation");
  });

  it("holds T3 while the fix is reserved in the same registering batch", () => {
    const { graph: after } = added(sealed());
    expect(taskExecutionDecision(after, "T3", ["T3", "T5"]).kind).toBe("ineligible");
  });

  it("dispatches the fix before putting an escalated judge to the operator", () => {
    const { retry, escalation } = implementationEscalatedLineage();
    // The escalation fixture's receipts belong to T1, so T1 is the judge here.
    const judge: Task = {
      ...task("T1", 2, ["tests/budget.test.ts"]),
      implementation_attempt_history: [retry, escalation],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    };
    const graph = protectedGraphFixture({
      ...sealed(),
      tasks: [completed("T2", ["src/serve.ts"]), judge],
    });
    const parsed = parseForwardFixArgs([
      "--wave", "2", "--hold", "T1", "--file", "src/serve.ts", "--description", "d", "--reason", "r",
    ]);
    if (!parsed.ok) throw new Error(parsed.error);
    const { graph: after } = added(graph, parsed.value);
    const window = classifyImplementationWindow(after, observed(), []);
    expect(window.kind === "window" && window.recovery.kind).toBe("spawn-wave-implementation");
    expect(offered(window)).toEqual(["T3"]);
  });
});

/** One refusal case: the graph, the request's fields (each defaulting to the admissible T3 / src/serve.ts request), and the expected kind. */
type RefusalRow = Readonly<{
  label: string;
  graph: () => TaskGraph;
  wave?: number;
  hold?: string;
  file?: string;
  kind: ForwardFixRefusal["kind"];
}>;

const rowRequest = ({ wave = 2, hold = "T3", file = "src/serve.ts" }: RefusalRow): ForwardFixRequest => {
  const parsed = parseForwardFixArgs(["--wave", String(wave), "--hold", hold, "--file", file, "--description", "d", "--reason", "r"]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const servedFrozen = awaitingRedContract({
  id: "CT-1", contractTask: "T1", types: "src/serve.ts", files: [{ path: "tests/serve.acceptance.test.ts", anchors: ["AS-001"] }],
});

describe("addForwardFix refuses what it is not for", () => {
  it.each<RefusalRow>([
    { label: "a Wave other than the active one", graph: () => sealed(), wave: 1, kind: "wrong-wave" },
    { label: "an unknown held Task", graph: () => sealed(), hold: "T9", kind: "unknown-task" },
    { label: "a held Task of another Wave", graph: () => sealed(), hold: "T1", kind: "foreign-task" },
    { label: "a held Task with no failed attempt", graph: () => sealed(), hold: "T4", kind: "no-failed-judgement" },
    { label: "a path no completed Wave wrote", graph: () => sealed(), file: "src/new.ts", kind: "not-sealed" },
    { label: "a path another Task of the active Wave owns", graph: () => sealed(), file: "src/other.ts", kind: "owned-in-wave" },
    { label: "protected verification infrastructure", graph: () => sealed(), file: ".loom/verification-manifest.json", kind: "protected-path" },
    { label: "a frozen Acceptance Contract path", graph: () => ({ ...sealed(), acceptance_contracts: [servedFrozen] }), kind: "frozen-path" },
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
    expect(refusal(row.graph(), rowRequest(row)).kind).toBe(row.kind);
  });

  it("replays a committed fix even after a later Forward Fix was added", () => {
    const first = added(sealed());
    const secondRequest = parseForwardFixArgs([
      "--wave", "2", "--hold", "T3", "--file", "src/recompute.ts", "--description", "Lower the recompute peak", "--reason", "recompute breach",
    ]);
    if (!secondRequest.ok) throw new Error(secondRequest.error);
    const second = added(first.graph, secondRequest.value);
    expect(decided(second.graph)).toEqual({ kind: "already-added", audit: first.audit });
  });

  describe("a Forward Fix Task as a held judge", () => {
    /** T5 fixed T3, then its own attempt failed; `reopened` adds the Task Reopening that gave it new work. */
    const failedFixGraph = (reopened: boolean): TaskGraph => {
      const { graph } = added(sealed());
      const failedFix: Task = {
        ...byId(graph, "T5"),
        implementation_attempt_history: failedJudge("T5", []).implementation_attempt_history,
        implementation_retry_protocol: 2,
        implementation_retry_history_start: 0,
      };
      const raw = {
        ...graph,
        tasks: graph.tasks.map((candidate) => candidate.id === "T5" ? failedFix : candidate),
        ...(reopened
          ? { task_reopening_history: [{ schemaVersion: 1, kind: "implemented-tasks-reopened", wave: 2, reopenedTaskIds: ["T5"], reason: "page the response", abandonedRunId: null }] }
          : {}),
      };
      const parsed = parseTaskGraph(JSON.parse(JSON.stringify(raw)));
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    };
    const holdT5 = (): ForwardFixRequest => {
      const parsed = parseForwardFixArgs([
        "--wave", "2", "--hold", "T5", "--file", "src/recompute.ts", "--description", "Expose what the fix's paging tests need",
        "--reason", "T5's reopened paging tests fail on src/recompute.ts",
      ]);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    };

    it("refuses a fix Task no Task Reopening has given new work, even after its attempt failed", () => {
      const refused = refusal(failedFixGraph(false), holdT5());
      expect(refused.kind).toBe("not-a-judge");
      expect(refused.message).toContain("no Task Reopening has given new work");
    });

    it("holds a reopened fix Task whose attempt failed on sealed code, and the State File loads the result", () => {
      const { graph, task: fix, audit } = added(failedFixGraph(true), holdT5());
      expect(fix.id).toBe("T6");
      expect(audit.heldTaskIds).toEqual(["T5"]);
      expect(dispatchHoldOf(graph, new Set(), byId(graph, "T5"))).toEqual({ kind: "forward-fix", fixTaskIds: ["T6"] });
      expect(parseTaskGraph(JSON.parse(JSON.stringify(graph))).ok).toBe(true);
    });
  });

  it("refuses the active Wave's distill pass as a held Task", () => {
    const pass = taskFixture({
      id: "T6", description: "Distill pass for Wave 2", agent: "distill-agent", wave: 2, depends_on: [],
      file_list: ["src/other.ts"], spec_anchors: [], spec_contributions: [], review_status: "pending",
    });
    const graph = sealed({ tasks: [...sealed().tasks, pass] });
    const parsed = parseForwardFixArgs(["--wave", "2", "--hold", "T6", "--file", "src/serve.ts", "--description", "d", "--reason", "r"]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(refusal(graph, parsed.value).kind).toBe("not-a-judge");
  });
});

describe("the State File proves a Forward Fix audit", () => {
  it.each<[string, (audit: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["a sealed path outside the fix Task's file_list", (audit) => ({ ...audit, sealedPaths: ["src/recompute.ts"] }), "not in the fix Task's file_list"],
    ["a fix Task of another Wave", (audit) => ({ ...audit, fixTaskId: "T1" }), "is not a Task of Wave 2"],
    ["the fix Task holding itself", (audit) => ({ ...audit, heldTaskIds: ["T5"] }), "the fix Task itself"],
    ["an unknown field", (audit) => ({ ...audit, extra: true }), "unknown field(s): extra"],
    ["a held Task of another Wave", (audit) => ({ ...audit, heldTaskIds: ["T1"] }), "T1 is not a Task of Wave 2"],
    ["a sealed path no earlier Wave wrote", (audit) => ({ ...audit, sealedPaths: ["src/serve.test.ts"] }), "which no Task of a Wave before 2 wrote"],
    ["a repeated sealed path", (audit) => ({ ...audit, sealedPaths: ["src/serve.ts", "src/serve.ts"] }), "names 'src/serve.ts' more than once"],
    ["no sealed path", (audit) => ({ ...audit, sealedPaths: [] }), "sealedPaths must be a non-empty array"],
    ["a blank reason", (audit) => ({ ...audit, reason: "  " }), "reason must be a trimmed non-blank string"],
    ["an untrimmed reason", (audit) => ({ ...audit, reason: " r " }), "reason must be a trimmed non-blank string"],
    ["an over-long reason", (audit) => ({ ...audit, reason: "r".repeat(513) }), "reason must be a trimmed non-blank string"],
    ["a wrong schema version", (audit) => ({ ...audit, schemaVersion: 2 }), "has invalid schema or kind"],
    ["a wrong kind", (audit) => ({ ...audit, kind: "forward-fix-removed" }), "has invalid schema or kind"],
    ["a malformed abandoned run id", (audit) => ({ ...audit, abandonedRunId: "not a run" }), "abandonedRunId"],
  ])("refuses %s", (_label, tamper, message) => {
    const { graph: after } = added(sealed());
    const raw = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
    const [audit] = raw.forward_fix_history as Record<string, unknown>[];
    const loaded = parseTaskGraph({ ...raw, forward_fix_history: [tamper(audit ?? {})] });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(message);
  });

  it("refuses a Distill Task as the fix Task", () => {
    const { graph: after } = added(sealed());
    const raw = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
    const pass = taskFixture({
      id: "T6", description: "Distill pass for Wave 2", agent: "distill-agent", wave: 2, depends_on: [],
      file_list: ["src/serve.ts"], spec_anchors: [], spec_contributions: [], review_status: "pending",
    });
    const [audit] = raw.forward_fix_history as Record<string, unknown>[];
    const loaded = parseTaskGraph({
      ...raw,
      tasks: [...(raw.tasks as unknown[]), JSON.parse(JSON.stringify(pass))],
      forward_fix_history: [{ ...audit, fixTaskId: "T6" }],
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain("T6 is a Distill Task");
  });

  it("keeps a non-null abandoned run id through a round trip", () => {
    const abandoned = activeWaveGateFixture({
      runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64),
      terminalOutcome: { kind: "terminal-abandoned", reason: "fix the breach first", supersededBy: null },
    });
    const { graph: after, audit } = added(sealed({ active_wave_gate: abandoned }));
    expect(audit.abandonedRunId).toBe("run.wave-2");
    const loaded = parseTaskGraph(JSON.parse(JSON.stringify(after)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.forward_fix_history).toEqual([audit]);
  });

  it("refuses two audits naming one fix Task", () => {
    const { graph: after } = added(sealed());
    const raw = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
    const [audit] = raw.forward_fix_history as unknown[];
    const loaded = parseTaskGraph({ ...raw, forward_fix_history: [audit, audit] });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain("names fix Task T5 in two audits");
  });
});

describe("a Forward Fix's text must be renderable in its brief", () => {
  it.each([
    ["--reason", "accountManager request {accountManager} breaches", "{template variable}"],
    ["--description", "fix the {budget} path", "{template variable}"],
    ["--reason", "see LOOM_IMPLEMENTATION_BRIEF", "LOOM_ token"],
    ["--description", "Task ID: T1", "Task ID binding"],
    ["--reason", "two\nlines", "one line"],
  ])("refuses %s %j before it can reach protected state", (flag, text, problem) => {
    const args = ["--wave", "2", "--hold", "T3", "--file", "src/serve.ts", "--description", "d", "--reason", "r"];
    const index = args.indexOf(flag);
    const parsed = parseForwardFixArgs([...args.slice(0, index + 1), text, ...args.slice(index + 2)]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(problem);
  });
});

describe("withdrawForwardFix removes a fix Task that was never dispatched", () => {
  const withdrawal = (args: readonly string[] = []): ForwardFixWithdrawalRequest => {
    const parsed = parseForwardFixWithdrawalArgs(["--wave", "2", "--task", "T5", "--reason", "its text fails the brief", ...args]);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  it("removes the fix Task, moves its audit to forward_fix_withdrawals and releases the hold", () => {
    const { graph: withFix, audit } = added(sealed());
    const result = withdrawForwardFix(withFix, withdrawal());
    if (!result.ok || result.value.kind !== "withdrawn") throw new Error("expected a withdrawal");
    const after = result.value.graph;
    expect(after.tasks.map(({ id }) => id)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(after.forward_fix_history).toEqual([]);
    expect(after.forward_fix_withdrawals).toEqual([
      { schemaVersion: 1, kind: "forward-fix-withdrawn", audit, reason: "its text fails the brief" },
    ]);
    expect(dispatchHoldOf(after, new Set(), byId(after, "T3"))).toBeNull();
    expect(offered(classifyImplementationWindow(after, observed(), []))).toEqual(["T3", "T4"]);
    const loaded = parseTaskGraph(JSON.parse(JSON.stringify(after)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.forward_fix_withdrawals).toEqual(after.forward_fix_withdrawals);
  });

  it("replays a committed withdrawal and never mints the withdrawn id again", () => {
    const { graph: withFix } = added(sealed());
    const first = withdrawForwardFix(withFix, withdrawal());
    if (!first.ok || first.value.kind !== "withdrawn") throw new Error("expected a withdrawal");
    const replay = withdrawForwardFix(first.value.graph, withdrawal());
    expect(replay.ok && replay.value.kind).toBe("already-withdrawn");
    const readded = added(first.value.graph);
    expect(readded.task.id).toBe("T6");
    expect(parseTaskGraph(JSON.parse(JSON.stringify(readded.graph))).ok).toBe(true);
  });

  const withFix = (overrides: Partial<TaskGraph> = {}): TaskGraph => protectedGraphFixture({ ...added(sealed()).graph, ...overrides });
  const withTask = (graph: TaskGraph, id: string, change: (candidate: Task) => Task): TaskGraph =>
    ({ ...graph, tasks: graph.tasks.map((candidate) => candidate.id === id ? change(candidate) : candidate) });
  const withdrawn = (graph: TaskGraph, req = withdrawal()) => {
    const result = withdrawForwardFix(graph, req);
    if (!result.ok || result.value.kind !== "withdrawn") throw new Error("expected a withdrawal");
    return result.value;
  };
  const withdrawalRefusal = (graph: TaskGraph, args: readonly string[] = []): ForwardFixWithdrawalRefusalKind | string => {
    const base: Record<string, string> = { "--wave": "2", "--task": "T5", "--reason": "r" };
    for (let index = 0; index < args.length; index += 2) base[args[index] ?? ""] = args[index + 1] ?? "";
    const parsed = parseForwardFixWithdrawalArgs(Object.entries(base).flat());
    if (!parsed.ok) throw new Error(parsed.error);
    const result = withdrawForwardFix(graph, parsed.value);
    return result.ok ? result.value.kind : result.error.kind;
  };

  it.each<[string, () => TaskGraph, readonly string[], ForwardFixWithdrawalRefusalKind]>([
    ["a Task that is no Forward Fix", () => sealed(), ["--task", "T4"], "not-a-forward-fix"],
    ["another Wave", () => withFix(), ["--wave", "1"], "wrong-wave"],
    ["a graph outside the execute Phase", () => withFix({ current_phase: "decompose" }), [], "not-executing"],
    ["an active implementation reservation", () => withFix({ executing_tasks: ["T4"] }), [], "implementation-active"],
    ["a live Wave Gate", () => withFix({
      active_wave_gate: activeWaveGateFixture({ runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64) }),
    }), [], "live-wave-gate"],
    ["an abandoned run that names a successor", () => withFix({
      active_wave_gate: activeWaveGateFixture({
        runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64),
        terminalOutcome: { kind: "terminal-abandoned", reason: "replaced", supersededBy: "run.wave-2-b" },
      }),
    }), [], "successor-named"],
    ["a Wave whose gate already completed", () => withFix({
      wave_gate_history: [...(sealed().wave_gate_history ?? []), completedWaveGateFixture({ runId: "run.wave-2", wave: 2 })],
    }), [], "wave-completed"],
  ])("refuses %s", (_label, graph, overrides, kind) => {
    expect(withdrawalRefusal(graph(), overrides)).toBe(kind);
  });

  it("joins the fix Task untouched, so a never-dispatched fix is withdrawable", () => {
    expect(isUntouchedJoinedTask(added(sealed()).task)).toBe(true);
  });

  /** A value off each evidence kind's joined value. */
  const TOUCHED: Readonly<Record<Exclude<JoinedFieldValue, "joined">, unknown>> = { absent: "touched", empty: ["touched"], zero: 1, pending: "touched" };
  const evidenceFields = Object.entries(JOINED_TASK_FIELDS).flatMap(([field, joined]) => joined === "joined" ? [] : [[field, joined] as const]);

  /** A live attempt is refused by the shared Wave precondition before the fix Task is inspected. */
  const SHARED_PRECONDITION: Readonly<Record<string, ForwardFixWithdrawalRefusalKind>> = { active_implementation_attempt: "implementation-active" };

  it.each(evidenceFields)("refuses a fix Task whose %s left its joined value", (field, joined) => {
    const touched = withTask(withFix(), "T5", (candidate) => ({ ...candidate, [field]: TOUCHED[joined] }) as Task);
    expect(isUntouchedJoinedTask(touched.tasks.find(({ id }) => id === "T5") ?? task("T5", 2, []))).toBe(false);
    expect(withdrawalRefusal(touched)).toBe(SHARED_PRECONDITION[field] ?? "already-dispatched");
  });

  it("refuses a replay with a different reason instead of reporting it withdrawn", () => {
    const { graph: after } = withdrawn(withFix());
    expect(withdrawalRefusal(after, ["--reason", "another reason"])).toBe("not-a-forward-fix");
  });

  it("re-derives the Wave's gate bits from the roster left behind", () => {
    const implemented = (candidate: Task): Task =>
      ({ ...candidate, status: "implemented", proof: satisfiedProof(candidate.file_list ?? []) }) as Task;
    const reviewed = { ...newWaveGate(), impl_complete: true, tests_passed: true as const, reviews_complete: true };
    const settled = withTask(withTask(withFix(), "T3", implemented), "T4", implemented);
    const done = withdrawn({ ...settled, wave_gates: { ...settled.wave_gates, "2": reviewed } });
    expect(done.graph.wave_gates["2"]).toMatchObject({ impl_complete: true, tests_passed: null, reviews_complete: false });
    const open = withdrawn(withTask(withFix(), "T3", implemented));
    expect(open.graph.wave_gates["2"]).toMatchObject({ impl_complete: false, tests_passed: null, reviews_complete: false });
  });

  it("retires the abandoned run's review authority the way the Wave-reopening operations do", () => {
    const abandoned = withFix({
      active_wave_gate: activeWaveGateFixture({
        runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64),
        terminalOutcome: { kind: "terminal-abandoned", reason: "fix the text first", supersededBy: null },
      }),
    });
    const { graph: after } = withdrawn(abandoned);
    const retired = retireUnownedWaveReviewAuthority(abandoned, 2, "run.wave-2");
    expect(after.active_wave_gate).toEqual(retired.active_wave_gate);
    expect(after.wave_review_epoch).toEqual(retired.wave_review_epoch);
    expect(parseTaskGraph(JSON.parse(JSON.stringify(after))).ok).toBe(true);
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
  ])("the State File refuses %s", (_label, tamper, message) => {
    const { graph: withFix } = added(sealed());
    const result = withdrawForwardFix(withFix, withdrawal());
    if (!result.ok || result.value.kind !== "withdrawn") throw new Error("expected a withdrawal");
    const raw = JSON.parse(JSON.stringify(result.value.graph)) as Record<string, unknown>;
    const [record] = raw.forward_fix_withdrawals as Record<string, unknown>[];
    const loaded = parseTaskGraph(tamper(raw, record ?? {}));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(message);
  });
});

describe("Forward Fix properties", () => {
  const sealedPaths = ["src/serve.ts", "src/recompute.ts"] as const;
  const openPaths = ["src/fresh-a.ts", "src/fresh-b.ts"] as const;
  const files = fc.uniqueArray(fc.constantFrom(...sealedPaths, ...openPaths), { minLength: 1, maxLength: 4 });

  it("adds exactly when some path is sealed, and records exactly the sealed ones in request order", () => {
    fc.assert(fc.property(files, (chosen) => {
      const parsed = parseForwardFixArgs([
        "--wave", "2", "--hold", "T3", ...chosen.flatMap((path) => ["--file", path]), "--description", "d", "--reason", "r",
      ]);
      if (!parsed.ok) throw new Error(parsed.error);
      const result = addForwardFix(sealed(), parsed.value);
      const expectedSealed = chosen.filter((path) => (sealedPaths as readonly string[]).includes(path));
      expect(result.ok).toBe(expectedSealed.length > 0);
      if (result.ok && result.value.kind === "added") {
        expect(result.value.audit.sealedPaths).toEqual(expectedSealed);
        expect(result.value.task.file_list).toEqual(chosen);
      }
    }));
  });

  it("never changes a Task that was already on the roster, and mints an id above every existing one", () => {
    fc.assert(fc.property(fc.integer({ min: 5, max: 400 }), (highest) => {
      const graph = sealed();
      const padded = protectedGraphFixture({
        ...graph,
        tasks: [...graph.tasks, task(`T${highest}`, 2, [`src/pad-${highest}.ts`])],
      });
      const { graph: after, task: fix } = added(padded);
      expect(fix.id).toBe(`T${highest + 1}`);
      for (const original of padded.tasks) expect(byId(after, original.id)).toEqual(original);
    }));
  });
});
