/**
 * Wave review request issuance: observe current bytes and delegate the batch
 * to the single pure Wave review preparation, install the batch's Review
 * Packets under the state lock, and the resume phase that publishes, installs
 * or recovers the current batch before evidence collection.
 */
import type { AgentRequestAuthority, DomainResult } from '../../../core/orchestration-contract';
import type { ContextPacket } from '../../../core/context-packets';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { observeTaskGraphProjectBoundary, type TaskGraphProjectBoundary } from '../../../config';
import type { StateManager } from '../../../state-manager';
import { observeReviewedWorkspace } from '../reviewed-workspace';
import { observeWaveSpecCheckDocuments } from '../../../orchestration/wave-spec-check-documents';
import type { Task } from '../../../types';
import { installWaveReviewRunsTransition, waveBatchSpecCheckAuthority } from '../../../core/wave-review-issuance';
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import {
  classifyPersistedWaveBatch,
  prepareWaveReviewBatch,
  type PersistedWaveBatchCandidate,
  type WaveRequestBatch,
  type WaveReviewRegistrationAuthority,
} from '../../../core/wave-review-authority';
import { durableRefutationRequests, publicationResolver } from './durable-requests';
import { failed } from './program-result';
import { publishReviewInitialBatch } from './request-publication';
import { observedReviewerIssueRoute } from './spawn-task';
import { proceed, settled, waveBlocked, type WavePhase, type WaveResumeContext } from './wave-gate-outcome';
import { readWaveRequestContext, waveReviewContextTaskId } from './wave-review-context';

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

/** The effect label every current-batch publication and its durable recovery share. */
const CURRENT_BATCH_LABEL = "wave-gate-current";

/** A published batch whose request count differs from its subject count. */
export type BatchSubjectMismatch = Readonly<{
  kind: "batch-subject-mismatch";
  published: number;
  subjects: number;
  message: string;
}>;

/**
 * Pair each published request with the batch subject it was published for.
 * Publication preserves the batch's request order, and `WaveRequestBatch`
 * keeps `requests` index-aligned with `subjects`, so the correlation is stated
 * once here: a count mismatch is a publication defect, returned as a typed
 * refusal before any request is paired, rather than checked per element.
 *
 * The check is deliberately EXACT equality, in both directions — a
 * tightening of the per-element lookup it replaced, which refused only a
 * published request with no subject and let a publication with FEWER
 * requests than subjects through. Fewer requests means some batch subject
 * was never published for, which the index-alignment invariant forbids.
 */
export function withBatchSubjects<R>(
  published: readonly R[],
  subjects: WaveRequestBatch["subjects"],
): DomainResult<readonly (readonly [R, WaveRequestBatch["subjects"][number]])[], BatchSubjectMismatch> {
  if (published.length !== subjects.length) {
    return { ok: false, error: Object.freeze({
      kind: "batch-subject-mismatch",
      published: published.length,
      subjects: subjects.length,
      message: `published ${published.length} Wave review request(s) for ${subjects.length} batch subject(s)`,
    }) };
  }
  return { ok: true, value: Object.freeze(published.map((request, index) => [request, subjects[index]!] as const)) };
}

/**
 * Resume phase: publish and install the initial batch, install a fresh batch
 * for Tasks that need one, or prove the collecting batch's exact durable
 * publication — republishing the deterministic batch when its persisted
 * prefix is partial.
 */
