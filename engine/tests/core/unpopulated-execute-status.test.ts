/**
 * Status for an execute graph with no Tasks (issue #50). Graphs written before
 * population became the only way into execute can still be in this state.
 * Status fails closed and names both real recoveries: install the approved
 * graph, or return to decompose. Before this, it said only that execute
 * needed current_wave authority.
 */

import { describe, expect, it } from "vitest";
import {
  UNPOPULATED_EXECUTE_RECOVERY,
  deriveLoomStatusFromParsedGraph,
  renderLoomStatusHuman,
  type StatusDeps,
} from "../../src/core/loom-status";
import type { TaskGraph } from "../../src/types";
import { activeWaveGateFixture, graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const DEPS: StatusDeps = { loadPlanModels: () => ({ kind: "none" }), filePresence: () => ({ ok: true, exists: true }) };

const unpopulated = (overrides: Partial<TaskGraph> = {}): TaskGraph =>
  ({ ...graphFixture([]), current_wave: undefined, wave_gates: {}, phase_artifacts: { decompose: "task_graph" }, ...overrides });

describe("status of an execute graph with no Tasks", () => {
  it.each<readonly [string, TaskGraph]>([
    ["the stranded #50 shape", unpopulated()],
    ["one that still names a current Wave", unpopulated({ current_wave: 1 })],
    ["one with a stale registration", unpopulated({
      current_wave: 1,
      active_wave_gate: activeWaveGateFixture({ runId: "run.old", wave: 1, authorityDigest: "d".repeat(64), terminalOutcome: null }),
    })],
  ])("blocks on %s and names both recoveries", (_name, graph) => {
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, DEPS);
    expect(status.next.action.kind).toBe("blocked");
    expect(status.next.reasons.map(({ kind, message }) => ({ kind, message })))
      .toEqual([{ kind: "authority-unavailable", message: UNPOPULATED_EXECUTE_RECOVERY }]);
    expect(status.facts.tasks.kind).toBe("unavailable");
    const human = renderLoomStatusHuman(status);
    expect(human).toContain("helper populate-task-graph");
    expect(human).toContain("helper set-phase --phase decompose --clear-artifact decompose");
  });

  it("an execute graph with Tasks never reports the unpopulated recovery", () => {
    const task = taskFixture({ id: "T1", description: "T1", agent: "code-implementer-agent", wave: 1, depends_on: [] });
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graphFixture([task]) }, DEPS);
    expect(status.next.reasons.map(({ message }) => message)).not.toContain(UNPOPULATED_EXECUTE_RECOVERY);
  });

  it("a decompose graph with no Tasks is the normal pre-population state, not this recovery", () => {
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: unpopulated({ current_phase: "decompose" }) }, DEPS);
    expect(status.next.reasons.map(({ message }) => message)).not.toContain(UNPOPULATED_EXECUTE_RECOVERY);
  });
});
