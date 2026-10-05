/**
 * The pure settlement core, exercised without a store: every reducer here is
 * the exact callback the shell runs under `TaskGraphStore.updateAndReturn`.
 */

import { describe, expect, it } from "vitest";
import type { TaskGraph } from "../../src/types";
import { taskFixture } from "../fixtures/task-lifecycle";
import {
  outcome,
  resolveImplementationTaskId,
  retireCompletedOrMissingImplementation,
  transcriptTextOf,
} from "../../../pi/subagent-settlement";

describe("resolveImplementationTaskId", () => {
  const base = {
    agentType: "code-implementer-agent",
    reservedAuthority: null,
    resultPrompt: "",
    parentPrompt: "",
    executingTasks: [],
  };

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

describe("retireCompletedOrMissingImplementation", () => {
  const graph = (status: "pending" | "completed"): TaskGraph => ({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: ["T1"],
    tasks: [taskFixture({
      id: "T1", description: "implementation", agent: "code-implementer-agent",
      wave: 1, status, depends_on: [], file_list: [],
    })],
    wave_gates: {},
  });

  it("retires a legacy reservation for a completed or missing Task without touching its input", () => {
    const completed = graph("completed");
    const retired = retireCompletedOrMissingImplementation(completed, "T1", { implementationAuthority: null });
    expect(retired.retired).toBe(true);
    expect(retired.state.executing_tasks).toEqual([]);
    expect(completed.executing_tasks).toEqual(["T1"]);

    const missing = retireCompletedOrMissingImplementation(graph("pending"), "T9", { implementationAuthority: null });
    expect(missing.retired).toBe(true);
    expect(missing.state.executing_tasks).toEqual(["T1"]);
  });

  it("keeps a still-pending Task's reservation", () => {
    const pending = graph("pending");
    expect(retireCompletedOrMissingImplementation(pending, "T1", { implementationAuthority: null }))
      .toEqual({ state: pending, retired: false });
  });
});

describe("transcriptTextOf", () => {
  it("joins only assistant and tool-result text, in order", () => {
    expect(transcriptTextOf([
      { role: "user", content: [{ type: "text", text: "prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "opaque", originalType: "thinking" }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "b" }] },
      { role: "other", originalRole: "custom", content: [{ type: "text", text: "ignored" }] },
    ])).toBe("a\nb");
  });
});

describe("outcome", () => {
  it("is frozen data with an empty default", () => {
    const empty = outcome();
    expect(empty).toEqual({ processingErrors: [], log: [] });
    expect(Object.isFrozen(empty) && Object.isFrozen(empty.log) && Object.isFrozen(empty.processingErrors)).toBe(true);
  });
});
