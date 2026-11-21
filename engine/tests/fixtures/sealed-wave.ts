/**
 * The sealed-Wave scenario the add-task suites share (ADR-0086): Wave 1
 * completed (T1 wrote `src/serve.ts`, T2 wrote `src/recompute.ts`), Wave 2
 * active with T3, a budget judge whose first attempt failed, and an unrelated
 * pending T4. Proven by the State File parser, so it is a graph the engine
 * loads. `legacyForwardFixGraph` is the same run as a State File the retired
 * `add-forward-fix` wrote: fix Task T5 holding T3.
 */
import { newWaveGate } from "../../src/core/wave-gate-model";
import { nonEmpty } from "../../src/core/orchestration-contract";
import { parseTaskId, type TaskId } from "../../src/core/task-id";
import type { ForwardFixAudit, Task, TaskGraph } from "../../src/types";
import { semanticAttemptReceipt } from "./implementation-settlement";
import { completedWaveGateFixture, protectedGraphFixture, satisfiedProof, taskFixture } from "./task-lifecycle";
import { legacyDefaultVerificationManifest } from "../../src/core/verification-manifest";

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
    verification_manifest: legacyDefaultVerificationManifest(),
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

/** A Task id a fixture names, parsed. */
const id = (raw: string): TaskId => {
  const parsed = parseTaskId(raw);
  if (!parsed.ok) throw new Error(`fixture Task id ${raw} is invalid`);
  return parsed.value;
};

/** A non-empty list a fixture names. */
const some = <T>(values: readonly T[]): NonNullable<ReturnType<typeof nonEmpty<T>>> => {
  const list = nonEmpty(values);
  if (list === null) throw new Error("fixture list is empty");
  return list;
};

/** An audit the retired `add-forward-fix` wrote: by default fix Task T5 holding T3 for src/serve.ts. */
export const legacyForwardFixAudit = (
  over: Readonly<{ fixTaskId?: string; heldTaskIds?: readonly string[]; sealedPaths?: readonly string[] }> = {},
): ForwardFixAudit => Object.freeze({
  schemaVersion: 1,
  kind: "forward-fix-added",
  wave: 2,
  fixTaskId: id(over.fixTaskId ?? "T5"),
  heldTaskIds: some((over.heldTaskIds ?? ["T3"]).map(id)),
  sealedPaths: some(over.sealedPaths ?? ["src/serve.ts"]),
  reason: "T3's budget test fails on src/serve.ts",
  abandonedRunId: null,
});

/** `candidate` settled: implemented with a satisfied proof of its file list. */
export const implemented = (candidate: Task): Task =>
  ({ ...candidate, status: "implemented", proof: satisfiedProof(candidate.file_list ?? []) }) as Task;

/** `graph` with Task `taskId` replaced by `change` of it. */
export const withTask = (graph: TaskGraph, taskId: string, change: (candidate: Task) => Task): TaskGraph =>
  ({ ...graph, tasks: graph.tasks.map((candidate) => candidate.id === taskId ? change(candidate) : candidate) });

/** A Distill Task of Wave 2. */
export const distillPass = (taskId: string): Task => taskFixture({
  id: taskId, description: "Distill pass for Wave 2", agent: "distill-agent", wave: 2, depends_on: [],
  file_list: ["src/other.ts"], spec_anchors: [], spec_contributions: [], review_status: "pending",
});

/** The scenario as an older State File carries it: fix Task T5 on the roster and its audit holding T3. */
export function legacyForwardFixGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  const graph = sealedWaveGraph();
  return protectedGraphFixture({
    ...graph,
    tasks: [...graph.tasks, waveTask("T5", 2, ["src/serve.ts", "src/serve.test.ts"])],
    forward_fix_history: [legacyForwardFixAudit()],
    ...overrides,
  });
}
