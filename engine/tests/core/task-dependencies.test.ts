/**
 * Task dependencies (ADR-0081): paths and cycles.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  cycleClosedBy,
  dependencyCycles,
  dependencyPath,
} from "../../src/core/task-dependencies";

const t = (id: string, wave: number, depends_on: readonly string[] = []) => ({ id, wave, depends_on });

describe("dependencyPath and cycleClosedBy", () => {
  const tasks = [t("T1", 1), t("T2", 2, ["T1"]), t("T3", 2, ["T2"]), t("T4", 2)];

  it("finds the edge path from one Task to another", () => {
    expect(dependencyPath(tasks, "T3", "T1")).toEqual(["T3", "T2", "T1"]);
    expect(dependencyPath(tasks, "T1", "T3")).toBeNull();
  });

  it("names the cycle a new edge would close, and none for an edge that closes none", () => {
    expect(cycleClosedBy(tasks, "T2", "T3")).toEqual(["T2", "T3", "T2"]);
    expect(cycleClosedBy(tasks, "T1", "T3")).toEqual(["T1", "T3", "T2", "T1"]);
    expect(cycleClosedBy(tasks, "T4", "T3")).toBeNull();
  });
});

describe("dependencyCycles", () => {
  it("ignores self and unknown edges, which the State File refuses itself", () => {
    expect(dependencyCycles([t("T1", 1, ["T1"]), t("T2", 1, ["T9"])])).toEqual([]);
  });

  it("reports a cycle once, naming its members", () => {
    expect(dependencyCycles([t("T1", 1, ["T2"]), t("T2", 1, ["T3"]), t("T3", 1, ["T1"])])).toEqual([
      "dependency cycle: T1 → T2 → T3 → T1",
    ]);
  });

  it("accepts an acyclic graph with same-Wave and earlier-Wave edges", () => {
    expect(dependencyCycles([t("T1", 1), t("T2", 2, ["T1"]), t("T3", 2, ["T2", "T1"])])).toEqual([]);
  });

  it("never sees a cycle in a graph built only from edges cycleClosedBy admitted (property)", () => {
    const ids = ["T1", "T2", "T3", "T4", "T5"];
    const edge = fc.tuple(fc.constantFrom(...ids), fc.constantFrom(...ids));
    fc.assert(fc.property(fc.array(edge, { maxLength: 20 }), (edges) => {
      let tasks = ids.map((id) => t(id, 1));
      for (const [from, to] of edges) {
        if (from === to || cycleClosedBy(tasks, from, to) !== null) continue;
        tasks = tasks.map((task) => task.id === from && !task.depends_on.includes(to) ? t(task.id, 1, [...task.depends_on, to]) : task);
      }
      expect(dependencyCycles(tasks)).toEqual([]);
    }));
  });
});
