/**
 * Task re-scoping (loom#198, Cause 3): a pending Task's file_list repaired in
 * place, keeping every invariant population checks, audited as a
 * `WavePlanEdit`. Every committed graph is round-tripped through the State
 * File parser, so a re-scope that would load back corrupt fails here.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseTaskRescopeArgs,
  rescopeBaselineDuty,
  rescopeTask,
  type ObservedBaselines,
  type TaskRescope,
  type TaskRescopeRefusal,
  type TaskRescopeRequest,
} from "../../src/core/task-rescope";
import { newWaveGate } from "../../src/core/wave-gate-model";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { DeclaredArtifactBaseline } from "../../src/core/artifact-baseline";
import type { Task, TaskGraph } from "../../src/types";
import { i6RunnerManifest } from "../fixtures/i6-runner-manifest";
import { i6PlanTask } from "../fixtures/i6-plan-task";
import { MAX_PLAN_EDIT_REASON_LENGTH, taskRescopedEdit, type TaskRescopedEditInput } from "../../src/core/wave-plan-edit";
import { parseAuthoredTaskRoster, populateTaskGraph } from "../../src/core/task-graph-population";
import { parseExportBindings } from "../../src/core/skeleton/bindings";
import { isDistillTask } from "../../src/core/distill-task";
import { indexedSpec, specDefining } from "../fixtures/spec-index-fixture";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  protectedGraphFixture,
  satisfiedProof,
} from "../fixtures/task-lifecycle";

const START = "b".repeat(40);
const WAIVED = { regression: { kind: "required" as const }, new_tests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const } };

const snapshot = (byte: string): DeclaredArtifactBaseline["snapshot"] => ({ kind: "sha256", digest: byte.repeat(64) });
const entry = (artifact: string, byte: string): DeclaredArtifactBaseline => ({ artifact, snapshot: snapshot(byte) });

const task = i6PlanTask;

/** Wave 1 current under an I6-era manifest: T1 owes I6 with no test file, T2 is fine, T3 waits in Wave 2. */
function graph(overrides: Partial<TaskGraph> = {}, tasks?: readonly Task[]): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: [],
    verification_manifest: i6RunnerManifest(),
    tasks: tasks ?? [
      task("T1", 1, ["src/t1.ts"]),
      task("T2", 1, ["src/t2.ts", "src/t2.test.ts"]),
      task("T3", 2, ["src/t3.ts", "src/t3.test.ts"]),
    ],
    wave_gates: { "1": newWaveGate(), "2": newWaveGate() },
    ...overrides,
  });
}

