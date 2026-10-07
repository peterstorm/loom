/**
 * Protected-state transitions that record Wave review request issuance: the
 * locked install of one Wave review batch (epoch + per-Task Review Packets),
 * and the attempt-2 issuance marks for reviewer and spec-check retries. Each is
 * a pure `(lockedGraph, observations) → Result<nextGraph>`; the program volume
 * observes bytes before taking the lock and throws a refusal's message inside
 * the state update so the write aborts.
 */
import type { CurrentReviewRunSlotAuthority, LegacyReviewRunSlotAuthority, TaskGraph } from "../types";
import type { ContextPacket } from "./context-packets";
import type { ReviewerIssueRoute } from "./model-profiles";
import {
  canonicalStructuralEquals,
  parseStoredAgentRequestAuthority,
  type AgentRequestAuthority,
  type DomainResult,
  type InitialSpawnRequestInput,
} from "./orchestration-contract";
import type { IssuedWaveReviewerProtocol } from "./review-output";
import type { ReviewedWorkspaceObservation } from "./reviewed-workspace";
import { WAVE_REVIEW_AGENTS } from "./model-profiles";
import { waveReviewerSlotProblem } from "./wave-gate-membership";
import type { RegisteredWaveGateProgram } from "./wave-gate-program";
import {
  decideWaveReviewEpochReplay,
  prepareWaveReviewBatch,
  readWaveReviewContext,
  taskReviewScope,
  waveSpecCheckDocumentsMatch,
  type WaveRequestBatch,
  type WaveReviewRegistrationAuthority,
  type WaveSpecCheckObservation,
} from "./wave-review-authority";

export type IssuanceRefusal = Readonly<{ message: string }>;

const refuse = (message: string): DomainResult<never, IssuanceRefusal> =>
  ({ ok: false, error: Object.freeze({ message }) });

/** Everything the locked install compares against, observed before the lock. */
export type WaveReviewInstallObservation = Readonly<{
  registration: RegisteredWaveGateProgram;
  batch: WaveRequestBatch;
  /** Reviewed workspace of every registered Task, observed before the lock. */
  workspaces: readonly ReviewedWorkspaceObservation[];
  /** Current spec/plan observation at the batch's document paths. */
  specCheckObservation: WaveSpecCheckObservation;
  issueRoute: ReviewerIssueRoute;
}>;

function reviewSlotAuthorityRoster(
  authorities: readonly AgentRequestAuthority[],
): DomainResult<readonly [LegacyReviewRunSlotAuthority, ...LegacyReviewRunSlotAuthority[]], IssuanceRefusal> {
  const slots: LegacyReviewRunSlotAuthority[] = [];
  for (const agent of WAVE_REVIEW_AGENTS) {
    const matches = authorities.filter((authority) => authority.role === agent);
    if (matches.length !== 1) {
      return refuse(`current Review Packet requires exactly one ${agent} slot, got ${matches.length}`);
    }
    slots.push(Object.freeze({ agent, slot_id: matches[0]!.slotId, attempted: 1 as const }));
  }
  const [first, ...rest] = slots;
  return { ok: true, value: Object.freeze([first!, ...rest]) };
}

/** The batch's spec-check attempt-1 authority: every Wave review batch opens with exactly one. */
export function waveBatchSpecCheckAuthority(batch: WaveRequestBatch): DomainResult<AgentRequestAuthority, IssuanceRefusal> {
  const specCheckAuthority = batch.requests.map(({ authority }) => authority as AgentRequestAuthority)
    .find(({ role }) => role === "spec-check-invoker");
  return specCheckAuthority === undefined || specCheckAuthority.attempt !== 1
    ? refuse("Wave review batch lacks exact spec-check attempt-1 authority")
    : { ok: true, value: specCheckAuthority };
}

/**
 * Install one Wave review batch under the state lock: the batch must still
 * own the exact active Wave Gate authority, spec/plan bytes and every Task's
 * reviewed workspace must be unchanged since the batch was prepared, and a
 * Task that already carries a Review Packet must carry exactly this one.
 */
