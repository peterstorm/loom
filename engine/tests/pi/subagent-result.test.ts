import { describe, expect, it } from "vitest";
import type { TaskGraph } from "../../src/types";
import {
  applyFailedPiResult,
  applyPhaseAgentPiResult,
  applyReviewPiResult,
  applySpecCheckPiResult,
  resolveImplementationTaskId,
  writtenPathsOf,
  type PiSubagentResult,
  type TaskGraphStore,
} from "../../../pi/subagent-result";

/**
 * The concerns the Pi `tool_result` handler used to hold inline, exercised
 * through their ports.
 *
 * Every case here runs with an in-memory `TaskGraphStore` and no repository:
 * that is the whole point of the split. Before it, asserting "a malformed
 * transcript does not advance the phase" meant standing up a real StateManager,
 * a real git root, and a ~980-line closure whose unrelated branches all had to
 * be survivable first.
 */

const NOW = "2026-08-16T00:00:00.000Z";

function graph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_dir: null,
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: [],
    wave_gates: {},
    tasks: [{
      id: "T1",
      description: "a task",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      review_status: "pending",
      file_list: ["engine/src/x.ts"],
    }],
    ...overrides,
  } as TaskGraph;
}

/** An in-memory stand-in for StateManager: load, mutate, keep. */
function fakeStore(initial: TaskGraph): TaskGraphStore & { current: () => TaskGraph } {
  let state = initial;
  return {
    load: () => state,
    update: async (mutate) => { state = mutate(state); },
    current: () => state,
  };
}

const result = (overrides: Partial<PiSubagentResult> = {}): PiSubagentResult => ({
  agent: "code-reviewer",
  task: "Task: T1",
  exitCode: 0,
  messages: [],
  ...overrides,
});

const assistantText = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];

let toolCallSeq = 0;
const writeCall = (path: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: `call-${(toolCallSeq += 1)}`, name: "write", arguments: { path } }],
});

describe("writtenPathsOf", () => {
  it("reads write/Write tool-call paths in order and ignores everything else", () => {
    expect(writtenPathsOf([
      writeCall("a.md"),
      { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { path: "b.md" } }] },
      { role: "user", content: [{ type: "toolCall", id: "c3", name: "write", arguments: { path: "c.md" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "c4", name: "Write", arguments: { file_path: "d.md" } }] },
    ] as never)).toEqual(["a.md", "d.md"]);
  });
});

describe("resolveImplementationTaskId", () => {
  const base = { agentType: "code-implementer-agent", resultPrompt: "", parentPrompt: "", executingTasks: [] };

  it("prefers the reservation over either prompt", () => {
    expect(resolveImplementationTaskId({
      ...base,
      reservedTaskId: "T9",
      resultPrompt: "Task ID: T1",
      parentPrompt: "Task ID: T2",
    })).toEqual({ kind: "bound", taskId: "T9", inferred: false });
  });

  it("falls back to the result prompt, then the parent prompt", () => {
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, resultPrompt: "Task ID: T1" }))
      .toEqual({ kind: "bound", taskId: "T1", inferred: false });
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, parentPrompt: "Task ID: T2" }))
      .toEqual({ kind: "bound", taskId: "T2", inferred: false });
  });

  it("infers a single executing task, and refuses an ambiguous or empty set", () => {
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, executingTasks: ["T5"] }))
      .toEqual({ kind: "bound", taskId: "T5", inferred: true });
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, executingTasks: ["T5", "T6"] }))
      .toMatchObject({ kind: "unbound", reason: expect.stringContaining("ambiguous") });
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, executingTasks: [] }))
      .toMatchObject({ kind: "unbound", reason: expect.stringContaining("executing_tasks is empty") });
  });
});

describe("applyPhaseAgentPiResult", () => {
  it("records a spec written inside the run's spec_dir", async () => {
    const store = fakeStore(graph({ current_phase: "specify", spec_dir: ".claude/specs/run" } as Partial<TaskGraph>));
    const applied = await applyPhaseAgentPiResult({
      store,
      agentType: "specify-agent",
      completedPhase: "specify",
      result: result({ agent: "specify-agent", messages: [writeCall(".claude/specs/run/spec.md")] }),
      now: NOW,
    });

    expect(applied.processingErrors).toEqual([]);
    expect(store.current().spec_file).toBe(".claude/specs/run/spec.md");
  });

  it("does NOT record a traversal path the substring test used to accept", async () => {
    const store = fakeStore(graph({ current_phase: "specify", spec_dir: ".claude/specs/run" } as Partial<TaskGraph>));
    await applyPhaseAgentPiResult({
      store,
      agentType: "specify-agent",
      completedPhase: "specify",
      result: result({
        agent: "specify-agent",
        messages: [writeCall(".claude/specs/run/../../../../tmp/evil/spec.md")],
      }),
      now: NOW,
    });

    expect(store.current().spec_file).toBeNull();
  });

  it("reports a malformed envelope and advances nothing", async () => {
    const store = fakeStore(graph({ current_phase: "specify" }));
    const applied = await applyPhaseAgentPiResult({
      store,
      agentType: "specify-agent",
      completedPhase: "specify",
      result: result({ agent: "specify-agent", messages: [{ role: 42 }] }),
      now: NOW,
    });

    expect(applied.processingErrors).toHaveLength(1);
    expect(applied.processingErrors[0]).toContain("phase artifact extraction failed");
    expect(store.current().current_phase).toBe("specify");
    expect(store.current().spec_file).toBeNull();
  });
});

