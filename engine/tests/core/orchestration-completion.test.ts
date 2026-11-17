/**
 * Orchestration Completion (pure): a finished graph has Tasks, every one
 * completed, and no active Wave Gate run; every unmet condition is named.
 */

import { describe, expect, it } from "vitest";
import {
  completedGraphArchiveLeaf,
  judgeOrchestrationCompletion,
  RETRO_MISSING_REASON,
  renderCompletionRefusal,
} from "../../src/core/orchestration-completion";
import { activeWaveGateFixture, graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import { RUN_RETRO_SKIPPED } from "../fixtures/retro-record";
import type { Task, TaskGraph } from "../../src/types";

/** A graph whose run retro is recorded, so only the conditions under test decide. */
const retroed = (tasks: readonly Task[]): TaskGraph => ({ ...graphFixture([...tasks]), retro_records: RUN_RETRO_SKIPPED });

const task = (id: string, status: "pending" | "implemented" | "completed") =>
  taskFixture({ id, description: id, wave: 1, depends_on: [], agent: "code-implementer-agent", status });

describe("judgeOrchestrationCompletion", () => {
  it("is complete when every Task is completed and no Wave Gate is active", () => {
    expect(judgeOrchestrationCompletion(retroed([task("T1", "completed"), task("T2", "completed")])))
      .toEqual({ kind: "complete" });
  });

  it("refuses a finished run without a run-scope retro, naming how to record or skip it (ADR-0083)", () => {
    expect(judgeOrchestrationCompletion(graphFixture([task("T1", "completed")])))
      .toEqual({ kind: "incomplete", reasons: [RETRO_MISSING_REASON] });
    const waveOnly: TaskGraph = {
      ...graphFixture([task("T1", "completed")]),
      retro_records: [{ schemaVersion: 1, kind: "retro-recorded", scope: { kind: "wave", wave: 1 }, path: ".claude/retros/w1.md", digest: "a".repeat(64) }],
    };
    expect(judgeOrchestrationCompletion(waveOnly).kind).toBe("incomplete");
  });

  it("names every Task that is not completed", () => {
    expect(judgeOrchestrationCompletion(retroed([task("T1", "completed"), task("T2", "implemented"), task("T3", "pending")])))
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
    expect(judgeOrchestrationCompletion(retroed([])))
      .toEqual({ kind: "incomplete", reasons: ["the TaskGraph has no Tasks"] });
  });
});

describe("renderCompletionRefusal", () => {
  it("lists every reason and both ways forward", () => {
    expect(renderCompletionRefusal("active_task_graph.json", ["Task T2 is implemented, not completed", "the TaskGraph has no Tasks"]))
      .toBe([
        "complete-orchestration: refusing — the orchestration is not finished (active_task_graph.json left in place):",
        "  - Task T2 is implemented, not completed",
        "  - the TaskGraph has no Tasks",
        "Finish the remaining Waves, or abort deliberately with `helper cleanup-state`.",
      ].join("\n"));
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
