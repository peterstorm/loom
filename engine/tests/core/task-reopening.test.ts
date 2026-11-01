/**
 * Task Reopening: an implemented Task of the active Wave made dispatchable
 * again so a Wave Gate Finding on it can be fixed, without discarding the
 * Wave's other settled evidence.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseTaskReopeningArgs,
  reopenImplementedTasks,
  type TaskReopening,
  type TaskReopeningRefusal,
  type TaskReopeningRequest,
} from "../../src/core/task-reopening";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { newWaveGate } from "../../src/core/wave-gate-model";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskGraph } from "../../src/types";
import { findingId } from "../fixtures/finding-id";
import { labelledValue, value } from "../fixtures/parse-result";
import {
  createImplementationAttemptAuthority,
  parseImplementationSettlementReceiptId,
} from "../../src/core/implementation-completion";
import { parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import { reopenableWave, type WaveReopeningRefusal } from "../../src/core/task-revalidation";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  protectedGraphFixture,
  satisfiedProof,
  taskFixture,
} from "../fixtures/task-lifecycle";

const ADVISORY = {
  id: findingId("comment-analyzer-1"),
  agent: "comment-analyzer",
  severity: "advisory" as const,
  file: "src/t1.ts",
  line: 3,
  claim: "the comment contradicts the code",
};

const task = (id: string, wave: number, status: "pending" | "implemented", extra: Partial<Task> = {}): Task => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave, depends_on: [],
  file_list: [`src/${id.toLowerCase()}.ts`], spec_anchors: [], spec_contributions: [],
  status,
  ...(status === "implemented" ? { proof: satisfiedProof([`src/${id.toLowerCase()}.ts`]) } : {}),
  review_status: status === "implemented" ? "passed" : "pending",
  review_generation: 2,
  ...extra,
});

/** A genuine active implementation attempt for `taskId` in Wave 1. */
const attempt = (taskId: string) => labelledValue("implementation attempt", createImplementationAttemptAuthority({
  taskId,
  wave: 1,
  semanticAttempt: 1,
  reservationId: `reopening-${taskId}`,
  headSha: "a".repeat(40),
  reservedAt: "2026-10-25T00:00:00.000Z",
  taskScopeBaseline: [],
  dirtySetBaseline: [],
}));

/** A settlement receipt id seeded with no settlement history: an invalid lineage. */
const RECEIPT_ID = value(parseImplementationSettlementReceiptId("c".repeat(64)));

const ABANDONED = activeWaveGateFixture({
  runId: "run.wave-1-abandoned",
  wave: 1,
  authorityDigest: "a".repeat(64),
  revision: 1,
  terminalOutcome: { kind: "terminal-abandoned", reason: "fix the advisory first", supersededBy: null },
});

/** Wave 1 current with implemented T1 (carrying an advisory) and T2, an
 *  abandoned Wave Gate run over it, and pending T3 in Wave 2. */
function paused(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: [],
    tasks: [
      task("T1", 1, "implemented", { findings: [ADVISORY], critical_findings: [], advisory_findings: [ADVISORY.claim] }),
      task("T2", 1, "implemented"),
      task("T3", 2, "pending"),
    ],
    wave_gates: { "1": { ...newWaveGate(), impl_complete: true, tests_passed: true, reviews_complete: true }, "2": newWaveGate() },
    active_wave_gate: ABANDONED,
    ...overrides,
  });
}