export async function reconcileWaveReviewIssuance(
  context: WaveResumeContext,
  graph: ReturnType<StateManager["load"]>,
  issued: readonly AgentRequestAuthority[],
): Promise<WavePhase<IssuedWaveReviewBatch>> {
  const { handle, manager, registration, wave } = context;
  // The three issuance paths differ only in the graph they derive the
  // deterministic batch from and in what they do after publishing it under
  // the one current-batch effect label.
  const batchFor = (state: ReturnType<StateManager["load"]>): WaveRequestBatch =>
    waveRequests(handle, registration, state, 1, observeTaskGraphProjectBoundary(manager.getPath()));
  const publishCurrent = (
    requests: Parameters<typeof publishReviewInitialBatch>[1],
    packets: Parameters<typeof publishReviewInitialBatch>[2],
  ) => publishReviewInitialBatch(handle, requests, packets, CURRENT_BATCH_LABEL, registration);
  const initialBatchMissingOrPartial = graph.wave_review_epoch === undefined &&
    graph.tasks.every((task) => !registration.taskIds.includes(task.id) || task.review_run === undefined);
  if (initialBatchMissingOrPartial) {
    const batch = batchFor(graph);
    // Publication is deterministic and idempotent per context/request slot.
    // Re-running the complete effect reconciles a crash after any strict
    // prefix of requests was reserved instead of treating partial issuance
    // as a corrupt batch and stranding the active replacement authority.
    const published = await publishCurrent(batch.requests, batch.packets);
    if (!published.ok) return settled(failed(published.message));
    const action = published.action;
    // A publication that broke index alignment is refused before its Review
    // Packets are installed, so no run collects for a mispublished batch.
    const paired = withBatchSubjects(action.requests, batch.subjects);
    if (!paired.ok) return settled(waveBlocked(handle, paired.error.message));
    await installWaveReviewRuns(manager, registration, batch);
    return settled({ ok: true, action: {
      ...action,
      requests: paired.value.map(([request, subject]) => ({
        ...request,
        task: subject.taskId === null
          ? `${request.task}\nSpec-check Wave ${wave}.`
          : `${request.task}\nReview Task ${subject.taskId}.`,
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
    const batch = batchFor(refreshed);
    await installWaveReviewRuns(manager, registration, batch);
    const published = await publishCurrent(batch.requests, batch.packets);
    return settled(published.ok ? { ok: true, action: published.action } : failed(published.message));
  }

  refreshed = manager.load();
  const currentRuns = refreshed.tasks.filter((task) =>
    registration.taskIds.includes(task.id) && task.review_run !== undefined);
  let currentIssued = issued;
  if (currentRuns.length > 0) {
    const epoch = refreshed.wave_review_epoch;
    if (epoch?.runId !== handle.runId || epoch.wave !== wave) {
      return settled(waveBlocked(handle, "active Wave Review Packets lack exact persisted batch epoch authority"));
    }
    const candidates: PersistedWaveBatchCandidate<Readonly<{ authority: AgentRequestAuthority; packet: ContextPacket }>>[] = [];
    for (const authority of issued.filter((request) => request.program === "wave-gate" && request.attempt === 1)) {
      const read = readWaveRequestContext(handle, authority);
      if (!read.ok) return settled(read.result);
      if (read.context.kind === "loaded" && read.context.value.batchEpoch === epoch.batchEpoch) {
        candidates.push({
          role: authority.role,
          taskId: waveReviewContextTaskId(read.context),
          value: { authority, packet: read.packet },
        });
      }
    }
    const persisted = classifyPersistedWaveBatch(registration.taskIds, candidates);
    if (persisted.kind === "incomplete") {
      const expectedBatch = batchFor(refreshed);
      if (expectedBatch.batchEpoch !== epoch.batchEpoch) {
        return settled(waveBlocked(handle, "persisted current Wave review batch differs from deterministic protected authority"));
      }
      const republished = await publishCurrent(expectedBatch.requests, expectedBatch.packets);
      if (!republished.ok) return settled(failed(republished.message));
      return settled({ ok: true, action: republished.action });
    }
    const inputs = persisted.ordered.map(({ authority }) => Object.freeze({
      authority,
      context: Object.freeze({
        digest: authority.contextDigest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${authority.contextDigest}.json` }),
      }),
    }));
    const recovered = durableRefutationRequests(
      handle, inputs, publicationResolver(handle), CURRENT_BATCH_LABEL,
    );
    if (recovered.kind === "corrupt") return settled(waveBlocked(handle, recovered.message));
    if (recovered.kind === "found") {
      currentIssued = Object.freeze(recovered.requests.map(({ authority }) => authority));
    } else {
      const published = await publishCurrent(inputs, persisted.ordered.map(({ packet }) => packet));
      if (!published.ok) return settled(failed(published.message));
      currentIssued = Object.freeze(published.requests.map(({ authority }) => authority));
    }
  }
  return proceed(Object.freeze({ refreshed, currentRuns, currentIssued }));
}
