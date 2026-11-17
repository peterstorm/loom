/**
 * Task re-scoping (loom#198, Cause 3): a pending Task's file_list repaired in
 * place, keeping every invariant population checks, audited as a
 * `WavePlanEdit`. Every committed graph is round-tripped through the State
 * File parser, so a re-scope that would load back corrupt fails here.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_RESCOPE_REASON_LENGTH,
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
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import { taskArtifactExpectation } from "../../src/core/task-artifact-expectation";
import { taskVerificationPolicy } from "../../src/core/verification-policy";
import { activeWaveGateFixture, completedWaveGateFixture, protectedGraphFixture, satisfiedProof, taskFixture } from "../fixtures/task-lifecycle";

const START = "b".repeat(40);
const REQUIRED = { regression: { kind: "required" as const }, new_tests: { kind: "required" as const } };
const WAIVED = { regression: { kind: "required" as const }, new_tests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const } };

const snapshot = (byte: string): DeclaredArtifactBaseline["snapshot"] => ({ kind: "sha256", digest: byte.repeat(64) });
const entry = (artifact: string, byte: string): DeclaredArtifactBaseline => ({ artifact, snapshot: snapshot(byte) });

/** A Task under the I6-era manifest: a pending one carries the Proof population derives for it there. */
const task = (id: string, wave: number, fileList: readonly string[], extra: Partial<Task> = {}): Task => {
  const base = taskFixture({
    id, description: id, agent: "code-implementer-agent", wave, depends_on: [],
    file_list: [...fileList], spec_anchors: [], spec_contributions: [],
    verification_policy: REQUIRED, status: "pending", review_status: "pending",
    ...extra,
  });
  return base.status !== "pending" || extra.proof !== undefined ? base : {
    ...base,
    proof: derivePendingTaskProof({
      verificationPolicy: taskVerificationPolicy(base),
      declaredArtifacts: base.file_list ?? [],
      declaredArtifactExpectation: taskArtifactExpectation(base),
      redThenGreen: "owed-if-new-tests",
    }),
  };
};

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
      value: { taskId: "T1", add: ["src/a.test.ts"], remove: ["src/a.ts"], reason: "scope" },
    });
  });

  it.each([
    [["--task", "T1", "--reason", "r"], "name at least one --add-file or --remove-file"],
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
    expect(at(MAX_RESCOPE_REASON_LENGTH).ok).toBe(true);
    expect(at(MAX_RESCOPE_REASON_LENGTH + 1).ok).toBe(false);
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

  it("refuses a path a completed Wave's Task lists, pointing at a Forward Fix", () => {
    const sealed = graph({
      current_wave: 2,
      wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    }, [
      task("T1", 1, ["src/t1.ts", "src/t1.test.ts"], { status: "implemented", proof: satisfiedProof(["src/t1.ts", "src/t1.test.ts"], "owed-if-new-tests"), review_status: "passed" }),
      task("T3", 2, ["src/t3.ts", "src/t3.test.ts"]),
    ]);
    expect(refusal(sealed, request("T3", ["src/t1.ts"]))).toMatchObject({ kind: "path-not-addable", message: expect.stringContaining("Forward Fix") });
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
    expect(after.wave_plan_edits?.[0]?.baselineRevision).toBe(START);
  });

  it("drops a removed path's baseline entry", () => {
    const two = graph({}, [task("T1", 1, ["src/t1.ts", "src/t1.test.ts", "src/old.ts"], {
      artifact_baseline: [entry("src/t1.ts", "1"), entry("src/t1.test.ts", "2"), entry("src/old.ts", "3")], start_sha: START,
    })]);
    const after = committed(two, request("T1", [], ["src/old.ts"]));
    expect(byId(after, "T1").artifact_baseline).toEqual([entry("src/t1.ts", "1"), entry("src/t1.test.ts", "2")]);
    expect(after.wave_plan_edits?.[0]?.baselineRevision).toBeNull();
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
    ["an absolute path", { ...EDIT, added: ["/etc/passwd"] }, "wave_plan_edits[0].added[0]"],
    ["a revision that is no commit id", { ...EDIT, baselineRevision: "HEAD" }, "exact Git commit id or null"],
    ["a revision with nothing added", { ...EDIT, added: [], removed: ["src/t1.ts"], baselineRevision: START }, "must be null when nothing was added"],
    ["a blank reason", { ...EDIT, reason: "  " }, "reason must be a trimmed non-blank string"],
    ["an over-long reason", { ...EDIT, reason: "r".repeat(MAX_RESCOPE_REASON_LENGTH + 1) }, "reason must be a trimmed non-blank string"],
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
          expect(["empty-file-list"]).toContain(result.error.kind);
          return;
        }
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
