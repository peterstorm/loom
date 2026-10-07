import { describe, expect, it } from "vitest";
import { coverageTasks } from "../../src/core/wave-review-authority";
import { DECISION_RECORD_AGENT } from "../../src/core/model-profiles";
import type { TaskGraph } from "../../src/types";

const graph = {
  tasks: [
    { id: "T13", wave: 8, agent: "code-implementer-agent", spec_anchors: ["FR-001"] },
    { id: "T14", wave: 9, agent: DECISION_RECORD_AGENT, file_list: ["docs/adr/0011.md"] },
    { id: "T15", wave: 9, agent: "code-implementer-agent" },
  ],
} as unknown as TaskGraph;

describe("coverageTasks", () => {
  it("lifts the decision-record role from the Task's Agent, independent of its Wave", () => {
    expect(coverageTasks(graph, 9).map(({ id, inCurrentWave, decisionRecord }) => ({ id, inCurrentWave, decisionRecord })))
      .toEqual([
        { id: "T13", inCurrentWave: false, decisionRecord: false },
        { id: "T14", inCurrentWave: true, decisionRecord: true },
        { id: "T15", inCurrentWave: true, decisionRecord: false },
      ]);
  });
});