const request = (taskId: string, add: readonly string[], remove: readonly string[] = [], reason = "T1 needs its test file"): TaskRescopeRequest => {
  const parsed = parseTaskRescopeArgs([
    "--task", taskId,
    ...add.flatMap((path) => ["--add-file", path]),
    ...remove.flatMap((path) => ["--remove-file", path]),
    "--reason", reason,
  ]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const ADD_TEST = request("T1", ["src/t1.test.ts"]);

const decided = (state: TaskGraph, req: TaskRescopeRequest, observed: ObservedBaselines | null = null): TaskRescope => {
  const result = rescopeTask(state, req, observed);
  if (!result.ok) throw new Error(`expected a re-scope, got ${result.error.kind}: ${result.error.message}`);
  return result.value;
};
/** The committed graph, proven to load back through the State File parser. */
const committed = (state: TaskGraph, req: TaskRescopeRequest, observed: ObservedBaselines | null = null): TaskGraph => {
  const outcome = decided(state, req, observed);
  if (outcome.kind !== "rescoped") throw new Error("expected a committed re-scope");
  const reloaded = parseTaskGraph(JSON.parse(JSON.stringify(outcome.graph)));
  if (!reloaded.ok) throw new Error(`the re-scoped graph does not load back: ${reloaded.error}`);
  return outcome.graph;
};
/** The committed graph (proven to load back) and its audit. */
const rescoped = (state: TaskGraph, req: TaskRescopeRequest) => {
  const outcome = decided(state, req);
  if (outcome.kind !== "rescoped") throw new Error("expected a committed re-scope");
  return { graph: committed(state, req), audit: outcome.audit };
};
const refusal = (state: TaskGraph, req: TaskRescopeRequest, observed: ObservedBaselines | null = null): TaskRescopeRefusal => {
  const result = rescopeTask(state, req, observed);
  if (result.ok) throw new Error(`expected a refusal, got ${result.value.kind}`);
  return result.error;
};
const byId = (state: TaskGraph, id: string): Task => state.tasks.find((candidate) => candidate.id === id)!;

describe("parseTaskRescopeArgs", () => {
  it("accepts a task, additions, removals and a trimmed reason, in any order", () => {
    expect(parseTaskRescopeArgs(["--reason", "  scope ", "--remove-file", "src/a.ts", "--task", "T1", "--add-file", "src/a.test.ts"])).toEqual({
      ok: true,
      value: { taskId: "T1", add: ["src/a.test.ts"], sealed: [], remove: ["src/a.ts"], reason: "scope" },
    });
  });

  it("adds a path named with --add-sealed-file and records it as sealed", () => {
    expect(parseTaskRescopeArgs(["--task", "T1", "--add-file", "src/a.ts", "--add-sealed-file", "src/sealed.ts", "--reason", "r"])).toEqual({
      ok: true,
      value: { taskId: "T1", add: ["src/a.ts", "src/sealed.ts"], sealed: ["src/sealed.ts"], remove: [], reason: "r" },
    });
  });

  it.each([
    [["--task", "T1", "--reason", "r"], "name at least one --add-file, --add-sealed-file or --remove-file"],
    [["--task", "T1", "--add-file", "src/a.ts", "--add-sealed-file", "src/a.ts", "--reason", "r"], "src/a.ts is named twice"],
    [["--add-file", "src/a.ts", "--reason", "r"], "--task must name the Task"],
    [["--task", "T1", "--task", "T2", "--add-file", "src/a.ts", "--reason", "r"], "--task is given twice"],
    [["--task", "T1", "--add-file", "src/a.ts"], "--reason must say why"],
    [["--task", "T1", "--add-file", "src/a.ts", "--reason", "   "], "--reason must say why"],
    [["--task", "T1", "--add-file", "src/a.ts", "--reason", "r", "--reason", "s"], "--reason is given twice"],
    [["--task", "T1", "--add-file", "src/a.ts", "--add-file", "src/a.ts", "--reason", "r"], "src/a.ts is named twice"],
    [["--task", "T1", "--add-file", "src/a.ts", "--remove-file", "src/a.ts", "--reason", "r"], "src/a.ts is named twice"],
    [["--task", "T1", "--add-file", "/etc/passwd", "--reason", "r"], "--add-file"],
    [["--task", "T1", "--add-file", "../out.ts", "--reason", "r"], "--add-file"],
    [["--task", "T1", "--add-file", "--reason", "r"], "--add-file needs a value"],
    [["--task", "T1", "--file", "src/a.ts", "--reason", "r"], "unknown argument '--file'"],
  ])("refuses %j", (args, problem) => {
    const parsed = parseTaskRescopeArgs(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(problem);
      expect(parsed.error).toContain("Usage: helper orchestration rescope-task");
    }
  });

  it("bounds the reason", () => {
    const at = (length: number) => parseTaskRescopeArgs(["--task", "T1", "--add-file", "src/a.ts", "--reason", "r".repeat(length)]);
    expect(at(MAX_PLAN_EDIT_REASON_LENGTH).ok).toBe(true);
    expect(at(MAX_PLAN_EDIT_REASON_LENGTH + 1)).toMatchObject({ ok: false, error: expect.stringContaining(`--reason is at most ${MAX_PLAN_EDIT_REASON_LENGTH} characters`) });
  });
});

describe("rescopeTask: the repair it exists for", () => {
  it("adds a test file to a new-tests Task that had none, re-deriving its Proof, and audits the edit", () => {
    const before = graph();
    const after = committed(before, ADD_TEST);
    expect(byId(after, "T1").file_list).toEqual(["src/t1.ts", "src/t1.test.ts"]);
    expect(byId(after, "T1").proof).not.toEqual(byId(before, "T1").proof);
    expect(after.wave_plan_edits).toEqual([{
      schemaVersion: 1, kind: "task-rescoped", wave: 1, taskId: "T1",
      added: ["src/t1.test.ts"], removed: [], baselineRevision: null, reason: "T1 needs its test file",
    }]);
    expect(byId(after, "T2")).toEqual(byId(before, "T2"));
  });

  it("is idempotent: a repeat changes nothing and appends no audit", () => {
    const once = committed(graph(), ADD_TEST);
    expect(decided(once, ADD_TEST)).toEqual({ kind: "unchanged", taskId: "T1" });
  });

  it("re-scopes a pending Task of a later Wave, and removes as well as adds", () => {
    const after = committed(graph(), request("T3", ["src/t3-helper.ts"], ["src/t3.ts"]));
    expect(byId(after, "T3").file_list).toEqual(["src/t3.test.ts", "src/t3-helper.ts"]);
    expect(after.wave_plan_edits?.[0]).toMatchObject({ wave: 2, added: ["src/t3-helper.ts"], removed: ["src/t3.ts"] });
  });

  it("drops the stale attempt baseline so the next registration captures a fresh one", () => {
    const withAttempt = graph({}, [task("T1", 1, ["src/t1.ts"], { attempt_artifact_baseline: [entry("src/t1.ts", "1")] })]);
    expect(byId(committed(withAttempt, ADD_TEST), "T1").attempt_artifact_baseline).toBeUndefined();
  });

  it("keeps the order: the audit appends to earlier edits", () => {
    const first = committed(graph(), ADD_TEST);
    const second = committed(first, request("T2", ["src/t2-extra.ts"], [], "T2 splits a helper"));
    expect(second.wave_plan_edits?.map(({ taskId }) => taskId)).toEqual(["T1", "T2"]);
  });
});

describe("rescopeTask: the invariants population checks still hold", () => {
  it("refuses to leave a new-tests Task without a test file", () => {
    expect(refusal(graph(), request("T2", [], ["src/t2.test.ts"]))).toMatchObject({ kind: "unprovable-scope", message: expect.stringContaining("no test file") });
  });

  it("lets a Task that waives new tests drop its test file", () => {
    const waived = graph({}, [task("T1", 1, ["src/t1.ts", "src/t1.test.ts"], { verification_policy: WAIVED })]);
    expect(byId(committed(waived, request("T1", [], ["src/t1.test.ts"])), "T1").file_list).toEqual(["src/t1.ts"]);
  });

  it("refuses a path another Task of the same Wave lists", () => {
    expect(refusal(graph(), request("T1", ["src/t2.ts"]))).toMatchObject({ kind: "path-not-addable", message: expect.stringContaining("already T2's") });
  });

  it("refuses a protected verification path", () => {
    expect(refusal(graph(), request("T1", [".loom/verification-manifest.json"]))).toMatchObject({ kind: "path-not-addable" });
  });

  it("refuses an empty file list", () => {
    const waived = graph({}, [task("T1", 1, ["src/t1.ts"], { verification_policy: WAIVED })]);
    expect(refusal(waived, request("T1", [], ["src/t1.ts"]))).toMatchObject({ kind: "empty-file-list" });
  });

  it("refuses a Task that is not pending", () => {
    const implemented = graph({}, [task("T1", 1, ["src/t1.ts", "src/t1.test.ts"], {
      status: "implemented", proof: satisfiedProof(["src/t1.ts", "src/t1.test.ts"], "owed-if-new-tests"), review_status: "passed",
    })]);
    expect(refusal(implemented, request("T1", ["src/t1-more.ts"]))).toMatchObject({ kind: "not-pending" });
  });

  it("refuses an unknown Task", () => {
    expect(refusal(graph(), request("T9", ["src/t9.ts"]))).toMatchObject({ kind: "unknown-task" });
  });

  it("refuses outside the execute Phase", () => {
    expect(refusal(graph({ current_phase: "decompose" }), ADD_TEST)).toMatchObject({ kind: "not-executing" });
  });

  it("refuses while a live Wave Gate run owns the Wave", () => {
    const live = graph({ active_wave_gate: activeWaveGateFixture({ runId: "run.wave-1", wave: 1, authorityDigest: "a".repeat(64) }) });
    expect(refusal(live, ADD_TEST)).toMatchObject({ kind: "live-wave-gate" });
  });

  const sealedGraph = (wave2: readonly Task[] = [task("T3", 2, ["src/t3.ts", "src/t3.test.ts"])]) => graph({
    current_wave: 2,
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
  }, [
    task("T1", 1, ["src/t1.ts", "src/t1.test.ts", "package.json", "bun.lock"], {
      status: "implemented", proof: satisfiedProof(["src/t1.ts", "src/t1.test.ts", "package.json", "bun.lock"], "owed-if-new-tests"), review_status: "passed",
    }),
    ...wave2,
  ]);
  const sealedRequest = (taskId: string, plain: readonly string[], sealed: readonly string[], remove: readonly string[] = []) => {
    const parsed = parseTaskRescopeArgs([
      "--task", taskId,
      ...plain.flatMap((path) => ["--add-file", path]),
      ...sealed.flatMap((path) => ["--add-sealed-file", path]),
      ...remove.flatMap((path) => ["--remove-file", path]),
      "--reason", "the bump changes sealed files",
    ]);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  it("refuses a sealed path given with --add-file, pointing at --add-sealed-file", () => {
    expect(refusal(sealedGraph(), request("T3", ["src/t1.ts"]))).toMatchObject({
      kind: "path-not-addable", message: expect.stringContaining("--add-sealed-file"),
    });
  });

  it("takes a sealed path named with --add-sealed-file, recording it as sealed", () => {
    const outcome = rescoped(sealedGraph(), sealedRequest("T3", [], ["src/t1.test.ts"]));
    expect(byId(outcome.graph, "T3").file_list).toEqual(["src/t3.ts", "src/t3.test.ts", "src/t1.test.ts"]);
    expect(outcome.audit).toMatchObject({ added: ["src/t1.test.ts"], sealed: ["src/t1.test.ts"] });
  });

  it("refuses --add-sealed-file on a path no completed Wave sealed", () => {
    expect(refusal(sealedGraph(), sealedRequest("T3", [], ["src/new.ts"]))).toMatchObject({
      kind: "path-not-addable", message: expect.stringContaining("is not sealed by a completed Wave"),
    });
  });

  it("refuses an edit that leaves the Task with part of a coupled file set", () => {
    expect(refusal(sealedGraph(), sealedRequest("T3", [], ["package.json"]))).toMatchObject({
      kind: "coupled-set-split", message: expect.stringContaining("not bun.lock"),
    });
    expect(rescoped(sealedGraph(), sealedRequest("T3", [], ["package.json", "bun.lock"])).audit.sealed).toEqual(["package.json", "bun.lock"]);
  });

  it("refuses to take a coupled member another Task of the Wave still lists, until that Task gives it up", () => {
    const split = graph({}, [
      task("T3", 1, ["src/t3.ts", "src/t3.test.ts", "package.json"]),
      task("T4", 1, ["src/t4.ts", "src/t4.test.ts", "bun.lock"]),
    ]);
    expect(refusal(split, request("T3", ["bun.lock"]))).toMatchObject({ kind: "path-not-addable", message: expect.stringContaining("already T4's") });
    const released = rescoped(split, request("T4", [], ["bun.lock"]));
    expect(byId(rescoped(released.graph, request("T3", ["bun.lock"])).graph, "T3").file_list).toContain("bun.lock");
  });
});

describe("rescopeTask: the population baseline", () => {
  const baselined = (extra: Partial<Task> = {}) => graph({}, [
    task("T1", 1, ["src/t1.ts"], { artifact_baseline: [entry("src/t1.ts", "1")], start_sha: START, ...extra }),
  ]);

  it("asks the shell for the added paths at the Task's start_sha, and for nothing otherwise", () => {
    expect(rescopeBaselineDuty(baselined(), ADD_TEST)).toEqual({ revision: START, paths: ["src/t1.test.ts"] });
    expect(rescopeBaselineDuty(graph(), ADD_TEST)).toBeNull();
    expect(rescopeBaselineDuty(baselined(), request("T1", ["src/t1.ts"]))).toBeNull();
    expect(rescopeBaselineDuty(baselined(), request("T9", ["src/t9.ts"]))).toBeNull();
  });

  it("extends the baseline in file-list order and records the revision it was read at", () => {
    const after = committed(baselined(), ADD_TEST, { revision: START, entries: [{ artifact: "src/t1.test.ts", snapshot: { kind: "missing" } }] });
    expect(byId(after, "T1").artifact_baseline).toEqual([entry("src/t1.ts", "1"), { artifact: "src/t1.test.ts", snapshot: { kind: "missing" } }]);
    expect(after.wave_plan_edits?.[0]).toMatchObject({ kind: "task-rescoped", baselineRevision: START });
  });

  it("drops a removed path's baseline entry", () => {
    const two = graph({}, [task("T1", 1, ["src/t1.ts", "src/t1.test.ts", "src/old.ts"], {
      artifact_baseline: [entry("src/t1.ts", "1"), entry("src/t1.test.ts", "2"), entry("src/old.ts", "3")], start_sha: START,
    })]);
    const after = committed(two, request("T1", [], ["src/old.ts"]));
    expect(byId(after, "T1").artifact_baseline).toEqual([entry("src/t1.ts", "1"), entry("src/t1.test.ts", "2")]);
    expect(after.wave_plan_edits?.[0]).toMatchObject({ kind: "task-rescoped", baselineRevision: null });
  });

  it.each<[string, ObservedBaselines | null]>([
    ["no observation", null],
    ["an observation at another revision", { revision: "c".repeat(40), entries: [entry("src/t1.test.ts", "2")] }],
    ["an observation missing the added path", { revision: START, entries: [] }],
  ])("refuses %s, changing nothing", (_label, observed) => {
    expect(refusal(baselined(), ADD_TEST, observed)).toMatchObject({ kind: "baseline-unobserved" });
  });

  it("refuses a baseline with no start_sha to read the added files at", () => {
    const unanchored = graph({}, [task("T1", 1, ["src/t1.ts"], { artifact_baseline: [entry("src/t1.ts", "1")] })]);
    expect(rescopeBaselineDuty(unanchored, ADD_TEST)).toBeNull();
    expect(refusal(unanchored, ADD_TEST)).toMatchObject({ kind: "baseline-unobserved", message: expect.stringContaining("no start_sha") });
  });
});

describe("wave_plan_edits on the State File", () => {
  const EDIT = {
    schemaVersion: 1, kind: "task-rescoped", wave: 1, taskId: "T1",
    added: ["src/t1.test.ts"], removed: [], baselineRevision: null, reason: "T1 needs its test file",
  };
  const loaded = (edit: unknown) => parseTaskGraph(JSON.parse(JSON.stringify({ ...graph(), wave_plan_edits: [edit] })));

  it("loads a well-formed edit", () => {
    expect(loaded(EDIT)).toMatchObject({ ok: true, value: { wave_plan_edits: [EDIT] } });
  });

  it.each<[string, Readonly<Record<string, unknown>>, string]>([
    ["an unknown field", { ...EDIT, extra: 1 }, "unknown field(s): extra"],
    ["a wrong kind", { ...EDIT, kind: "task-added" }, "invalid schema or kind"],
    ["a Task of another Wave", { ...EDIT, wave: 2 }, "T1 is not a Task of Wave 2"],
    ["an unknown Task", { ...EDIT, taskId: "T9" }, "T9 is not a Task of Wave 1"],
    ["no change", { ...EDIT, added: [] }, "adds and removes nothing"],
    ["a path on both sides", { ...EDIT, removed: ["src/t1.test.ts"] }, "both adds and removes src/t1.test.ts"],
    ["a repeated path", { ...EDIT, added: ["src/a.ts", "src/a.ts"] }, "names src/a.ts twice"],
    ["an absolute path", { ...EDIT, added: ["/etc/passwd"] }, "added[0]"],
    ["paths that are not strings", { ...EDIT, added: [1] }, "must be arrays of paths"],
    ["a reason that is not a string", { ...EDIT, reason: 1 }, "reason must be a string"],
    ["a revision that is no commit id", { ...EDIT, baselineRevision: "HEAD" }, "exact Git commit id or null"],
    ["a revision with nothing added", { ...EDIT, added: [], removed: ["src/t1.ts"], baselineRevision: START }, "must be null when nothing was added"],
    ["a blank reason", { ...EDIT, reason: "  " }, "reason must say why the plan changes"],
    ["an untrimmed reason", { ...EDIT, reason: " why" }, "reason must not start or end with whitespace"],
    ["an over-long reason", { ...EDIT, reason: "r".repeat(MAX_PLAN_EDIT_REASON_LENGTH + 1) }, `reason is at most ${MAX_PLAN_EDIT_REASON_LENGTH} characters`],
  ])("refuses %s", (_label, edit, problem) => {
    const result = loaded(edit);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(problem);
  });

  it("refuses a value that is not an array", () => {
    const result = parseTaskGraph(JSON.parse(JSON.stringify({ ...graph(), wave_plan_edits: {} })));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("wave_plan_edits must be an array") });
  });
});

describe("rescopeTask: a removal must name a listed path", () => {
  it("refuses a removal of a path the Task never listed, so a typo is not read as success", () => {
    expect(refusal(graph(), request("T2", [], ["src/t2-typo.ts"]))).toMatchObject({
      kind: "path-not-removable", message: "src/t2-typo.ts is not in T2's file_list",
    });
  });

  it("treats a removal an earlier re-scope already applied as a replay", () => {
    const req = request("T2", ["src/t2-helper.ts"], ["src/t2.ts"]);
    const once = committed(graph(), req);
    expect(decided(once, req)).toEqual({ kind: "unchanged", taskId: "T2" });
  });
});

describe("rescopeTask: the remaining refusal arms", () => {
  it("refuses a Task of an earlier Wave than the active one", () => {
    expect(refusal({ ...graph(), current_wave: 2 }, ADD_TEST)).toMatchObject({ kind: "completed-wave" });
  });

  it("refuses a Task armed for attestation", () => {
    const state = graph();
    const armed = { ...state, tasks: state.tasks.map((t) => (t.id === "T1" ? { ...t, implementation_attestation: true as const } : t)) };
    expect(refusal(armed as TaskGraph, ADD_TEST)).toMatchObject({ kind: "attested" });
  });

  it("refuses while implementation reservations are active", () => {
    expect(refusal({ ...graph(), executing_tasks: ["T2"] }, ADD_TEST)).toMatchObject({ kind: "implementation-active" });
  });
});

describe("rescopeTask: contracts, export bindings and the Distill Task, on a populated graph", () => {
  const CONTRACT_TYPES = "src/c/contract.ts";
  const ACCEPTANCE = "tests/c.acceptance.test.ts";
  /** T1 writes CT-1 in Wave 1; T2 implements the bound src/T2.ts in Wave 2; population adds the Distill Tasks. */
  function populated(): TaskGraph {
    const roster = parseAuthoredTaskRoster([
      {
        id: "T1", description: "contract", agent: "code-implementer-agent", wave: 1, depends_on: [], spec_anchors: [], spec_contributions: [],
        verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } }, file_list: [CONTRACT_TYPES, ACCEPTANCE],
      },
      {
        id: "T2", description: "impl", agent: "code-implementer-agent", wave: 2, depends_on: ["T1"], spec_anchors: ["FR-001", "AS-001"],
        spec_contributions: [], verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } },
        file_list: ["src/T2.ts", "src/T2-util.ts", "src/T2.test.ts"],
      },
    ]);
    if (!roster.ok) throw new Error(roster.error);
    const result = populateTaskGraph({
      current_phase: "decompose", phase_artifacts: {}, skipped_phases: [], spec_file: "spec.md", plan_file: "plan.md", tasks: [], wave_gates: {},
    }, {
      planTitle: "rescope", validatedPlanFile: "plan.md", tasks: roster.value, verificationManifest: i6RunnerManifest(),
      specIndex: indexedSpec("spec.md", specDefining(["FR-001"], ["AS-001"])), observedSpecFile: "spec.md", force: false,
      proofBoundary: { kind: "absent", cause: "fixture" }, engineRevision: { kind: "not-observed", cause: "fixture" },
      contracts: [{
        id: "CT-1", title: "Contract",
        declaration: {
          kind: "declared", types: { kind: "file", path: CONTRACT_TYPES }, acceptance: [{ path: ACCEPTANCE, anchors: ["AS-001"] }],
          supportedDomain: null, entryPoint: null, statement: "It runs.",
        },
      }],
      invariants: [],
      exportBindings: parseExportBindings("**Export bindings:**\n- `src/T2.ts` — CT-1: run: RunFn\n"),
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.state;
  }

  it("refuses removing a path the plan's export bindings name", () => {
    expect(refusal(populated(), request("T2", ["src/T2-impl.ts"], ["src/T2.ts"]))).toMatchObject({ kind: "path-not-removable", message: expect.stringContaining("bound to CT-1") });
  });

  it("refuses adding a path another Task's contract froze", () => {
    expect(refusal(populated(), request("T2", [ACCEPTANCE]))).toMatchObject({ kind: "path-not-addable", message: expect.stringContaining("frozen by CT-1") });
  });

  it("refuses a re-scope that takes a frozen path from its contract Task", () => {
    expect(refusal(populated(), request("T1", [], [ACCEPTANCE]))).toMatchObject({ kind: "contract-writer" });
  });

  it("refuses the Distill Task, whose scope the engine derives", () => {
    const state = populated();
    const distill = state.tasks.find(isDistillTask);
    if (distill === undefined) throw new Error("population adds a Distill Task");
    expect(refusal(state, request(distill.id, ["src/extra.ts"]))).toMatchObject({ kind: "distill-task" });
  });

  /** T2 with the outcomes a dispatch records: its bound file exists unskeletonized, its helper is unbound. */
  function withOutcomes(): TaskGraph {
    const state = populated();
    return protectedGraphFixture(JSON.parse(JSON.stringify({
      ...state,
      tasks: state.tasks.map((t) => (t.id !== "T2" ? t : {
        ...t,
        skeleton_outcomes: [
          { path: "src/T2.ts", outcome: { kind: "exists-not-skeletonized" } },
          { path: "src/T2-util.ts", outcome: { kind: "no-bound-exports" } },
        ],
      })),
    })));
  }

  it("drops the skeleton outcome of a removed path, keeps the rest, and loads back", () => {
    expect(byId(committed(withOutcomes(), request("T2", [], ["src/T2-util.ts"])), "T2").skeleton_outcomes)
      .toEqual([{ path: "src/T2.ts", outcome: { kind: "exists-not-skeletonized" } }]);
  });

  it("adds a file to a Task that records skeleton outcomes, and the graph loads back", () => {
    expect(byId(committed(withOutcomes(), request("T2", ["src/T2-helper.ts"])), "T2").file_list).toContain("src/T2-helper.ts");
  });

  it("re-scopes a pending Task of the populated graph, which loads back", () => {
    expect(byId(committed(populated(), request("T2", ["src/T2-helper.ts"])), "T2").file_list).toContain("src/T2-helper.ts");
  });
});

