import { argumentValue } from "./cli-args";
import { StateManager } from "../../state-manager";
import { taskGraphPath } from "../../config";
import { newWaveGate, reconcileWaveBlock } from "../../core/wave-gate-model";
import { derivePendingTaskProof } from "../../core/proof-obligations";
import { parseTaskId } from "../../core/task-id";
import { taskVerificationPolicy } from "../../core/verification-policy";
import { observeReviewedWorkspace } from "./reviewed-workspace";
import { openRunDirectory } from "../../orchestration/run-directory-handle";
import { handleWaveReviewContext, type WaveReviewContextAuthority } from "./programs";
import type { HookHandler, Task, TaskGraph, WaveReopeningAudit } from "../../types";

const USAGE = "Usage: helper reopen-completed-wave --runs-root <root> < exact-reopening.json";

type ReopenRequest = Readonly<{
  runId: string;
  wave: number;
  authorityDigest: string;
  taskIds: readonly string[];
}>;

type WaveReopeningStore = Readonly<{
  updateAndReturn<T>(
    mutate: (state: TaskGraph) => Readonly<{ state: TaskGraph; value: T }>,
  ): Promise<T>;
}>;

export type WaveReopeningProof = Readonly<{
  mode: "modern-exact-workspace-drift" | "legacy-workspace-authority-unverifiable";
  taskIds: readonly string[];
}>;

