import { sha256Hex } from "./review-packet";
import type { Task, TaskGraph } from "../types";
import { buildContextPacket, encodeByteSection, type ContextPacket } from "./context-packets";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile, WAVE_REVIEW_AGENTS } from "./model-profiles";
import {
  canonicalRecord,
  parseAgentRequestAuthority,
  parseArtifactDigest,
  parseRequestId,
  parseSlotId,
  type ArtifactDigest,
  type DomainResult,
  type InitialSpawnRequestInput,
  type OrchestrationRunId,
} from "./orchestration-contract";
import type { ReviewedWorkspaceObservation } from "./reviewed-workspace";

export type WaveReviewRegistrationAuthority = Readonly<{
  schemaVersion: 1;
  kind: "wave-gate";
  input: Readonly<{ wave: number | null }>;
  taskIds: readonly string[];
  authorityDigest: string;
  restart?: Readonly<{ previousRunId: string; exhaustedSlots: readonly string[] }>;
  orphanRecovery?: Readonly<{ previousRunId: string; previousAuthorityDigest: string }>;
}>;

export type WaveTaskRunAuthority = Readonly<{
  taskId: string;
  generation: number;
  packetId: string;
  /** Existing batch epoch identity for reviewer-slot authority. */
  headSha: string;
  /** Exact declared-workspace byte snapshot for completion integrity. */
  workspaceHeadSha?: string;
}>;

export type WaveRequestBatch = Readonly<{
  batchEpoch: ArtifactDigest;
  requests: readonly InitialSpawnRequestInput[];
  packets: readonly ContextPacket[];
  taskRuns: readonly WaveTaskRunAuthority[];
}>;

export type WaveSpecCheckTaskAuthority = Readonly<{
  id: string;
  description: string;
  completionAnchors: readonly string[];
  contributions: readonly string[];
  declaredFiles: readonly string[];
}>;

export type WaveReviewPreparationError = Readonly<{
  kind: "wave-review-preparation-rejected";
  message: string;
}>;

const failure = (message: string): DomainResult<WaveRequestBatch, WaveReviewPreparationError> =>
  canonicalRecord({ ok: false, error: canonicalRecord({ kind: "wave-review-preparation-rejected", message }) });

/** Immutable current-Wave Requirement scope. Contributions are included for
 * traceability but only completionAnchors define spec-check authority. */
export function waveSpecCheckScope(tasks: readonly Task[]): readonly WaveSpecCheckTaskAuthority[] {
  return Object.freeze(tasks.map((task) => Object.freeze({
    id: task.id,
    description: task.description,
    completionAnchors: Object.freeze([...(task.spec_anchors ?? [])]),
    contributions: Object.freeze([...(task.spec_contributions ?? [])]),
    declaredFiles: Object.freeze([...(task.file_list ?? [])]),
  })));
}

/**
 * The sole Wave review authority derivation.
 *
 * The shell contributes only the exact registered run and byte observations.
 * This pure function freezes the roster, packet/context bytes, model policy,
 * request/slot identities, and both Task and spec-check authority.
 */