describe("taskRescopedEdit: the one constructor of the audit", () => {
  const VALID: TaskRescopedEditInput = { wave: 1, taskId: "T1", added: ["src/a.ts"], removed: [], baselineRevision: null, sealed: [], reason: "why" };
  it("builds a valid edit, omitting an empty sealed list", () => {
    const { sealed: _none, ...expected } = VALID;
    expect(taskRescopedEdit(VALID)).toEqual({ ok: true, value: { schemaVersion: 1, kind: "task-rescoped", ...expected } });
    expect(taskRescopedEdit({ ...VALID, sealed: ["src/a.ts"] })).toMatchObject({ ok: true, value: { sealed: ["src/a.ts"] } });
  });
  it.each<[string, Partial<TaskRescopedEditInput>, string]>([
    ["wave 0", { wave: 0 }, "wave must be an integer >= 1"],
    ["no change", { added: [] }, "adds and removes nothing"],
    ["an overlap", { removed: ["src/a.ts"] }, "both adds and removes src/a.ts"],
    ["a revision with nothing added", { added: [], removed: ["src/a.ts"], baselineRevision: START }, "must be null when nothing was added"],
    ["a revision that is no commit id", { baselineRevision: "HEAD" }, "exact Git commit id or null"],
    ["a blank reason", { reason: "" }, "reason must say why the plan changes"],
    ["a sealed path that is not added", { sealed: ["src/b.ts"] }, "sealed names src/b.ts, which is not added"],
  ])("refuses %s", (_label, overrides, problem) => {
    expect(taskRescopedEdit({ ...VALID, ...overrides })).toMatchObject({ ok: false, error: expect.stringContaining(problem) });
  });
});