export function installWaveReviewRunsTransition(
  locked: TaskGraph,
  observation: WaveReviewInstallObservation,
): DomainResult<TaskGraph, IssuanceRefusal> {
  const { registration, batch, workspaces, specCheckObservation, issueRoute } = observation;
  const specCheck = waveBatchSpecCheckAuthority(batch);
  if (!specCheck.ok) return specCheck;
  const specCheckAuthority = specCheck.value;
  const reviewAuthorities = batch.requests.map(({ authority }) => authority as AgentRequestAuthority)
    .filter(({ role }) => role !== "spec-check-invoker");
  const workspaceByTask = new Map(workspaces.map((workspace) => [workspace.taskId, workspace]));
  const wave = registration.input.wave;
  const active = locked.active_wave_gate;
  if (wave === null || locked.current_phase !== "execute" || locked.current_wave !== wave ||
      active === undefined || active.terminalOutcome !== null || active.runId !== specCheckAuthority.runId ||
      active.wave !== wave || active.authorityDigest !== registration.authorityDigest) {
    return refuse("Wave review batch no longer owns the exact active Wave Gate authority");
  }
  if (locked.spec_file !== batch.specCheckDocuments.spec.path ||
      locked.plan_file !== batch.specCheckDocuments.plan.path ||
      !waveSpecCheckDocumentsMatch(specCheckObservation.authority, batch.specCheckDocuments)) {
    return refuse("spec-check documents changed before the Wave review batch could be installed");
  }
  const lockedAuthority: WaveReviewRegistrationAuthority = Object.freeze({
    ...registration,
    input: Object.freeze({ wave }),
  });
  const lockedPreparation = prepareWaveReviewBatch(
    specCheckAuthority.runId,
    lockedAuthority,
    locked,
    1,
    workspaces,
    specCheckObservation,
    issueRoute,
  );
  if (!lockedPreparation.ok || !canonicalStructuralEquals(lockedPreparation.value, batch)) {
    return refuse("Wave review packet context changed before the batch could be installed");
  }
  const existingEpoch = locked.wave_review_epoch;
  const replay = decideWaveReviewEpochReplay(
    existingEpoch, batch, specCheckAuthority.runId, wave, specCheckAuthority.slotId);
  if (existingEpoch !== undefined && replay.kind === "different" && locked.tasks.some((task) =>
    registration.taskIds.includes(task.id) && task.review_run !== undefined)) {
    return refuse("Wave review batch differs from the exact installed Wave review epoch");
  }
  const tasks: TaskGraph["tasks"][number][] = [];
  for (const task of locked.tasks) {
    if (!registration.taskIds.includes(task.id)) {
      tasks.push(task);
      continue;
    }
    const taskRun = batch.taskRuns.find(({ taskId }) => taskId === task.id);
    const currentWorkspace = workspaceByTask.get(task.id);
    const lockedScope = taskReviewScope(task);
    const exactScope = currentWorkspace !== undefined && lockedScope.length === currentWorkspace.scope.length &&
      lockedScope.every((path, index) => path === currentWorkspace.scope[index]);
    if (taskRun === undefined || taskRun.generation !== (task.review_generation ?? 0) || !exactScope ||
        currentWorkspace === undefined || currentWorkspace.headSha !== (taskRun.workspaceHeadSha ?? taskRun.headSha)) {
      return refuse(`Task ${task.id} changed before its current Review Packet could be installed`);
    }
    const authorities: AgentRequestAuthority[] = [];
    for (const authority of reviewAuthorities) {
      const context = readWaveReviewContext(batch.packets, authority.contextDigest);
      if (context.kind === "corrupt") {
        return refuse(`Task ${task.id} Review Packet corruption: ${context.message}`);
      }
      if (context.kind === "loaded" && context.value.taskRun?.taskId === task.id) authorities.push(authority);
    }
    if (authorities.length !== WAVE_REVIEW_AGENTS.length) {
      return refuse(`Task ${task.id} current Review Packet lacks the exact reviewer roster`);
    }
    const roster = reviewSlotAuthorityRoster(authorities);
    if (!roster.ok) return roster;
    const slotAuthority = roster.value;
    const currentSlot = (slot: LegacyReviewRunSlotAuthority): CurrentReviewRunSlotAuthority => {
      const request = authorities.find(({ role }) => role === slot.agent)!;
      return Object.freeze({ ...slot, request_id: request.requestId, context_digest: request.contextDigest });
    };
    const [firstSlot, ...remainingSlots] = slotAuthority;
    const currentSlots: readonly [CurrentReviewRunSlotAuthority, ...CurrentReviewRunSlotAuthority[]] =
      Object.freeze([currentSlot(firstSlot), ...remainingSlots.map(currentSlot)]);
    if (task.review_run !== undefined) {
      const run = task.review_run;
      const sameProtocol = registration.schemaVersion === 2
        ? canonicalStructuralEquals(run.reviewer_protocol, registration.reviewerProtocol) &&
          canonicalStructuralEquals(run.slot_authority, currentSlots)
        : run.reviewer_protocol === undefined;
      const same = sameProtocol && run.packet_id === taskRun.packetId && run.generation === taskRun.generation &&
        run.head_sha === taskRun.headSha && canonicalStructuralEquals(run.expected_agents, WAVE_REVIEW_AGENTS) &&
        run.slot_authority?.length === slotAuthority.length && slotAuthority.every((slot, index) =>
          run.slot_authority?.[index]?.agent === slot.agent && run.slot_authority[index]?.slot_id === slot.slot_id) &&
        canonicalStructuralEquals(run.workspace_scope, currentWorkspace.scope) &&
        run.workspace_head_sha === (taskRun.workspaceHeadSha ?? taskRun.headSha) &&
        run.wave_gate_run_id === specCheckAuthority.runId &&
        run.wave_gate_authority_digest === registration.authorityDigest;
      if (!same) return refuse(`Task ${task.id} already has a different Review Packet in progress`);
      tasks.push(task);
      continue;
    }
    tasks.push({
      ...task,
      review_status: "pending" as const,
      review_error: undefined,
      review_evidence_failures: undefined,
      review_run: {
        generation: taskRun.generation,
        packet_id: taskRun.packetId,
        head_sha: taskRun.headSha,
        expected_agents: WAVE_REVIEW_AGENTS,
        prior_finding_ids: (task.findings ?? []).map(({ id }) => id),
        evidence: [],
        ...(registration.schemaVersion === 2
          ? { reviewer_protocol: registration.reviewerProtocol, slot_authority: currentSlots }
          : { slot_authority: slotAuthority }),
        workspace_scope: currentWorkspace.scope,
        workspace_head_sha: taskRun.workspaceHeadSha ?? taskRun.headSha,
        wave_gate_run_id: specCheckAuthority.runId,
        wave_gate_authority_digest: registration.authorityDigest,
      },
    });
  }
  return { ok: true, value: {
    ...locked,
    // Exact replay retains captured spec-check evidence. A historical
    // floorless epoch is upgraded under this lock and requires fresh capture.
    spec_check: replay.kind === "exact" ? locked.spec_check : undefined,
    wave_review_epoch: replay.kind === "exact" ? existingEpoch : {
      runId: specCheckAuthority.runId,
      wave,
      batchEpoch: batch.batchEpoch,
      specCheckDocuments: batch.specCheckDocuments,
      settledSpecCheckFloor: batch.settledFloor,
      specCheckSlotAuthority: {
        slot_id: specCheckAuthority.slotId,
        attempted: 1,
      },
    },
    tasks,
  } };
}