export function prepareWaveReviewBatch(
  runId: OrchestrationRunId,
  registration: WaveReviewRegistrationAuthority,
  graph: TaskGraph,
  attempt: 1 | 2,
  workspace: readonly ReviewedWorkspaceObservation[],
): DomainResult<WaveRequestBatch, WaveReviewPreparationError> {
  if (registration.input.wave === null) {
    return failure("registered Wave review authority lacks an exact Wave");
  }
  const currentWaveTasks = graph.tasks.filter((task) => task.wave === registration.input.wave);
  const tasks: Task[] = [];
  for (const taskId of registration.taskIds) {
    const task = graph.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) return failure(`registered Wave Task ${taskId} disappeared`);
    tasks.push(task);
  }
  if (tasks.some((task) => task.wave !== registration.input.wave) ||
      currentWaveTasks.length !== tasks.length || currentWaveTasks.some((task, index) => task.id !== tasks[index]?.id)) {
    return failure("registered Wave Task roster drifted from the exact protected current-Wave roster");
  }
  const workspaceByTask = new Map<string, ReviewedWorkspaceObservation>();
  for (const observation of workspace) {
    if (workspaceByTask.has(observation.taskId)) {
      return failure(`Task ${observation.taskId} has duplicate workspace observations`);
    }
    workspaceByTask.set(observation.taskId, observation);
  }
  if (workspaceByTask.size !== tasks.length || tasks.some(({ id }) => !workspaceByTask.has(id))) {
    return failure("current Wave workspace observations differ from the exact registered Task roster");
  }

  const specCheckScope = waveSpecCheckScope(tasks);
  const batchEpoch = parseArtifactDigest(sha256Hex(JSON.stringify({
    runId,
    wave: registration.input.wave,
    authorityDigest: registration.authorityDigest,
    tasks: tasks.map((task) => ({
      id: task.id,
      generation: task.review_generation ?? 0,
      files: task.file_list ?? [],
      modified: task.files_modified ?? [],
      completionAnchors: task.spec_anchors ?? [],
      contributions: task.spec_contributions ?? [],
      priorFindingIds: task.review_run?.prior_finding_ids ?? (task.findings ?? []).map(({ id }) => id),
      reviewedHeadSha: workspaceByTask.get(task.id)?.headSha ?? null,
    })),
    specFile: graph.spec_file ?? null,
    planFile: graph.plan_file ?? null,
  })));
  if (!batchEpoch.ok) return failure(batchEpoch.error.message);

  const taskRuns: WaveTaskRunAuthority[] = [];
  for (const task of tasks) {
    const observation = workspaceByTask.get(task.id);
    if (observation === undefined) return failure(`Task ${task.id} workspace snapshot is missing`);
    taskRuns.push(Object.freeze({
      taskId: task.id,
      generation: task.review_generation ?? 0,
      packetId: sha256Hex(`${batchEpoch.value}|packet|${task.id}`),
      headSha: batchEpoch.value,
      workspaceHeadSha: observation.headSha,
    }));
  }

  const subjects = [
    { role: "spec-check-invoker" as const, taskId: null as string | null },
    ...tasks.flatMap((task) => WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: task.id as string | null }))),
  ];
  const requests: InitialSpawnRequestInput[] = [];
  const packets: ContextPacket[] = [];
  for (const subject of subjects) {
    const taskRun = subject.taskId === null ? null : taskRuns.find(({ taskId }) => taskId === subject.taskId) ?? null;
    const identity = JSON.stringify({ runId, registration, batchEpoch: batchEpoch.value, subject, taskRun });
    const hash = sha256Hex(identity);
    const slotId = parseSlotId(`wave-slot:${hash.slice(0, 32)}`);
    const requestId = parseRequestId(`wave-request:${hash.slice(0, 32)}:${attempt}`);
    if (!slotId.ok) return failure(slotId.error.message);
    if (!requestId.ok) return failure(requestId.error.message);
    const policy = resolveAgentPolicy(subject.role);
    if (!policy.ok) return failure(policy.error.message);
    const profile = resolveModelProfile(policy.value.profile);
    if (!profile.ok) return failure(profile.error.message);
    const task = subject.taskId === null ? null : tasks.find(({ id }) => id === subject.taskId) ?? null;
    const section = encodeByteSection("wave-review-authority", JSON.stringify({
      runId,
      wave: registration.input.wave,
      authorityDigest: registration.authorityDigest,
      batchEpoch: batchEpoch.value,
      subject,
      taskRun,
      specCheckScope: subject.taskId === null ? specCheckScope : null,
      task: task === null ? null : {
        id: task.id,
        description: task.description,
        agent: task.agent,
        reviewGeneration: task.review_generation ?? 0,
        planContext: task.plan_context ?? null,
        specAnchors: task.spec_anchors ?? [],
        specContributions: task.spec_contributions ?? [],
        declaredFiles: task.file_list ?? [],
        modifiedFiles: task.files_modified ?? [],
        proof: task.proof ?? null,
        testResult: task.test_result ?? null,
        priorFindings: task.findings ?? [],
      },
      packetId: taskRun?.packetId ?? null,
      specFile: graph.spec_file,
      planFile: graph.plan_file,
    }));
    if (!section.ok) return failure(section.error.message);
    const packet = buildContextPacket({
      requestId: requestId.value,
      role: subject.role,
      requiredSkill: policy.value.requiredSkill ?? "none",
      outputContract: subject.role === "spec-check-invoker"
        ? `Run the Wave ${registration.input.wave} spec alignment check and emit its exact Machine Summary.`
        : `Review Task ${subject.taskId} from the immutable packet and emit the exact Machine Summary and findings contract.`,
      fixedContext: Object.freeze([section.value]),
      variableContext: Object.freeze([]),
    });
    if (!packet.ok) return failure(packet.error.message);
    const authority = parseAgentRequestAuthority({
      runId,
      requestId: requestId.value,
      slotId: slotId.value,
      program: "wave-gate",
      role: subject.role,
      attempt,
      modelProfile: profile.value.id,
      harnessBinding: {
        pi: lowerModelProfile(profile.value, "pi"),
        claude: lowerModelProfile(profile.value, "claude-code"),
      },
      requiredSkill: policy.value.requiredSkill,
      contextDigest: packet.value.digest,
      outputSlot: `transcripts/${slotId.value}/attempt-${attempt}.raw`,
    });
    if (!authority.ok) {
      return failure(authority.error.violations.map(({ message }) => message).join("; "));
    }
    packets.push(packet.value);
    requests.push(Object.freeze({
      authority: authority.value,
      context: Object.freeze({
        digest: packet.value.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` }),
      }),
    }));
  }

  return canonicalRecord({
    ok: true,
    value: Object.freeze({
      batchEpoch: batchEpoch.value,
      requests: Object.freeze(requests),
      packets: Object.freeze(packets),
      taskRuns: Object.freeze(taskRuns),
    }),
  });
}