describe("applyFailedPiResult", () => {
  it("stores an evidence failure against the reviewer's task", async () => {
    const store = fakeStore(graph());
    const applied = await applyFailedPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ exitCode: 1 }),
      reservedSlot: { agentType: "code-reviewer", taskId: "T1" },
      now: NOW,
    });

    expect(store.current().tasks[0]!.review_status).toBe("evidence_capture_failed");
    expect(applied.processingErrors).toEqual([]);
    expect(applied.log.join("\n")).toContain("T1");
  });

  it("says so and stores nothing when the reviewer names no known task", async () => {
    const store = fakeStore(graph());
    const applied = await applyFailedPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ exitCode: 1, task: "no task id here" }),
      reservedSlot: undefined,
      now: NOW,
    });

    expect(store.current().tasks[0]!.review_status).toBe("pending");
    expect(applied.log.join("\n")).toContain("review evidence NOT stored");
  });

  it("marks a failed spec-check as evidence_capture_failed", async () => {
    const store = fakeStore(graph());
    await applyFailedPiResult({
      store,
      agentType: "spec-check-invoker",
      result: result({ agent: "spec-check-invoker", exitCode: 1 }),
      reservedSlot: undefined,
      now: NOW,
    });

    expect(store.current().spec_check).toMatchObject({ verdict: "EVIDENCE_CAPTURE_FAILED", wave: 1 });
  });
});

describe("applyReviewPiResult", () => {
  const machineSummary = [
    "### Machine Summary",
    "CRITICAL_COUNT: 1",
    "ADVISORY_COUNT: 0",
    "CRITICAL: a real blocker",
  ].join("\n");

  it("stores findings against the named task", async () => {
    const store = fakeStore(graph());
    await applyReviewPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ messages: assistantText(machineSummary) }),
      reservedSlot: { agentType: "code-reviewer", taskId: "T1" },
      parentPrompt: "",
    });

    expect(store.current().tasks[0]).toMatchObject({
      review_status: "blocked",
      critical_findings: ["a real blocker"],
    });
  });

  it("refuses a task id the graph does not hold instead of reporting a silent store", async () => {
    const store = fakeStore(graph());
    const applied = await applyReviewPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ task: "Task: T77", messages: assistantText(machineSummary) }),
      reservedSlot: undefined,
      parentPrompt: "",
    });

    expect(applied.log.join("\n")).toContain("is not in the task graph");
    expect(store.current().tasks[0]!.review_status).toBe("pending");
  });

  it("records an evidence failure for malformed reviewer messages", async () => {
    const store = fakeStore(graph());
    await applyReviewPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ messages: [{ role: 42 }] }),
      reservedSlot: { agentType: "code-reviewer", taskId: "T1" },
      parentPrompt: "",
    });

    expect(store.current().tasks[0]!.review_status).toBe("evidence_capture_failed");
  });
});

describe("applySpecCheckPiResult", () => {
  const specCheckText = (critical: number) => [
    "SPEC_CHECK_WAVE: 1",
    `SPEC_CHECK_CRITICAL_COUNT: ${critical}`,
    "SPEC_CHECK_HIGH_COUNT: 0",
    `SPEC_CHECK_VERDICT: ${critical > 0 ? "BLOCKED" : "PASSED"}`,
    ...(critical > 0 ? ["CRITICAL: requirement R1 is unimplemented"] : []),
  ].join("\n");

  it("derives blocked from the stored spec-check rather than asserting it", async () => {
    const store = fakeStore(graph());
    await applySpecCheckPiResult({
      store,
      result: result({ agent: "spec-check-invoker", messages: assistantText(specCheckText(1)) }),
      now: NOW,
    });

    expect(store.current().wave_gates["1"]).toMatchObject({ blocked: true });
  });

  it("leaves the gate unblocked when the spec-check reports no critical", async () => {
    const store = fakeStore(graph());
    await applySpecCheckPiResult({
      store,
      result: result({ agent: "spec-check-invoker", messages: assistantText(specCheckText(0)) }),
      now: NOW,
    });

    expect(store.current().wave_gates["1"]?.blocked ?? false).toBe(false);
  });

  it("marks malformed spec-check messages as evidence_capture_failed", async () => {
    const store = fakeStore(graph());
    await applySpecCheckPiResult({
      store,
      result: result({ agent: "spec-check-invoker", messages: [{ role: 42 }] }),
      now: NOW,
    });

    expect(store.current().spec_check).toMatchObject({ verdict: "EVIDENCE_CAPTURE_FAILED" });
  });
});