const REASON = "comment-analyzer-1: fix the contradicting comment";
/** A request through the operator grammar: Wave 1, T1, `REASON` unless overridden. */
const request = (overrides: Partial<{ wave: number; taskIds: readonly string[]; reason: string }> = {}): TaskReopeningRequest => {
  const parsed = parseTaskReopeningArgs([
    "--wave", String(overrides.wave ?? 1),
    ...(overrides.taskIds ?? ["T1"]).flatMap((id) => ["--task", id]),
    "--reason", overrides.reason ?? REASON,
  ]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const REQUEST = request();

const reopened = (graph: TaskGraph, req = REQUEST): TaskReopening => {
  const result = reopenImplementedTasks(graph, req);
  if (!result.ok) throw new Error(`expected a reopening, got ${result.error.kind}: ${result.error.message}`);
  return result.value;
};
const committed = (graph: TaskGraph, req = REQUEST): TaskGraph => {
  const outcome = reopened(graph, req);
  if (outcome.kind !== "reopened") throw new Error("expected a committed reopening");
  return outcome.graph;
};
const refusal = (graph: TaskGraph, req = REQUEST): TaskReopeningRefusal => {
  const result = reopenImplementedTasks(graph, req);
  if (result.ok) throw new Error(`expected a refusal, got ${result.value.kind}`);
  return result.error;
};
const byId = (graph: TaskGraph, id: string): Task => graph.tasks.find((candidate) => candidate.id === id)!;

describe("parseTaskReopeningArgs", () => {
  it("accepts one wave, repeated distinct tasks and a trimmed reason, in any order", () => {
    expect(parseTaskReopeningArgs(["--reason", "  fix it ", "--task", "T2", "--wave", "3", "--task", "T1"])).toEqual({
      ok: true,
      value: { wave: 3, taskIds: ["T2", "T1"], reason: "fix it" },
    });
  });

  it.each([
    [["--wave", "1", "--task", "T1"], "--reason must say why"],
    [["--wave", "1", "--task", "T1", "--reason", "   "], "--reason must say why"],
    [["--wave", "1", "--task", "T1", "--reason", "x".repeat(513)], "--reason is longer than 512 characters"],
    [["--wave", "1", "--reason", "r"], "--task must name at least one implemented Task"],
    [["--task", "T1", "--reason", "r"], "--wave must name the active Wave"],
    [["--wave", "0", "--task", "T1", "--reason", "r"], "--wave must name the active Wave"],
    [["--wave", "1.5", "--task", "T1", "--reason", "r"], "--wave must name the active Wave"],
    [["--wave", "99999999999999999999", "--task", "T1", "--reason", "r"], "--wave must name the active Wave"],
    [["--wave", "1", "--wave", "1", "--task", "T1", "--reason", "r"], "--wave is given twice"],
    [["--wave", "1", "--task", "T1", "--reason", "r", "--reason", "s"], "--reason is given twice"],
    [["--wave", "1", "--task", "T1", "--task", "T1", "--reason", "r"], "--task T1 is given twice"],
    [["--wave", "1", "--task", "T1", "--task", "T2", "--task", "T2", "--reason", "r"], "--task T2 is given twice"],
    [["--wave", "1", "--task", "not a task", "--reason", "r"], "--task"],
    [["--wave", "1", "--task", "--reason", "r"], "--task needs a value"],
    [["--wave", "1", "--task", "T1", "--reason"], "--reason needs a value"],
    [["--wave", "1", "--task", "T1", "--reason", "r", "--json"], "unknown argument '--json'"],
  ] as const)("refuses %j", (args, problem) => {
    const parsed = parseTaskReopeningArgs(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(problem);
      expect(parsed.error).toContain("Usage: helper orchestration reopen-task");
    }
  });
});

describe("reopenImplementedTasks", () => {
  it("returns the named Task to revalidation, keeps its Findings, and leaves the Wave's other Tasks implemented", () => {
    const outcome = reopened(paused());
    expect(outcome.kind).toBe("reopened");
    if (outcome.kind !== "reopened") return;
    const t1 = byId(outcome.graph, "T1");
    expect(t1).toMatchObject({ status: "pending", revalidation_required: true, review_status: "pending", review_generation: 3 });
    expect(t1.findings).toEqual([ADVISORY]);
    expect(t1.advisory_findings).toEqual([ADVISORY.claim]);
    expect(byId(outcome.graph, "T2").status).toBe("implemented");
    expect(byId(outcome.graph, "T3")).toEqual(byId(paused(), "T3"));
    expect(deriveTaskImplementationDispatch(t1)).toMatchObject({
      kind: "dispatch",
      dispatch: { kind: "initial-implementation", taskId: "T1", semanticAttempt: 1 },
    });
  });

  it("retires the abandoned run's authority, clears the Wave's gate bits, and audits the reopening", () => {
    const outcome = reopened(paused());
    if (outcome.kind !== "reopened") throw new Error("expected a committed reopening");
    expect(outcome.graph.active_wave_gate).toBeUndefined();
    expect(outcome.graph.active_wave_completion_suite).toBeUndefined();
    expect(outcome.graph.wave_gates["1"]).toMatchObject({ impl_complete: false, tests_passed: null, reviews_complete: false });
    expect(outcome.audit).toEqual({
      schemaVersion: 1,
      kind: "implemented-tasks-reopened",
      wave: 1,
      reopenedTaskIds: ["T1"],
      reason: REQUEST.reason,
      abandonedRunId: ABANDONED.runId,
    });
    expect(outcome.graph.task_reopening_history).toEqual([outcome.audit]);
  });

  it("records no abandoned run when no Wave Gate had registered, and audits Tasks in graph order", () => {
    const outcome = reopened(paused({ active_wave_gate: undefined }), request({ taskIds: ["T2", "T1"] }));
    expect(outcome).toMatchObject({ kind: "reopened", audit: { reopenedTaskIds: ["T1", "T2"], abandonedRunId: null } });
  });

  it("round-trips the reopened graph and its audit through the State File parser", () => {
    const graph = committed(paused());
    const parsed = parseTaskGraph(JSON.parse(JSON.stringify(graph)));
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (parsed.ok) expect(parsed.value.task_reopening_history).toEqual(graph.task_reopening_history);
  });

  it("is idempotent: replaying the committed request while its Tasks await re-implementation changes nothing", () => {
    const graph = committed(paused());
    const replay = reopened(graph);
    expect(replay).toEqual({ kind: "already-reopened", audit: graph.task_reopening_history![0] });
    expect(refusal(graph, request({ reason: "a different reason" })).kind).toBe("not-implemented");
  });

  it("stays idempotent once the reopened Task is re-dispatched and holds a reservation", () => {
    const graph = committed(paused());
    const redispatched: TaskGraph = { ...graph, executing_tasks: ["T1"] };
    expect(reopened(redispatched)).toEqual({ kind: "already-reopened", audit: graph.task_reopening_history![0] });
    expect(refusal(redispatched, request({ taskIds: ["T2"] }))).toMatchObject({ kind: "implementation-active" });
  });

  it("reopens again, with a fresh audit, once the reopened Task was re-implemented", () => {
    const first = committed(paused());
    const reimplemented: TaskGraph = {
      ...first,
      tasks: first.tasks.map((entry) => entry.id === "T1" ? task("T1", 1, "implemented", { review_generation: 3 }) : entry),
    };
    const second = committed(reimplemented);
    expect(second.task_reopening_history).toHaveLength(2);
    expect(second.task_reopening_history![1]).toMatchObject({ reopenedTaskIds: ["T1"], abandonedRunId: null });
  });

  it.each<[string, () => TaskGraph, TaskReopeningRequest, TaskReopeningRefusal["kind"], string]>([
    ["outside execute", () => ({ ...paused(), current_phase: "decompose" }), REQUEST, "not-executing", "execute Phase"],
    ["another Wave", () => paused(), request({ wave: 2, taskIds: ["T3"] }), "wrong-wave", "not the active Wave 1"],
    ["a completed Wave", () => ({
      ...paused({ active_wave_gate: undefined }),
      wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    }), REQUEST, "wave-completed", "reopen-completed-wave"],
    ["a live Wave Gate", () => paused({
      active_wave_gate: activeWaveGateFixture({ runId: "run.live", wave: 1, authorityDigest: "b".repeat(64) }),
    }), REQUEST, "live-wave-gate", "helper orchestration abandon"],
    ["an abandoned run naming a successor", () => paused({
      active_wave_gate: activeWaveGateFixture({
        runId: "run.abandoned", wave: 1, authorityDigest: "b".repeat(64), revision: 1,
        terminalOutcome: { kind: "terminal-abandoned", reason: "replaced", supersededBy: "run.successor" },
      }),
    }), REQUEST, "successor-named", "run.successor"],
    ["an executing Task", () => ({ ...paused(), executing_tasks: ["T2"] }), REQUEST, "implementation-active", "T2"],
    ["a Task holding an active implementation attempt", () => ({
      ...paused(),
      tasks: paused().tasks.map((entry) => entry.id === "T2" ? { ...entry, active_implementation_attempt: attempt("T2") } : entry),
    }), REQUEST, "implementation-active", "T2"],
    ["an abandoned run of another Wave", () => paused({
      active_wave_gate: { ...ABANDONED, runId: value(parseOrchestrationRunId("run.wave-0-abandoned")), wave: 2 },
    }), REQUEST, "live-wave-gate", "run.wave-0-abandoned owns Wave 2"],
    ["an unknown Task", () => paused(), request({ taskIds: ["T9"] }), "unknown-task", "T9"],
    ["a Task of another Wave", () => paused(), request({ taskIds: ["T3"] }), "foreign-task", "Wave 2"],
    ["a pending Task", () => ({
      ...paused(),
      tasks: paused().tasks.map((entry) => entry.id === "T1" ? task("T1", 1, "pending") : entry),
    }), REQUEST, "not-implemented", "T1 is pending"],
    ["a lineage that cannot derive a dispatch", () => ({
      ...paused(),
      tasks: paused().tasks.map((entry) => entry.id === "T1"
        ? task("T1", 1, "implemented", { implementation_retry_predecessor_receipt_id: RECEIPT_ID })
        : entry),
    }), REQUEST, "lineage-not-dispatchable", "invalid-retry"],
  ])("refuses %s", (_name, graph, req, kind, detail) => {
    const before = graph();
    const refused = refusal(before, req);
    expect(refused.kind).toBe(kind);
    expect(refused.message).toContain(detail);
  });

  it("reopens exactly the named implemented Tasks of the Wave, for any choice of them", () => {
    const ids = ["T1", "T2", "T4", "T5"] as const;
    const graph = paused({
      tasks: [...ids.map((id) => task(id, 1, "implemented")), task("T3", 2, "pending")],
    });
    fc.assert(fc.property(fc.subarray([...ids], { minLength: 1 }), (chosen) => {
      const outcome = reopened(graph, request({ taskIds: chosen }));
      if (outcome.kind !== "reopened") throw new Error("expected a committed reopening");
      for (const entry of outcome.graph.tasks) {
        const expected = chosen.includes(entry.id as typeof ids[number]) ? "pending" : byId(graph, entry.id).status;
        expect(entry.status).toBe(expected);
      }
      expect(outcome.audit.reopenedTaskIds).toEqual(ids.filter((id) => chosen.includes(id)));
      expect(reopened(outcome.graph, request({ taskIds: chosen })).kind).toBe("already-reopened");
    }));
  });
});

describe("reopenableWave: the one Wave precondition Contract Revision and Task Reopening share", () => {
  const refused = (graph: TaskGraph): WaveReopeningRefusal => {
    const result = reopenableWave(graph);
    if (result.ok) throw new Error("expected a refusal");
    return result.error;
  };

  it("proves the current Wave, naming the abandoned tombstone the transition retires, or none", () => {
    expect(reopenableWave(paused())).toMatchObject({ ok: true, value: { wave: 1, abandonedRunId: ABANDONED.runId } });
    expect(reopenableWave(paused({ active_wave_gate: undefined }))).toMatchObject({ ok: true, value: { wave: 1, abandonedRunId: null } });
  });

  it("refuses outside the execute Phase before anything else", () => {
    expect(refused({ ...paused({ executing_tasks: ["T2"] }), current_phase: "decompose" }))
      .toEqual({ kind: "not-executing", phase: "decompose" });
    expect(refused({ ...paused(), current_wave: undefined })).toMatchObject({ kind: "not-executing" });
  });

  it("refuses a live gate, or an abandoned tombstone of another Wave, before reservations", () => {
    const live = activeWaveGateFixture({ runId: "run.live", wave: 1, authorityDigest: "b".repeat(64) });
    expect(refused(paused({ active_wave_gate: live, executing_tasks: ["T2"] })))
      .toEqual({ kind: "live-wave-gate", runId: "run.live", wave: 1 });
    expect(refused(paused({ active_wave_gate: { ...ABANDONED, wave: 2 } })))
      .toEqual({ kind: "live-wave-gate", runId: ABANDONED.runId, wave: 2 });
  });

  it("refuses executing Tasks, then current-Wave active attempts, each holder once; another Wave's attempt is not its concern", () => {
    // Built unparsed: a parsed graph names every attempting Task in executing_tasks too.
    const withAttempts = (ids: readonly string[], executing: readonly string[] = []): TaskGraph => ({
      ...paused(),
      executing_tasks: [...executing],
      tasks: paused().tasks.map((entry) => ids.includes(entry.id) ? { ...entry, active_implementation_attempt: attempt(entry.id) } : entry),
    });
    expect(refused(withAttempts(["T1", "T2"], ["T2"]))).toEqual({ kind: "implementation-active", holders: ["T2", "T1"] });
    expect(reopenableWave(withAttempts(["T3"])).ok).toBe(true);
  });
});

describe("task_reopening_history on the State File boundary", () => {
  const audit = {
    schemaVersion: 1,
    kind: "implemented-tasks-reopened",
    wave: 1,
    reopenedTaskIds: ["T1"],
    reason: "fix the advisory",
    abandonedRunId: "run.wave-1-abandoned",
  };
  const withHistory = (history: unknown) =>
    parseTaskGraph({ ...JSON.parse(JSON.stringify(paused({ active_wave_gate: undefined }))), task_reopening_history: history });

  it("parses exact audits", () => {
    const parsed = withHistory([audit, { ...audit, abandonedRunId: null }]);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  });

  it.each([
    ["not an array", { ...audit }, "must be an array"],
    ["an unknown field", [{ ...audit, extra: true }], "unknown field(s): extra"],
    ["a wrong kind", [{ ...audit, kind: "completed-wave-reopened-for-review-integrity" }], "invalid schema or kind"],
    ["no reopened Task", [{ ...audit, reopenedTaskIds: [] }], "non-empty array"],
    ["a repeated Task", [{ ...audit, reopenedTaskIds: ["T1", "T1"] }], "more than once"],
    ["a Task of another Wave", [{ ...audit, reopenedTaskIds: ["T3"] }], "T3 is not a Task of Wave 1"],
    ["an untrimmed reason", [{ ...audit, reason: " fix " }], "trimmed non-blank"],
    ["an over-long reason", [{ ...audit, reason: "x".repeat(513) }], "at most 512"],
    ["a malformed run id", [{ ...audit, abandonedRunId: "" }], "abandonedRunId"],
    ["one run in two audits", [audit, audit], "one abandoned Wave Gate run in two audits"],
  ])("refuses %s", (_name, history, problem) => {
    const parsed = withHistory(history);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(problem);
  });
});
