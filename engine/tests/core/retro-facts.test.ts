/**
 * Retro facts, triggers and the status report (ADR-0083): the friction a
 * TaskGraph recorded, per Wave, and when a Wave is worth a retro.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gateRunCount, retroFacts, waveFriction, type WaveFriction } from "../../src/core/retro-facts";
import { describeRetroTrigger, retroSuggestions, waveRetroTriggers } from "../../src/core/retro-triggers";
import { renderRetroStatus, renderWaveDigest, retroStatusReport } from "../../src/core/retro-status";
import { newWaveGate } from "../../src/core/wave-gate-model";
import type { Task, TaskGraph } from "../../src/types";
import { implementationEscalatedTaskFields } from "../fixtures/implementation-escalation";
import { i6PlanTask } from "../fixtures/i6-plan-task";
import { i6RunnerManifest } from "../fixtures/i6-runner-manifest";
import { completedWaveGateFixture, protectedGraphFixture } from "../fixtures/task-lifecycle";

/** Wave 1 completed, Wave 2 active: T1 (Wave 2) escalated, T2 and T3 clean. */
function graph(overrides: Partial<TaskGraph> = {}, tasks?: readonly Task[]): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 2,
    executing_tasks: [],
    verification_manifest: i6RunnerManifest(),
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    tasks: tasks ?? [
      i6PlanTask("T3", 1, ["src/t3.ts", "src/t3.test.ts"], { status: "completed", review_status: "passed" }),
      { ...i6PlanTask("T1", 2, ["src/t1.ts", "src/t1.test.ts"]), ...implementationEscalatedTaskFields() } as Task,
      i6PlanTask("T2", 2, ["src/t2.ts", "src/t2.test.ts"]),
    ],
    wave_gates: { "1": newWaveGate(), "2": newWaveGate() },
    ...overrides,
  });
}

/** A digest with every count zero, for the trigger tables. */
const quiet = (wave: number, progress: WaveFriction["progress"] = "active"): WaveFriction => ({
  wave, progress, gateRuns: { completed: 0, retired: 0, abandoned: 0 },
  waveReopenings: 0, taskReopenings: 0, forwardFixes: 0, forwardFixWithdrawals: 0, planEdits: 0, specTraceAmendments: 0,
  retries: 0, escalations: 0, remediations: 0, infrastructureBlocks: 0, findings: { critical: 0, advisory: 0, refuted: 0 }, tasks: [],
});

describe("retroFacts", () => {
  it("records an escalated Task's receipts and failure kinds in its Wave, and leaves clean Tasks out of the friction list", () => {
    const facts = retroFacts(graph());
    expect(facts.waves.map(({ wave, progress }) => [wave, progress])).toEqual([[1, "completed"], [2, "active"]]);
    const wave2 = facts.waves[1]!;
    expect(wave2).toMatchObject({ retries: 1, escalations: 1, remediations: 0 });
    expect(wave2.tasks.map(({ taskId }) => taskId)).toEqual(["T1"]);
    expect(wave2.tasks[0]!.failureKinds.length).toBeGreaterThan(0);
    expect(facts.waves[0]).toMatchObject({ escalations: 0, gateRuns: { completed: 1, retired: 0, abandoned: 0 }, tasks: [] });
  });

  it("counts an engine moved under the run once, at run level", () => {
    expect(retroFacts(graph()).engineRevisionAdoptions).toBe(0);
  });

  it("sums every Wave's escalations to the run's escalation receipts (property)", () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), (escalated) => {
      const tasks = escalated.map((isEscalated, index) => {
        const task = i6PlanTask(`T${index + 1}`, 2, [`src/t${index + 1}.ts`, `src/t${index + 1}.test.ts`]);
        return (isEscalated && index === 0 ? { ...task, ...implementationEscalatedTaskFields() } : task) as Task;
      });
      const state = graph({}, [i6PlanTask("T99", 1, ["src/t99.ts", "src/t99.test.ts"], { status: "completed", review_status: "passed" }), ...tasks]);
      const total = state.tasks.reduce((sum, task) =>
        sum + (task.implementation_attempt_history ?? []).filter((receipt) => receipt.transition === "escalation-required").length, 0);
      expect(retroFacts(state).waves.reduce((sum, digest) => sum + digest.escalations, 0)).toBe(total);
      expect(waveFriction(state, 2).escalations).toBe(total);
    }));
  });
});

describe("waveRetroTriggers", () => {
  it.each<[string, Partial<WaveFriction>, readonly string[]]>([
    ["a quiet Wave", {}, []],
    ["one Task reopening, the normal way to act on a Finding", { taskReopenings: 1 }, []],
    ["repeated Task reopenings", { taskReopenings: 2 }, ["repeated-reopening"]],
    ["a second Wave Gate run", { gateRuns: { completed: 1, retired: 0, abandoned: 1 } }, ["repeated-wave-gate"]],
    ["a plan edit", { planEdits: 1 }, ["plan-changed"]],
    ["a Forward Fix", { forwardFixes: 1 }, ["plan-changed"]],
  ])("judges %s", (_label, overrides, kinds) => {
    expect(waveRetroTriggers({ ...quiet(2), ...overrides }).map(({ kind }) => kind)).toEqual(kinds);
  });

  it("names every escalated Task", () => {
    const facts = retroFacts(graph());
    expect(waveRetroTriggers(facts.waves[1]!)).toEqual([{ kind: "escalation", taskIds: ["T1"] }]);
  });

  it("joins an engine move to the active Wave's suggestion", () => {
    const suggestions = retroSuggestions({ waves: [quiet(1, "completed"), quiet(2)], engineRevisionAdoptions: 1 });
    expect(suggestions).toEqual([{ wave: 2, triggers: [{ kind: "engine-changed", adoptions: 1 }] }]);
    expect(describeRetroTrigger(suggestions[0]!.triggers[0])).toBe("the engine revision moved 1 time under the run");
  });

  it("counts every Wave Gate run a digest saw", () => {
    expect(gateRunCount({ ...quiet(1), gateRuns: { completed: 1, retired: 1, abandoned: 2 } })).toBe(4);
  });
});

describe("the status retro report", () => {
  it("suggests a retro only for the active Wave and the Wave that completed last", () => {
    const report = retroStatusReport({ ok: true, value: graph() });
    expect(report.kind).toBe("observed");
    if (report.kind !== "observed") return;
    expect(report.suggestions.map(({ wave }) => wave)).toEqual([2]);
    expect(renderRetroStatus(report)).toEqual([
      "- retro:",
      "  - Wave 1 (completed): 1 Wave Gate run",
      expect.stringMatching(/^ {2}- Wave 2 \(active\): 1 retry, 1 escalation/),
      "  - suggested: /retro --wave 2 (terminal escalation of T1)",
    ]);
  });

  it("says it observed nothing when the TaskGraph does not parse", () => {
    const report = retroStatusReport({ ok: false, error: "bad" });
    expect(renderRetroStatus(report)).toEqual(["- retro: not observed (the TaskGraph did not parse)"]);
  });

  it("renders a quiet Wave as having no friction", () => {
    expect(renderWaveDigest(quiet(3, "pending"))).toBe("Wave 3 (pending): no friction recorded");
  });
});
