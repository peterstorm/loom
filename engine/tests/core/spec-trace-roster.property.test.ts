/**
 * The roster match every trace-writing helper relies on: a submitted roster is
 * matched to the protected one exactly and in order, and a matched roster
 * carries every Task's trace — so neither the upgrade nor the amendment can
 * leave a Task unmigrated behind a version stamp.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { matchRoster } from "../../src/core/spec-trace";
import { prepareSpecTraceUpgrade } from "../../src/core/spec-trace-migration";
import type { SpecTraceOwnership, TaskGraph } from "../../src/types";
import { pendingTaskProof } from "../fixtures/task-lifecycle";

const LABEL = "Roster test";

const traceFor = (id: string): SpecTraceOwnership =>
  Object.freeze({ spec_anchors: Object.freeze([`FR-${id}`]), spec_contributions: Object.freeze([]) });

const ownershipOf = (ids: readonly string[]): ReadonlyMap<string, SpecTraceOwnership> =>
  new Map(ids.map((id) => [id, traceFor(id)] as const));

const tasksOf = (ids: readonly string[]) => ids.map((id) => Object.freeze({ id }));

/** Distinct Task ids, the protected roster. */
const rosterIds = fc.uniqueArray(fc.stringMatching(/^T[1-9][0-9]?$/), { minLength: 1, maxLength: 8 });

describe("matchRoster", () => {
  it("pairs every protected Task with its own submitted trace, in roster order, when the roster is exact", () => {
    fc.assert(fc.property(rosterIds, (ids) => {
      const matched = matchRoster(tasksOf(ids), ownershipOf(ids), LABEL);
      expect(matched.ok).toBe(true);
      if (!matched.ok) return;
      expect(matched.value.map(({ task }) => task.id)).toEqual(ids);
      for (const { task, trace } of matched.value) expect(trace).toEqual(traceFor(task.id));
    }));
  });

  it("refuses a roster missing any protected Task and names every missing one", () => {
    fc.assert(fc.property(
      rosterIds.chain((ids) => fc.tuple(fc.constant(ids), fc.subarray(ids, { minLength: 1 }))),
      ([ids, dropped]) => {
        const matched = matchRoster(tasksOf(ids), ownershipOf(ids.filter((id) => !dropped.includes(id))), LABEL);
        expect(matched.ok).toBe(false);
        if (matched.ok) return;
        expect(matched.message).toContain(`${LABEL} roster is stale or partial`);
        expect(matched.message).toContain(`missing existing Tasks: ${ids.filter((id) => dropped.includes(id)).join(", ")}`);
      },
    ));
  });

  it("refuses a roster with a foreign Task", () => {
    fc.assert(fc.property(rosterIds, (ids) => {
      const matched = matchRoster(tasksOf(ids), ownershipOf([...ids, "FOREIGN"]), LABEL);
      expect(matched).toEqual({ ok: false, message: `${LABEL} roster is stale or partial; foreign Tasks: FOREIGN` });
    }));
  });

  it("refuses an exact set of Tasks submitted in another order", () => {
    fc.assert(fc.property(
      rosterIds.filter((ids) => ids.length > 1),
      (ids) => {
        const matched = matchRoster(tasksOf(ids), ownershipOf([...ids].reverse()), LABEL);
        expect(matched).toEqual({ ok: false, message: `${LABEL} roster order must exactly match the protected Task roster` });
      },
    ));
  });
});

function legacyGraph(): TaskGraph {
  const task = (id: string) => ({
    id, description: id, agent: "code-implementer-agent", wave: 1,
    status: "pending" as const, proof: pendingTaskProof(), depends_on: [], spec_anchors: [`FR-${id}`],
    review_status: "pending" as const, findings: [], critical_findings: [], advisory_findings: [],
    refuted_findings: [], resolved_findings: [],
  });
  return {
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: "spec.md",
    plan_file: "plan.md",
    executing_tasks: [],
    wave_gates: {},
    tasks: [task("T1"), task("T2")],
  };
}

describe("prepareSpecTraceUpgrade roster seam", () => {
  it("refuses a roster that omits a Task instead of stamping v2 over an unmigrated Task", () => {
    const upgraded = prepareSpecTraceUpgrade(legacyGraph(), {
      spec_trace_version: 2,
      tasks: [{ id: "T2", spec_anchors: ["FR-T2"], spec_contributions: [] }],
    });
    expect(upgraded).toEqual({
      ok: false,
      error: {
        kind: "spec-trace-upgrade-rejected",
        message: "Spec trace upgrade roster is stale or partial; missing existing Tasks: T1",
      },
    });
  });

  it("migrates every Task of an exact roster", () => {
    const upgraded = prepareSpecTraceUpgrade(legacyGraph(), {
      spec_trace_version: 2,
      tasks: [
        { id: "T1", spec_anchors: ["FR-T1"], spec_contributions: [] },
        { id: "T2", spec_anchors: ["FR-T2"], spec_contributions: [] },
      ],
    });
    expect(upgraded.ok).toBe(true);
    if (!upgraded.ok) return;
    expect(upgraded.value.graph.spec_trace_version).toBe(2);
    expect(upgraded.value.graph.tasks.map(({ id, spec_contributions }) => [id, spec_contributions])).toEqual([
      ["T1", []],
      ["T2", []],
    ]);
  });
});