describe("rescopeTask: properties", () => {
  it("any committed re-scope lists exactly the old paths minus the removals plus the additions, and loads back", () => {
    const pool = ["src/t1.ts", "src/t1.test.ts", "src/a.ts", "src/b.ts", "src/a.test.ts"];
    fc.assert(fc.property(
      fc.subarray(pool, { minLength: 1 }),
      fc.subarray(pool),
      fc.subarray(pool),
      (start, add, remove) => {
        const adds = add.filter((path) => !remove.includes(path));
        if (adds.length + remove.length === 0) return;
        const state = graph({}, [task("T1", 1, start, { verification_policy: WAIVED })]);
        const result = rescopeTask(state, request("T1", adds, remove), null);
        if (!result.ok) {
          // A removal of a path the Task never listed is refused; otherwise only an emptied list is.
          const unlisted = remove.some((path) => !start.includes(path));
          expect(result.error.kind).toBe(unlisted ? "path-not-removable" : "empty-file-list");
          return;
        }
        expect(remove.every((path) => start.includes(path))).toBe(true);
        const expected = [...start.filter((path) => !remove.includes(path)), ...adds.filter((path) => !start.includes(path))];
        if (result.value.kind === "unchanged") {
          expect(expected).toEqual(start);
          return;
        }
        expect(byId(result.value.graph, "T1").file_list).toEqual(expected);
        expect(parseTaskGraph(JSON.parse(JSON.stringify(result.value.graph))).ok).toBe(true);
      },
    ), { numRuns: 200 });
  });
});
