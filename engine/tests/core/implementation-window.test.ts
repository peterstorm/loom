/**
 * The implementation window's policy, tested at its own seam: one pure
 * classifier from a protected graph and the reservation-liveness observation
 * to a closed outcome, without deriving any status around it.
 */
import { describe, expect, it } from "vitest";
import { classifyImplementationWindow, type ImplementationReservationStatusObservation } from "../../src/core/implementation-window";
import type { Task, TaskGraph } from "../../src/types";
import { activeWaveGateFixture, completedWaveGateFixture, graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const abandoned = (supersededBy: string | null) => ({ kind: "terminal-abandoned", reason: "exhausted", supersededBy });
const gate = (terminalOutcome: unknown) =>
  activeWaveGateFixture({ runId: "run.old", wave: 1, authorityDigest: "d".repeat(64), terminalOutcome });

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const observed = (anyActiveForGraph: boolean): ImplementationReservationStatusObservation =>
  ({ kind: "observed", observedAtMs: NOW, anyActiveForGraph });

const task = (id: string, overrides: Partial<Parameters<typeof taskFixture>[0]> = {}): Task => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave: 1, depends_on: [], file_list: [`src/${id}.ts`], ...overrides,
});
const executing = (graph: TaskGraph, ids: readonly string[]): TaskGraph => ({ ...graph, executing_tasks: [...ids] });

describe("classifyImplementationWindow", () => {
  describe("outside the window", () => {
    it.each<readonly [string, TaskGraph]>([
      ["no current Wave", { ...graphFixture([task("T1")]), current_wave: undefined }],
      ["a current Wave without Tasks", graphFixture([task("T1", { wave: 2 })])],
      ["terminal history for the current Wave",
        { ...graphFixture([task("T1")]), wave_gate_history: [completedWaveGateFixture({ runId: "run.done", wave: 1 })] }],
      ["a live registration", { ...graphFixture([task("T1")]), active_wave_gate: gate(null) }],
      ["an abandoned registration that names a successor",
        { ...graphFixture([task("T1")]), active_wave_gate: gate(abandoned("run.next")) }],
      ["a registration for another Wave",
        { ...graphFixture([task("T1")]), active_wave_gate: activeWaveGateFixture({
          runId: "run.old", wave: 2, authorityDigest: "d".repeat(64), terminalOutcome: abandoned(null) }) }],
    ])("is not in the window with %s", (_name, graph) => {
      expect(classifyImplementationWindow(graph, observed(false))).toEqual({ kind: "not-in-window" });
    });
  });

  it("dispatches a pending Task and names it pending", () => {
    const window = classifyImplementationWindow(graphFixture([task("T1")]), observed(false));
    expect(window).toMatchObject({
      kind: "window", wave: 1, pendingTaskIds: ["T1"], activeTaskIds: [], escalated: [],
      recovery: { kind: "spawn-wave-implementation", wave: 1, dispatches: [{ taskId: "T1" }] },
    });
  });

  it("stays inside the window under an abandoned registration with no successor", () => {
    const graph: TaskGraph = { ...graphFixture([task("T1")]), active_wave_gate: gate(abandoned(null)) };
    expect(classifyImplementationWindow(graph, observed(false)).kind).toBe("window");
  });

  it("awaits a live reservation and never dispatches it", () => {
    const graph = executing(graphFixture([task("T1", { reserved_at: new Date(NOW).toISOString() })]), ["T1"]);
    expect(classifyImplementationWindow(graph, observed(true))).toMatchObject({
      kind: "window", activeTaskIds: ["T1"],
      recovery: { kind: "await-wave-implementation", wave: 1, activeTaskIds: ["T1"] },
    });
  });

  it("reclaims a policy-expired reservation and dispatches it again", () => {
    const graph = executing(graphFixture([task("T1", { reserved_at: "2000-01-01T00:00:00.000Z" })]), ["T1"]);
    expect(classifyImplementationWindow(graph, observed(false))).toMatchObject({
      kind: "window", activeTaskIds: [],
      recovery: { kind: "spawn-wave-implementation", dispatches: [{ taskId: "T1" }] },
    });
  });

  it("keeps a reservation active, fail-closed, when liveness was never observed", () => {
    const graph = executing(graphFixture([task("T1", { reserved_at: "2000-01-01T00:00:00.000Z" })]), ["T1"]);
    expect(classifyImplementationWindow(graph, undefined)).toMatchObject({
      kind: "window", recovery: { kind: "await-wave-implementation" },
    });
  });

  it("is unavailable when a reservation exists but liveness is unavailable", () => {
    const graph = executing(graphFixture([task("T1", { reserved_at: new Date(NOW).toISOString() })]), ["T1"]);
    expect(classifyImplementationWindow(graph, { kind: "unavailable", reason: "registry unreadable" })).toEqual({
      kind: "unavailable",
      message: "cannot determine implementation reservation liveness: registry unreadable",
    });
  });

  it.each<readonly [string, TaskGraph, string]>([
    ["a completed Task that retains a reservation",
      executing(graphFixture([task("T1", { status: "completed" })]), ["T1"]),
      "T1 is completed but retains implementation reservation authority; repair the Task Graph"],
    ["a timestamp-less legacy reservation",
      executing(graphFixture([task("T1")]), ["T1"]),
      "T1 has timestamp-less legacy implementation authority that canonical status cannot reclaim; repair or migrate the Task Graph"],
  ])("reports %s as a Task-scoped contradiction", (_name, graph, message) => {
    expect(classifyImplementationWindow(graph, observed(false))).toEqual({
      kind: "contradiction",
      reason: { kind: "authority-contradiction", message, taskId: "T1" },
    });
  });

  it("asks for the Wave Gate, or its start repair, once nothing is outstanding", () => {
    const window = classifyImplementationWindow(graphFixture([task("T1", { status: "implemented" })]), observed(false));
    expect(window.kind).toBe("window");
    if (window.kind !== "window") return;
    expect(["start-wave-gate", "repair-wave-start-readiness"]).toContain(window.recovery.kind);
    expect(window.pendingTaskIds).toEqual([]);
    expect(window.activeTaskIds).toEqual([]);
  });
});