function parseRequest(raw: string): ReopenRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `reopening payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("reopening payload must be an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["authorityDigest", "runId", "taskIds", "wave"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("reopening payload must contain exactly runId/wave/authorityDigest/taskIds");
  }
  if (typeof record.runId !== "string" || record.runId.trim() === "" ||
      typeof record.wave !== "number" || !Number.isInteger(record.wave) || record.wave < 1 ||
      typeof record.authorityDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.authorityDigest) ||
      !Array.isArray(record.taskIds) || record.taskIds.length === 0 ||
      record.taskIds.some((id) => !parseTaskId(id, "reopening.taskId").ok) ||
      new Set(record.taskIds).size !== record.taskIds.length) {
    throw new Error("reopening payload has invalid run/wave/authority/task ids");
  }
  return Object.freeze({ runId: record.runId, wave: record.wave, authorityDigest: record.authorityDigest, taskIds: Object.freeze([...record.taskIds] as string[]) });
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Pure, conservative evidence check. A later pending Task is safe only when
 * it is wholly untouched: any reservation, implementation, test/proof, review,
 * packet, finding, recovery, retry, or execution evidence blocks reopening. */
export function hasLaterWaveTaskProgress(task: Task, executingTaskIds: readonly string[]): boolean {
  return executingTaskIds.includes(task.id) ||
    task.status !== "pending" ||
    task.reserved_at !== undefined || task.start_sha !== undefined ||
    task.files_modified !== undefined || task.test_result !== undefined ||
    task.test_evidence !== undefined || task.new_test_observation !== undefined ||
    (task.proof !== undefined && task.proof.state !== "pending") ||
    (task.review_status !== undefined && task.review_status !== "pending") ||
    (task.review_generation ?? 0) > 0 || task.review_run !== undefined ||
    task.accepted_review_authority !== undefined || task.review_error !== undefined ||
    task.review_evidence_failures !== undefined ||
    (task.findings?.length ?? 0) > 0 || (task.critical_findings?.length ?? 0) > 0 ||
    (task.advisory_findings?.length ?? 0) > 0 || (task.refuted_findings?.length ?? 0) > 0 ||
    (task.resolved_findings?.length ?? 0) > 0 ||
    task.artifact_baseline !== undefined || task.attempt_artifact_baseline !== undefined ||
    task.attempt_repository_baseline !== undefined || task.issued_review_packets !== undefined ||
    task.artifact_baseline_recovered_from !== undefined || task.recovered_artifact_writes !== undefined ||
    task.failure_reason !== undefined || (task.retry_count ?? 0) > 0;
}

export function hasLaterWaveProgress(graph: TaskGraph, reopeningWave: number): boolean {
  return graph.tasks.some((task) => task.wave > reopeningWave &&
    hasLaterWaveTaskProgress(task, graph.executing_tasks ?? []));
}

function taskContexts(
  task: Task,
  request: ReopenRequest,
  contexts: readonly WaveReviewContextAuthority[],
): readonly Extract<WaveReviewContextAuthority, { taskRun: NonNullable<WaveReviewContextAuthority["taskRun"]> }>[] {
  return contexts.filter((context): context is Extract<WaveReviewContextAuthority, { taskRun: NonNullable<WaveReviewContextAuthority["taskRun"]> }> =>
    context.runId === request.runId && context.wave === request.wave &&
    context.authorityDigest === request.authorityDigest && context.taskRun !== null &&
    context.task !== null && context.taskRun.taskId === task.id &&
    context.taskRun.generation === (task.review_generation ?? 0),
  );
}

/** Re-prove reopening authority from immutable packet contexts. Legacy packet
 * headSha is a batch epoch, not a workspace digest: it is deliberately never
 * compared with current bytes. If any completed Task lacks workspaceHeadSha,
 * byte-exact authority for the Wave is unverifiable and every completed Task
 * must be reopened for a fresh review. */
export function deriveWaveReopeningProof(
  graph: TaskGraph,
  request: ReopenRequest,
  contexts: readonly WaveReviewContextAuthority[],
  observeWorkspace: (tasks: readonly Task[]) => readonly Readonly<{ taskId: string; headSha: string }>[],
): WaveReopeningProof {
  const waveTasks = graph.tasks.filter((task) => task.wave === request.wave);
  if (waveTasks.length === 0 || waveTasks.some((task) => task.status !== "completed")) {
    throw new Error("reopening requires every Task in the completed Wave to remain completed");
  }
  const authorities = waveTasks.map((task) => {
    const taskAuthority = taskContexts(task, request, contexts);
    if (taskAuthority.length === 0) {
      throw new Error(`Task ${task.id} has no immutable accepted Review Packet authority for this completed run`);
    }
    return taskAuthority;
  });
  if (authorities.some((entries) => entries.some(({ taskRun }) => taskRun.workspaceHeadSha === undefined))) {
    return Object.freeze({
      mode: "legacy-workspace-authority-unverifiable",
      taskIds: Object.freeze(waveTasks.map(({ id }) => id)),
    });
  }

  const expected = new Map<string, string>();
  for (const [index, task] of waveTasks.entries()) {
    const entries = authorities[index]!;
    const packet = entries[0]!;
    const declared = task.file_list ?? [];
    if (declared.length !== packet.task!.declaredFiles.length ||
        declared.some((path, pathIndex) => path !== packet.task!.declaredFiles[pathIndex])) {
      throw new Error(`Task ${task.id} current declared scope differs from the immutable Review Packet scope`);
    }
    if (entries.some((candidate) => candidate.taskRun!.packetId !== packet.taskRun!.packetId ||
        candidate.taskRun!.workspaceHeadSha !== packet.taskRun!.workspaceHeadSha)) {
      throw new Error(`Task ${task.id} has contradictory immutable Review Packet workspace authorities`);
    }
    expected.set(task.id, packet.taskRun!.workspaceHeadSha!);
  }
  const observed = observeWorkspace(waveTasks);
  const observations = new Map(observed.map((observation) => [observation.taskId, observation.headSha]));
  if (observations.size !== waveTasks.length || waveTasks.some((task) => observations.get(task.id) === undefined)) {
    throw new Error("current declared-workspace bytes could not be observed for every completed Task");
  }
  return Object.freeze({
    mode: "modern-exact-workspace-drift",
    taskIds: Object.freeze(waveTasks.flatMap((task) => observations.get(task.id) !== expected.get(task.id) ? [task.id] : [])),
  });
}

function packetReopeningProof(graph: TaskGraph, request: ReopenRequest, runsRoot: string): WaveReopeningProof {
  const opened = openRunDirectory(runsRoot, request.runId);
  if (!opened.ok) throw new Error(`cannot open completed Wave Run Directory: ${opened.error.message}`);
  const issued = opened.value.readIssuedRequests();
  if (!issued.ok) throw new Error(`cannot read immutable reviewer authorities: ${issued.error.message}`);
  const contexts: WaveReviewContextAuthority[] = [];
  for (const authority of issued.value) {
    if (authority.program !== "wave-gate" || authority.role === "spec-check-invoker") continue;
    const read = opened.value.readContext(authority.contextDigest);
    if (!read.ok) throw new Error(`cannot read immutable Review Packet context: ${read.error.message}`);
    const parsed = handleWaveReviewContext([read.value], authority.contextDigest);
    if (parsed.kind === "corrupt") throw new Error(`immutable Review Packet context is corrupt: ${parsed.message}`);
    if (parsed.kind === "loaded") contexts.push(parsed.value);
  }
  return deriveWaveReopeningProof(graph, request, contexts, observeReviewedWorkspace);
}

export function reopenCompletedWave(
  graph: TaskGraph,
  request: ReopenRequest,
  proof: WaveReopeningProof,
): TaskGraph {
  if (graph.current_phase !== "execute" || graph.current_wave !== request.wave + 1 || graph.active_wave_gate !== undefined) {
    throw new Error("reopening requires execute phase, current_wave exactly wave + 1, and no active Wave Gate");
  }
  if (hasLaterWaveProgress(graph, request.wave)) {
    throw new Error("reopening refuses because a later-Wave Task has progress evidence");
  }
  const completed = (graph.wave_gate_history ?? []).find((entry) => entry.runId === request.runId);
  if (completed === undefined || completed.wave !== request.wave || completed.authorityDigest !== request.authorityDigest) {
    throw new Error("reopening requires the exact completed run/wave/authority receipt");
  }
  if (!exactIds(request.taskIds, proof.taskIds)) {
    throw new Error(`reopening taskIds must exactly equal engine-derived ${proof.mode}: ${proof.taskIds.join(", ") || "none"}`);
  }
  if (proof.taskIds.length === 0) throw new Error("reopening requires at least one engine-derived Task");
  const audit: WaveReopeningAudit = Object.freeze({
    schemaVersion: 1,
    kind: "completed-wave-reopened-for-review-integrity",
    proofMode: proof.mode,
    runId: completed.runId,
    wave: completed.wave,
    authorityDigest: completed.authorityDigest,
    completionReceipt: completed.completionReceipt,
    reopenedTaskIds: Object.freeze([...proof.taskIds]),
  });
  const tasks = graph.tasks.map((task): Task => {
    if (!proof.taskIds.includes(task.id)) return task;
    const historicalProof = task.proof ?? derivePendingTaskProof({
      verificationPolicy: taskVerificationPolicy(task),
      declaredArtifacts: task.file_list ?? [],
    });
    return {
      ...task,
      // Reopening invalidates accepted completion/review authority and requires
      // fresh Proof. Retained Findings and test evidence remain active
      // remediation/audit inputs wherever gate and status projections read them;
      // only a fresh implementation settlement clears this revalidation marker.
      status: "pending",
      proof: historicalProof,
      revalidation_required: true,
      legacy_missing_proof: undefined,
      review_status: "pending",
      review_generation: (task.review_generation ?? 0) + 1,
      review_run: undefined,
      accepted_review_authority: undefined,
      review_error: undefined,
      review_evidence_failures: undefined,
    };
  });
  const gate = {
    ...(graph.wave_gates[String(request.wave)] ?? newWaveGate()),
    impl_complete: false,
    tests_passed: null,
    reviews_complete: false,
  };
  return {
    ...graph,
    current_wave: request.wave,
    tasks,
    wave_gates: reconcileWaveBlock({ ...graph.wave_gates, [String(request.wave)]: gate }, tasks, undefined, request.wave),
    wave_gate_history: (graph.wave_gate_history ?? []).filter((entry) => entry.runId !== request.runId),
    wave_reopening_history: [...(graph.wave_reopening_history ?? []), audit],
    wave_review_epoch: undefined,
    spec_check: undefined,
  };
}

type WaveReopeningCommit =
  | Readonly<{ kind: "already-committed"; proof: WaveReopeningProof }>
  | Readonly<{ kind: "committed"; proof: WaveReopeningProof }>;

/** Commit and return one proof derived from the same locked graph. */
export function commitCompletedWaveReopening(
  store: WaveReopeningStore,
  request: ReopenRequest,
  prove: (locked: TaskGraph, request: ReopenRequest) => WaveReopeningProof,
): Promise<WaveReopeningCommit> {
  return store.updateAndReturn<WaveReopeningCommit>((locked) => {
    const replay = locked.wave_reopening_history?.find((audit) =>
      audit.runId === request.runId && audit.authorityDigest === request.authorityDigest);
    if (replay !== undefined) {
      if (replay.wave !== request.wave || !exactIds(replay.reopenedTaskIds, request.taskIds)) {
        throw new Error("reopening conflicts with an immutable prior reopening audit");
      }
      return {
        state: locked,
        value: Object.freeze({
          kind: "already-committed",
          proof: Object.freeze({
            mode: replay.proofMode,
            taskIds: Object.freeze([...replay.reopenedTaskIds]),
          }),
        }),
      };
    }
    const proof = prove(locked, request);
    return {
      state: reopenCompletedWave(locked, request, proof),
      value: Object.freeze({ kind: "committed", proof }),
    };
  });
}

const handler: HookHandler = async (stdin, args) => {
  try {
    const request = parseRequest(stdin);
    const runsRoot = argumentValue(args, "--runs-root");
    if (runsRoot === null) return { kind: "error", message: USAGE };
    const manager = StateManager.fromPath(taskGraphPath());
    if (manager === null) return { kind: "error", message: "no protected TaskGraph exists" };
    const committed = await commitCompletedWaveReopening(
      manager,
      request,
      (locked, lockedRequest) => packetReopeningProof(locked, lockedRequest, runsRoot),
    );
    return committed.kind === "already-committed"
      ? { kind: "passthrough", systemMessage: "completed Wave reopening already committed" }
      : {
          kind: "passthrough",
          systemMessage: `reopened Wave ${request.wave} (${committed.proof.mode}); ` +
            `refresh review evidence for ${committed.proof.taskIds.join(", ")}`,
        };
  } catch (error) {
    return { kind: "error", message: `[loom] reopen-completed-wave: ${error instanceof Error ? error.message : String(error)}` };
  }
};

export default handler;
