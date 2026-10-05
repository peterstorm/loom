/**
 * Wave review request issuance: observe current bytes and delegate the batch
 * to the single pure Wave review preparation, install the batch's Review
 * Packets under the state lock, and the resume phase that publishes, installs
 * or recovers the current batch before evidence collection.
 */
import type { AgentRequestAuthority } from '../../../core/orchestration-contract';
import type { ContextPacket } from '../../../core/context-packets';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { observeTaskGraphProjectBoundary, type TaskGraphProjectBoundary } from '../../../config';
import type { StateManager } from '../../../state-manager';
import { WAVE_REVIEW_AGENTS } from '../../../core/model-profiles';
import { observeReviewedWorkspace } from '../reviewed-workspace';
import { observeWaveSpecCheckDocuments } from '../../../orchestration/wave-spec-check-documents';
import type { Task } from '../../../types';
import { installWaveReviewRunsTransition, waveBatchSpecCheckAuthority } from '../../../core/wave-review-issuance';
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import {
  prepareWaveReviewBatch,
  type WaveRequestBatch,
  type WaveReviewRegistrationAuthority,
} from '../../../core/wave-review-authority';
import { durableRefutationRequests, publicationResolver } from './durable-requests';
import { failed } from './program-result';
import { publishReviewInitialBatch } from './request-publication';
import { observedReviewerIssueRoute } from './spawn-task';
import { proceed, settled, waveBlocked, type WavePhase } from './wave-gate-outcome';
import { readWaveRequestContext, waveReviewContextTaskId, type ReadableWaveReviewContext } from './wave-review-context';

/** Imperative shell: observe current bytes, then delegate every authority
 * decision to the single pure Wave review preparation function. */
export function waveRequests(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  graph: ReturnType<StateManager["load"]>,
  attempt: 1 | 2,
  projectBoundary: TaskGraphProjectBoundary,
): WaveRequestBatch {
  const wave = registration.input.wave;
  if (wave === null) throw new Error("registered Wave review authority lacks an exact Wave");
  const tasks = registration.taskIds.flatMap((taskId) => {
    const task = graph.tasks.find((candidate) => candidate.id === taskId);
    return task === undefined ? [] : [task];
  });
  const authority: WaveReviewRegistrationAuthority = Object.freeze({
    ...registration,
    input: Object.freeze({ wave }),
  });
  const prepared = prepareWaveReviewBatch(
    handle.runId,
    authority,
    graph,
    attempt,
    observeReviewedWorkspace(tasks),
    observeWaveSpecCheckDocuments({
      specFile: graph.spec_file,
      planFile: graph.plan_file,
      projectBoundary,
    }),
    observedReviewerIssueRoute(),
  );
  if (!prepared.ok) throw new Error(prepared.error.message);
  return prepared.value;
}

/** Install one prepared batch's Review Packets: observe the reviewed
 *  workspaces and spec/plan bytes before the lock, then let the pure locked
 *  transition decide; a refusal aborts the state write with its message. */
export async function installWaveReviewRuns(
  manager: StateManager,
  registration: RegisteredWaveGateProgram,
  batch: WaveRequestBatch,
): Promise<void> {
  const specCheck = waveBatchSpecCheckAuthority(batch);
  if (!specCheck.ok) throw new Error(specCheck.error.message);
  const preinstall = manager.load();
  const workspaces = observeReviewedWorkspace(
    preinstall.tasks.filter(({ id }) => registration.taskIds.includes(id)),
  );
  const specCheckObservation = observeWaveSpecCheckDocuments({
    specFile: batch.specCheckDocuments.spec.path,
    planFile: batch.specCheckDocuments.plan.path,
    projectBoundary: observeTaskGraphProjectBoundary(manager.getPath()),
  });
  const issueRoute = observedReviewerIssueRoute();
  await manager.update((locked) => {
    const next = installWaveReviewRunsTransition(locked, { registration, batch, workspaces, specCheckObservation, issueRoute });
    if (!next.ok) throw new Error(next.error.message);
    return next.value;
  });
}

/** The current batch's protected state once issuance is reconciled. */
export type IssuedWaveReviewBatch = Readonly<{
  refreshed: ReturnType<StateManager["load"]>;
  /** Registered Tasks whose Review Packet is collecting evidence. */
  currentRuns: readonly Task[];
  /** The issued request journal, narrowed to the recovered current batch when one is collecting. */
  currentIssued: readonly AgentRequestAuthority[];
}>;

/**
 * Resume phase: publish and install the initial batch, install a fresh batch
 * for Tasks that need one, or prove the collecting batch's exact durable
 * publication — republishing the deterministic batch when its persisted
 * prefix is partial.
 */
