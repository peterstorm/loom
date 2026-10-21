/**
 * Orchestration Completion (pure): a finished graph has Tasks, every one
 * completed, and no active Wave Gate run; every unmet condition is named.
 */

import { describe, expect, it } from "vitest";
import { completedGraphArchiveLeaf, judgeOrchestrationCompletion } from "../../src/core/orchestration-completion";
import { activeWaveGateFixture, graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const task = (id: string, status: "pending" | "implemented" | "completed") =>
  taskFixture({ id, description: id, wave: 1, depends_on: [], agent: "code-implementer-agent", status });

describe("judgeOrchestrationCompletion", () => {
  it("is complete when every Task is completed and no Wave Gate is active", () => {
    expect(judgeOrchestrationCompletion(graphFixture([task("T1", "completed"), task("T2", "completed")])))
      .toEqual({ kind: "complete", taskCount: 2 });
  });

  it("names every Task that is not completed", () => {
    expect(judgeOrchestrationCompletion(graphFixture([task("T1", "completed"), task("T2", "implemented"), task("T3", "pending")])))
      .toEqual({
        kind: "incomplete",
        reasons: ["Task T2 is implemented, not completed", "Task T3 is pending, not completed"],
      });
  });

  it("refuses while a Wave Gate run is registered as active", () => {
    const graph = { ...graphFixture([task("T1", "completed")]), active_wave_gate: activeWaveGateFixture({ runId: "wg-1", wave: 1, authorityDigest: "a".repeat(64) }) };
    const completion = judgeOrchestrationCompletion(graph);
    expect(completion.kind).toBe("incomplete");
    if (completion.kind === "incomplete") expect(completion.reasons[0]).toBe("Wave Gate run wg-1 is still registered as active");
  });

  it("refuses a graph with no Tasks", () => {
    expect(judgeOrchestrationCompletion(graphFixture([])))
      .toEqual({ kind: "incomplete", reasons: ["the TaskGraph has no Tasks"] });
  });
});

describe("completedGraphArchiveLeaf", () => {
  const at = Date.UTC(2026, 9, 21, 9, 2, 7, 431);

  it("names the issue and a UTC second stamp", () => {
    expect(completedGraphArchiveLeaf({ github_issue: 123 }, at)).toBe("completed_task_graph-issue-123-20261021T090207Z.json");
  });

  it("says when the graph has no issue", () => {
    expect(completedGraphArchiveLeaf({}, at)).toBe("completed_task_graph-no-issue-20261021T090207Z.json");
  });
});
