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
  type ForwardFix,
  type ForwardFixRefusal,
  type ForwardFixRequest,
} from "../../src/core/forward-fix";
import { dispatchHoldMessage, dispatchHoldOf } from "../../src/core/dispatch-holds";
import { classifyImplementationWindow, type ImplementationWindow } from "../../src/core/implementation-window";
import { taskExecutionDecision } from "../../src/core/validate-task-execution";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskGraph } from "../../src/types";
import { forwardFixTask as task, sealedTask as completed, sealedWaveGraph as sealed } from "../fixtures/forward-fix";
import { implementationEscalatedLineage } from "../fixtures/implementation-escalation";
import {
  activeWaveGateFixture,
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
    expect(taskExecutionDecision(after, "T3")).toEqual({
      kind: "ineligible",
      reason: dispatchHoldMessage("T3", { kind: "forward-fix", fixTaskIds: ["T5"] }),
    });
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

describe("addForwardFix refuses what it is not for", () => {
  it.each<[string, () => TaskGraph, readonly string[] | null, ForwardFixRefusal["kind"]]>([
    ["a Wave other than the active one", () => sealed(), ["--wave", "1"], "wrong-wave"],
    ["an unknown held Task", () => sealed(), ["--hold-override", "T9"], "unknown-task"],
    ["a held Task of another Wave", () => sealed(), ["--hold-override", "T1"], "foreign-task"],
    ["a held Task with no failed attempt", () => sealed(), ["--hold-override", "T4"], "no-failed-judgement"],
    ["a path no completed Wave wrote", () => sealed(), ["--files-override", "src/new.ts"], "not-sealed"],
    ["a path another Task of the active Wave owns", () => sealed(), ["--files-override", "src/other.ts"], "owned-in-wave"],
    ["protected verification infrastructure", () => sealed(), ["--files-override", ".loom/verification-manifest.json"], "protected-path"],
    ["a live Wave Gate", () => sealed({
      active_wave_gate: activeWaveGateFixture({ runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64) }),
    }), null, "live-wave-gate"],
    ["an active implementation reservation", () => ({ ...sealed(), executing_tasks: ["T4"] }), null, "implementation-active"],
  ])("refuses %s", (_label, graph, override, kind) => {
    const holdIndex = override?.indexOf("--hold-override") ?? -1;
    const filesIndex = override?.indexOf("--files-override") ?? -1;
    const wave = override?.[0] === "--wave" ? override[1] : "2";
    const parsed = parseForwardFixArgs([
      "--wave", wave ?? "2",
      "--hold", holdIndex >= 0 ? override?.[holdIndex + 1] ?? "T3" : "T3",
      "--file", filesIndex >= 0 ? override?.[filesIndex + 1] ?? "src/serve.ts" : "src/serve.ts",
      "--description", "d", "--reason", "r",
    ]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(refusal(graph(), parsed.value).kind).toBe(kind);
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
  ])("refuses %s", (_label, tamper, message) => {
    const { graph: after } = added(sealed());
    const raw = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
    const [audit] = raw.forward_fix_history as Record<string, unknown>[];
    const loaded = parseTaskGraph({ ...raw, forward_fix_history: [tamper(audit ?? {})] });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(message);
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