export async function reconcileWaveReviewIssuance(
  handle: RunDirHandle,
  manager: StateManager,
  registration: RegisteredWaveGateProgram,
  graph: ReturnType<StateManager["load"]>,
  issued: readonly AgentRequestAuthority[],
): Promise<WavePhase<IssuedWaveReviewBatch>> {
  const initialBatchMissingOrPartial = graph.wave_review_epoch === undefined &&
    graph.tasks.every((task) => !registration.taskIds.includes(task.id) || task.review_run === undefined);
  if (initialBatchMissingOrPartial) {
    const batch = waveRequests(
      handle,
      registration,
      graph,
      1,
      observeTaskGraphProjectBoundary(manager.getPath()),
    );
    // Publication is deterministic and idempotent per context/request slot.
    // Re-running the complete effect reconciles a crash after any strict
    // prefix of requests was reserved instead of treating partial issuance
    // as a corrupt batch and stranding the active replacement authority.
    const published = await publishReviewInitialBatch(handle, batch.requests, batch.packets, "wave-gate-current", registration);
    if (!published.ok) return settled(failed(published.message));
    const action = published.action;
    await installWaveReviewRuns(manager, registration, batch);
    return settled({ ok: true, action: {
      ...action,
      requests: action.requests.map((request, index) => ({
        ...request,
        task: index === 0
          ? `${request.task}\nSpec-check Wave ${registration.input.wave}.`
          : `${request.task}\nReview Task ${registration.taskIds[Math.floor((index - 1) / WAVE_REVIEW_AGENTS.length)]}.`,
      })),
    } });
  }

  let refreshed = manager.load();
  const hasCollectingPacket = refreshed.tasks.some((task) =>
    registration.taskIds.includes(task.id) && task.review_run !== undefined);
  const needsFreshPacket = refreshed.tasks.some((task) =>
    registration.taskIds.includes(task.id) && task.review_run === undefined &&
    task.review_status !== "passed" && task.review_status !== "blocked");
  if (!hasCollectingPacket && needsFreshPacket) {
    const batch = waveRequests(
      handle,
      registration,
      refreshed,
      1,
      observeTaskGraphProjectBoundary(manager.getPath()),
    );
    await installWaveReviewRuns(manager, registration, batch);
    const published = await publishReviewInitialBatch(handle, batch.requests, batch.packets, "wave-gate-current", registration);
    return settled(published.ok ? { ok: true, action: published.action } : failed(published.message));
  }

  refreshed = manager.load();
  const currentRuns = refreshed.tasks.filter((task) =>
    registration.taskIds.includes(task.id) && task.review_run !== undefined);
  let currentIssued = issued;
  if (currentRuns.length > 0) {
    const epoch = refreshed.wave_review_epoch;
    if (epoch?.runId !== handle.runId || epoch.wave !== registration.input.wave) {
      return settled(waveBlocked(handle, "active Wave Review Packets lack exact persisted batch epoch authority"));
    }
    const candidates: { authority: AgentRequestAuthority; packet: ContextPacket; context: ReadableWaveReviewContext }[] = [];
    for (const authority of issued.filter((request) => request.program === "wave-gate" && request.attempt === 1)) {
      const read = readWaveRequestContext(handle, authority);
      if (!read.ok) return settled(read.result);
      if (read.context.kind === "loaded" && read.context.value.batchEpoch === epoch.batchEpoch) {
        candidates.push({ authority, packet: read.packet, context: read.context });
      }
    }
    const rank = (candidate: typeof candidates[number]): number => {
      if (candidate.authority.role === "spec-check-invoker") return 0;
      const taskIndex = registration.taskIds.indexOf(waveReviewContextTaskId(candidate.context) ?? "");
      const reviewerIndex = WAVE_REVIEW_AGENTS.indexOf(candidate.authority.role as typeof WAVE_REVIEW_AGENTS[number]);
      return taskIndex < 0 || reviewerIndex < 0 ? Number.MAX_SAFE_INTEGER : 1 + taskIndex * WAVE_REVIEW_AGENTS.length + reviewerIndex;
    };
    candidates.sort((left, right) => rank(left) - rank(right));
    const expectedCount = 1 + registration.taskIds.length * WAVE_REVIEW_AGENTS.length;
    if (candidates.length !== expectedCount || candidates.some((candidate, index) => rank(candidate) !== index)) {
      const expectedBatch = waveRequests(
        handle,
        registration,
        refreshed,
        1,
        observeTaskGraphProjectBoundary(manager.getPath()),
      );
      if (expectedBatch.batchEpoch !== epoch.batchEpoch) {
        return settled(waveBlocked(handle, "persisted current Wave review batch differs from deterministic protected authority"));
      }
      const republished = await publishReviewInitialBatch(
        handle,
        expectedBatch.requests,
        expectedBatch.packets,
        "wave-gate-current",
        registration,
      );
      if (!republished.ok) return settled(failed(republished.message));
      return settled({ ok: true, action: republished.action });
    }
    const inputs = candidates.map(({ authority }) => Object.freeze({
      authority,
      context: Object.freeze({
        digest: authority.contextDigest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${authority.contextDigest}.json` }),
      }),
    }));
    const recovered = durableRefutationRequests(
      handle, inputs, publicationResolver(handle), "wave-gate-current",
    );
    if (recovered.kind === "corrupt") return settled(waveBlocked(handle, recovered.message));
    if (recovered.kind === "found") {
      currentIssued = Object.freeze(recovered.requests.map(({ authority }) => authority));
    } else {
      const published = await publishReviewInitialBatch(
        handle, inputs, candidates.map(({ packet }) => packet), "wave-gate-current", registration,
      );
      if (!published.ok) return settled(failed(published.message));
      currentIssued = Object.freeze(published.requests.map(({ authority }) => authority));
    }
  }
  return proceed(Object.freeze({ refreshed, currentRuns, currentIssued }));
}
