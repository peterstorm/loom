/**
 * The sealed-Wave scenario the add-task suites share (ADR-0084): Wave 1
 * completed (T1 wrote `src/serve.ts`, T2 wrote `src/recompute.ts`), Wave 2
 * active with T3, a budget judge whose first attempt failed, and an unrelated
 * pending T4. Proven by the State File parser, so it is a graph the engine
 * loads. `legacyForwardFixGraph` is the same run as a State File the retired
 * `add-forward-fix` wrote: fix Task T5 holding T3.
 */
import { newWaveGate } from "../../src/core/wave-gate-model";
import type { Task, TaskGraph } from "../../src/types";
import { semanticAttemptReceipt } from "./implementation-settlement";
import { completedWaveGateFixture, protectedGraphFixture, satisfiedProof, taskFixture } from "./task-lifecycle";

/** A pending implementer Task of `wave` owning `file_list`; `extra` replaces any field. */
export const waveTask = (id: string, wave: number, file_list: readonly string[], extra: Partial<Task> = {}): Task => taskFixture({
  id, description: `Implement ${id}`, agent: "code-implementer-agent", wave, depends_on: [],
  file_list, spec_anchors: [], spec_contributions: [], review_status: "pending", review_generation: 0,
  ...extra,
});

/** A Wave 1 Task its completed gate sealed. */
export const sealedTask = (id: string, file_list: readonly string[]): Task =>
  waveTask(id, 1, file_list, { status: "completed", proof: satisfiedProof(file_list), review_status: "passed" });

/** A Wave 2 judge whose first attempt failed, so it is owed the engine-authorized retry. */
export const failedJudge = (id: string, file_list: readonly string[]): Task => ({
  ...waveTask(id, 2, file_list),
  implementation_attempt_history: [semanticAttemptReceipt(id, 1, [])],
  implementation_retry_protocol: 2,
  implementation_retry_history_start: 0,
});

/** The scenario's TaskGraph; `overrides` replace any top-level field. */
export function sealedWaveGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 2,
    executing_tasks: [],
    tasks: [
      sealedTask("T1", ["src/serve.ts"]),
      sealedTask("T2", ["src/recompute.ts"]),
      failedJudge("T3", ["tests/budget.test.ts"]),
      waveTask("T4", 2, ["src/other.ts"]),
    ],
    wave_gates: {
      "1": { ...newWaveGate(), impl_complete: true, tests_passed: true, reviews_complete: true },
      "2": newWaveGate(),
    },
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    ...overrides,
  });
}

/** The audit the retired `add-forward-fix` wrote for fix Task T5, holding T3, as State File JSON. */
export const LEGACY_FORWARD_FIX_AUDIT = Object.freeze({
  schemaVersion: 1,
  kind: "forward-fix-added",
  wave: 2,
  fixTaskId: "T5",
  heldTaskIds: ["T3"],
  sealedPaths: ["src/serve.ts"],
  reason: "T3's budget test fails on src/serve.ts",
  abandonedRunId: null,
});

/** The scenario as an older State File carries it: fix Task T5 on the roster and its audit holding T3. */
export function legacyForwardFixGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  const graph = sealedWaveGraph();
  return protectedGraphFixture({
    ...graph,
    tasks: [...graph.tasks, waveTask("T5", 2, ["src/serve.ts", "src/serve.test.ts"])],
    forward_fix_history: [LEGACY_FORWARD_FIX_AUDIT] as unknown as TaskGraph["forward_fix_history"],
    ...overrides,
  });
}