/** One outstanding reviewer slot's attempt-2 retry, derived from its rejected attempt 1. */
export type WaveTaskReviewRetry = Readonly<{
  taskId: string;
  packetId: string;
  agent: string;
  slotId: string;
  /** The parser rejection reason attempt 2 is told about; the retry render
   *  builds its route-specific diagnostic from it. */
  retryReason: string;
  protocol: IssuedWaveReviewerProtocol;
  request: InitialSpawnRequestInput;
  packet: ContextPacket;
}>;

/**
 * Record attempt-2 issuance on each retried slot. A current (protocol v2) slot
 * adopts the retry's request/context identity only while the retry still
 * belongs to the exact current Review Packet slot; otherwise the Task is left
 * unchanged. A legacy slot whose packet moved refuses the whole write.
 */
export function markWaveTaskReviewRetriesIssuedTransition(
  locked: TaskGraph,
  retries: readonly WaveTaskReviewRetry[],
): DomainResult<TaskGraph, IssuanceRefusal> {
  const tasks: TaskGraph["tasks"][number][] = [];
  for (const task of locked.tasks) {
    const mine = retries.filter((retry) => retry.taskId === task.id);
    if (mine.length === 0) {
      tasks.push(task);
      continue;
    }
    const run = task.review_run;
    if (run === undefined || mine.some((retry) => retry.packetId !== run.packet_id)) {
      if (mine.every(({ protocol }) => protocol.protocolVersion === 2)) {
        tasks.push(task);
        continue;
      }
      return refuse(`Task ${task.id} Review Packet changed before attempt-2 issuance could commit`);
    }
    if (run.reviewer_protocol !== undefined) {
      const replacements = new Map<string, CurrentReviewRunSlotAuthority>();
      let unchanged = false;
      for (const retry of mine) {
        const request = parseStoredAgentRequestAuthority(retry.request.authority);
        if (!request.ok) return refuse("Wave retry request authority is invalid");
        const context = readWaveReviewContext([retry.packet], request.value.contextDigest);
        const slot = run.slot_authority.find(({ agent }) => agent === retry.agent);
        const expected = slot?.attempted === 1 ? retry.protocol.request : request.value;
        if (context.kind !== "loaded" ||
            waveReviewerSlotProblem(locked, task, context.value, retry.protocol, false) !== null ||
            slot === undefined || run.evidence.some(({ agent }) => agent === retry.agent) ||
            slot.request_id !== expected.requestId || slot.context_digest !== expected.contextDigest ||
            slot.slot_id !== request.value.slotId || request.value.attempt !== 2 ||
            request.value.role !== slot.agent || request.value.runId !== retry.protocol.request.runId) {
          unchanged = true;
          break;
        }
        replacements.set(slot.agent, Object.freeze({ ...slot, attempted: 2,
          request_id: request.value.requestId, context_digest: request.value.contextDigest }));
      }
      if (unchanged) {
        tasks.push(task);
        continue;
      }
      const [first, ...rest] = run.slot_authority;
      const replace = (slot: CurrentReviewRunSlotAuthority) => replacements.get(slot.agent) ?? slot;
      tasks.push({ ...task, review_run: { ...run, slot_authority: [replace(first), ...rest.map(replace)] } });
      continue;
    }
    if (run.slot_authority === undefined) {
      return refuse(`Task ${task.id} active Review Run lost exact slot authority`);
    }
    const [first, ...rest] = run.slot_authority;
    const replace = (slot: LegacyReviewRunSlotAuthority): LegacyReviewRunSlotAuthority => mine.some((retry) =>
      retry.agent === slot.agent && retry.slotId === slot.slot_id) ? { ...slot, attempted: 2 } : slot;
    tasks.push({
      ...task,
      review_run: { ...run, slot_authority: [replace(first), ...rest.map(replace)] },
    });
  }
  return { ok: true, value: { ...locked, tasks } };
}

/** Record spec-check attempt-2 issuance on the exact current Wave review epoch slot (idempotent). */
export function markWaveSpecCheckRetryIssuedTransition(
  locked: TaskGraph,
  authority: AgentRequestAuthority,
  batchEpoch: string,
): DomainResult<TaskGraph, IssuanceRefusal> {
  const epoch = locked.wave_review_epoch;
  const slot = epoch?.specCheckSlotAuthority;
  if (epoch === undefined || epoch.runId !== authority.runId || epoch.batchEpoch !== batchEpoch ||
      locked.current_phase !== "execute" || locked.current_wave !== epoch.wave ||
      locked.active_wave_gate?.runId !== authority.runId || locked.active_wave_gate.wave !== epoch.wave ||
      slot === undefined || slot.slot_id !== authority.slotId) {
    return refuse("spec-check retry authority does not match the exact current Wave review epoch slot");
  }
  if (slot.attempted === 2) return { ok: true, value: locked };
  return { ok: true, value: {
    ...locked,
    wave_review_epoch: {
      ...epoch,
      specCheckSlotAuthority: { ...slot, attempted: 2 },
    },
  } };
}
