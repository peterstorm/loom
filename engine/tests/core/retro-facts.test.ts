/**
 * Retro facts, triggers and the status report (ADR-0083): the friction a
 * TaskGraph recorded, per Wave, and when a Wave is worth a retro.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gateRunCount, retroFacts, waveFriction, type WaveFriction } from "../../src/core/retro-facts";
import { describeRetroTrigger, freshRetroSuggestions, retroSuggestions, waveRetroTriggers } from "../../src/core/retro-triggers";
import { parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import { parseTaskId } from "../../src/core/task-id";
import { reopenedTaskIds } from "../../src/core/task-revalidation";
import { DISTILL_VERIFICATION_POLICY, serializeVerificationPolicy } from "../../src/core/verification-policy";
import { value } from "../fixtures/parse-result";
import { renderRetroStatus, renderWaveDigest, retroStatusReport } from "../../src/core/retro-status";
import { newWaveGate } from "../../src/core/wave-gate-model";
import type { Task, TaskGraph } from "../../src/types";
import { implementationEscalatedTaskFields } from "../fixtures/implementation-escalation";
import { i6PlanTask } from "../fixtures/i6-plan-task";
import { i6RunnerManifest } from "../fixtures/i6-runner-manifest";
import { completedWaveGateFixture, protectedGraphFixture } from "../fixtures/task-lifecycle";

/** Wave 1 completed, Wave 2 active: T1 (Wave 2) escalated, T2 and T3 clean. */
function graph(overrides: Readonly<Record<string, unknown>> = {}, tasks?: readonly Task[]): TaskGraph {
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

  it("counts the engine revision adoptions a pinned run recorded, at run level", () => {
    expect(retroFacts(graph()).engineRevisionAdoptions).toBe(0);
    const revision = (byte: string) => `sha256:${byte.repeat(64)}`;
    const pinned = graph({
      engine_revision: {
        schemaVersion: 1, kind: "pinned", revision: revision("c"),
        adoptions: [{ from: revision("a"), to: revision("b"), reason: "fix landed" }, { from: revision("b"), to: revision("c"), reason: "second fix" }],
      },
    });
    expect(retroFacts(pinned).engineRevisionAdoptions).toBe(2);
  });

  it("counts an abandoned run once across the audits that name it, retired runs, withdrawals, and leaves Distill Tasks out", () => {
    const base = graph();
    const runId = value(parseOrchestrationRunId("w2-gate-1"));
    const t1 = value(parseTaskId("T1"));
    const state: TaskGraph = {
      ...base,
      task_reopening_history: [{ schemaVersion: 1, kind: "implemented-tasks-reopened", wave: 2, reason: "finding", abandonedRunId: runId, ...value(reopenedTaskIds([t1], [])) }],
      forward_fix_history: [{ schemaVersion: 1, kind: "forward-fix-added", wave: 2, fixTaskId: t1, heldTaskIds: [value(parseTaskId("T2"))], sealedPaths: ["src/t3.ts"], reason: "breach", abandonedRunId: runId }],
    };
    const digest = waveFriction(state, 2);
    expect(digest.gateRuns).toEqual({ completed: 0, retired: 0, abandoned: 1 });
    expect(digest).toMatchObject({ taskReopenings: 1, forwardFixes: 1 });
    expect(digest.tasks.find(({ taskId }) => taskId === "T2")).toMatchObject({ heldByForwardFixes: ["T1"] });
    expect(digest.tasks.find(({ taskId }) => taskId === "T1")).toMatchObject({ addedMidRun: true, reopenings: 1 });
    const withDistill = graph({}, [...base.tasks, i6PlanTask("T9", 2, ["src/t1.ts"], {
      agent: "distill-agent", description: "Distill pass", verification_policy: serializeVerificationPolicy(DISTILL_VERIFICATION_POLICY),
    })]);
    expect(waveFriction(withDistill, 2).tasks.map(({ taskId }) => taskId)).not.toContain("T9");
  });

  it("marks a Task add-task appended as addedMidRun, and counts a run its task-added and task-withdrawn edits name once", () => {
    const base = graph();
    const runId = value(parseOrchestrationRunId("w2-gate-1"));
    const state: TaskGraph = {
      ...base,
      wave_plan_edits: [
        { schemaVersion: 1, kind: "task-added", wave: 2, taskId: "T2", files: ["src/t2.ts"], dependsOn: [], dependents: [], reason: "missed", abandonedRunId: runId },
        { schemaVersion: 1, kind: "task-added", wave: 2, taskId: "T7", files: ["src/t7.ts"], dependsOn: [], dependents: [], reason: "missed", abandonedRunId: null },
        { schemaVersion: 1, kind: "task-withdrawn", wave: 2, taskId: "T7", reason: "wrong files", abandonedRunId: runId },
      ],
    };
    const digest = waveFriction(state, 2);
    expect(digest.gateRuns).toEqual({ completed: 0, retired: 0, abandoned: 1 });
    expect(digest.planEdits).toBe(3);
    expect(digest.tasks.find(({ taskId }) => taskId === "T2")).toMatchObject({ addedMidRun: true, heldByForwardFixes: [], planEdits: 1 });
    expect(waveFriction(base, 2).tasks.find(({ taskId }) => taskId === "T2")).toBeUndefined();
  });

  it("sums every Wave's escalations to the run's escalation receipts (property)", () => {
    // Only T1's fixture lineage escalates; the property varies whether it does and how many clean Tasks sit beside it.
    fc.assert(fc.property(fc.boolean(), fc.integer({ min: 0, max: 5 }), (escalates, clean) => {
      const first = i6PlanTask("T1", 2, ["src/t1.ts", "src/t1.test.ts"]);
      const tasks = [
        (escalates ? { ...first, ...implementationEscalatedTaskFields() } : first) as Task,
        ...Array.from({ length: clean }, (_unused, index) => i6PlanTask(`T${index + 2}`, 2, [`src/t${index + 2}.ts`, `src/t${index + 2}.test.ts`])),
      ];
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

  it("suggests only for the active Wave and the Wave that completed last", () => {
    const escalated = (wave: number, progress: WaveFriction["progress"]): WaveFriction => ({
      ...quiet(wave, progress), escalations: 1, tasks: [{ ...retroFacts(graph()).waves[1]!.tasks[0]!, wave }],
    });
    const facts = { waves: [escalated(1, "completed"), escalated(2, "completed"), escalated(3, "active")], engineRevisionAdoptions: 0 };
    expect(retroSuggestions(facts).map(({ wave }) => wave)).toEqual([1, 2, 3]);
    expect(freshRetroSuggestions(facts).map(({ wave }) => wave)).toEqual([2, 3]);
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
      "  - suggested: /retro --wave 2 (escalation of T1)",
    ]);
  });

  it("says it observed nothing when the TaskGraph does not parse", () => {
    const report = retroStatusReport({ ok: false, error: "bad" });
    expect(renderRetroStatus(report)).toEqual(["- retro: not observed (the TaskGraph did not parse: bad)"]);
  });

  it("renders a quiet Wave as having no friction", () => {
    expect(renderWaveDigest(quiet(3, "pending"))).toBe("Wave 3 (pending): no friction recorded");
  });
});
