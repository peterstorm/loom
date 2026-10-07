import { describe, expect, it } from "vitest";
import type { SpawnAdmission } from "../../src/core/spawn-admission";
import { prepareSpawnBatch, type SpawnPreparationPorts } from "../../../pi/spawn-preparation";
import type { SpawnBatchGraphObservation } from "../../../pi/spawn-graph";

type Call = Readonly<{ port: string; detail: unknown }>;

/** Plain fakes for every port, recording the order the pipeline calls them in. */
function fakePorts(overrides: Partial<{
  observed: SpawnBatchGraphObservation;
  runtimeActive: boolean;
  admission: SpawnAdmission;
  renderFails: boolean;
}> = {}): { ports: SpawnPreparationPorts; calls: Call[] } {
  const calls: Call[] = [];
  const ports: SpawnPreparationPorts = {
    observeGraph: (input) => {
      calls.push({ port: "observeGraph", detail: structuredClone(input) });
      return overrides.observed ?? { kind: "runtime" };
    },
    runtimeGraph: {
      active: overrides.runtimeActive ?? false,
      path: () => {
        calls.push({ port: "runtimeGraphPath", detail: null });
        return "/runtime/.claude/state/active_task_graph.json";
      },
    },
    renderBrief: (graphPath, taskId) => {
      calls.push({ port: "renderBrief", detail: { graphPath, taskId } });
      return overrides.renderFails
        ? { ok: false, error: `Task ${taskId} is not owed a dispatch` }
        : {
            ok: true,
            value: {
              taskId,
              agent: "code-implementer-agent",
              dispatch: { kind: "initial-implementation", taskId, semanticAttempt: 1, promptAppendix: null },
              prompt: `rendered ${taskId}`,
            },
          };
    },
    rewriteTask: (slot, task) => {
      calls.push({ port: "rewriteTask", detail: { slot, task } });
    },
    admit: (input, graph) => {
      calls.push({ port: "admit", detail: { input: structuredClone(input), graph } });
      return overrides.admission ?? { kind: "pass-through" };
    },
  };
  return { ports, calls };
}

const markerBatch = (): Record<string, unknown> => ({
  tasks: [
    { agent: "code-reviewer", task: "Review T4." },
    { agent: "code-implementer-agent", task: "LOOM_IMPLEMENTATION_BRIEF: T5" },
  ],
});

describe("prepareSpawnBatch", () => {
  it("observes, then expands against the observed graph, then admits — in that order", () => {
    const { ports, calls } = fakePorts({ observed: { kind: "spawn", graphPath: "/worktree/graph.json" } });
    const input = markerBatch();
    expect(prepareSpawnBatch(input, ports)).toEqual({ kind: "pass-through" });
    expect(calls.map(({ port }) => port)).toEqual(["observeGraph", "renderBrief", "rewriteTask", "admit"]);
    expect(calls[1]!.detail).toEqual({ graphPath: "/worktree/graph.json", taskId: "T5" });
    expect(calls[2]!.detail).toEqual({ slot: 1, task: "rendered T5" });
  });

  it("lets a spawn-cwd graph govern the batch without resolving the runtime graph", () => {
    const admission: SpawnAdmission = { kind: "admit", itemAdmissions: [], needsTaskGraphLifecycle: true };
    const { ports, calls } = fakePorts({ observed: { kind: "spawn", graphPath: "/worktree/graph.json" }, admission });
    const prepared = prepareSpawnBatch({ agent: "code-reviewer", task: "Review." }, ports);
    expect(prepared).toEqual({
      kind: "admit",
      graph: { active: true, path: "/worktree/graph.json", spawnGraphPath: "/worktree/graph.json" },
      admission,
    });
    expect(calls.map(({ port }) => port)).not.toContain("runtimeGraphPath");
  });

  it("falls back to the runtime graph's polarity and path when no spawn graph governs", () => {
    const admission: SpawnAdmission = { kind: "admit", itemAdmissions: [], needsTaskGraphLifecycle: false };
    for (const runtimeActive of [true, false]) {
      const { ports } = fakePorts({ runtimeActive, admission });
      expect(prepareSpawnBatch({ agent: "code-reviewer", task: "Review." }, ports)).toEqual({
        kind: "admit",
        graph: { active: runtimeActive, path: "/runtime/.claude/state/active_task_graph.json", spawnGraphPath: null },
        admission,
      });
    }
  });

  it("refuses a batch whose items diverge in graph authority before expanding or admitting anything", () => {
    const { ports, calls } = fakePorts({ observed: { kind: "diverged", reason: "items resolve to diverging graphs" } });
    expect(prepareSpawnBatch(markerBatch(), ports)).toEqual({
      kind: "block",
      guard: "parse-pi-subagent-batch",
      reason: "BLOCKED: items resolve to diverging graphs.",
    });
    expect(calls.map(({ port }) => port)).toEqual(["observeGraph"]);
  });

  it("refuses an unrenderable brief before admission, with no rewrite applied", () => {
    const { ports, calls } = fakePorts({ renderFails: true });
    expect(prepareSpawnBatch(markerBatch(), ports)).toEqual({
      kind: "block",
      guard: "implementation-brief-expansion",
      reason: "BLOCKED: spawn item 2 cannot expand its implementation brief: Task T5 is not owed a dispatch",
    });
    expect(calls.map(({ port }) => port)).toEqual(["observeGraph", "runtimeGraphPath", "renderBrief"]);
  });

  it("carries the admission core's own block guard and reason", () => {
    const { ports } = fakePorts({ admission: { kind: "block", guard: "agent-scope", reason: "scope refused" } });
    expect(prepareSpawnBatch(markerBatch(), ports)).toEqual({ kind: "block", guard: "agent-scope", reason: "scope refused" });
  });

  it("names the guard that was executing when a port crashes", () => {
    const boom = new Error("disk gone");
    const crashingObserve = fakePorts();
    expect(prepareSpawnBatch(markerBatch(), {
      ...crashingObserve.ports,
      observeGraph: () => { throw boom; },
    })).toEqual({ kind: "crashed", guard: "parse-pi-subagent-batch", cause: boom });

    const crashingRewrite = fakePorts();
    expect(prepareSpawnBatch(markerBatch(), {
      ...crashingRewrite.ports,
      rewriteTask: () => { throw boom; },
    })).toEqual({ kind: "crashed", guard: "implementation-brief-expansion", cause: boom });

    // Admission work before any I/O port stamps a gate stays attributed to the
    // expansion stage, exactly like the routing-context read the shell does there.
    const crashingAdmissionSetup = fakePorts();
    expect(prepareSpawnBatch(markerBatch(), {
      ...crashingAdmissionSetup.ports,
      admit: () => { throw boom; },
    })).toEqual({ kind: "crashed", guard: "implementation-brief-expansion", cause: boom });

    const crashingAdmissionPort = fakePorts();
    expect(prepareSpawnBatch(markerBatch(), {
      ...crashingAdmissionPort.ports,
      admit: (_input, _graph, enterGuard) => {
        enterGuard("validate-phase-order");
        throw boom;
      },
    })).toEqual({ kind: "crashed", guard: "validate-phase-order", cause: boom });
  });
});
