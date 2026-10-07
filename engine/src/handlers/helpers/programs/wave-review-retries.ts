/**
 * Wave review attempt-2 retries: derive each rejected attempt 1's canonical
 * attempt-2 request and diagnostic-rich packet (or adopt its compatible
 * persisted retry), record issuance under the state lock, and the resume
 * phases that drive reviewer-slot and spec-check retries to exhaustion.
 */
import { canonicalStructuralEquals, parseRequestId, parseStoredAgentRequestAuthority, type AgentRequestAuthority, type InitialSpawnRequestInput, type SpawnRequest } from '../../../core/orchestration-contract';
import { encodeByteSection, parseContextPacket, contextPacketDigest, type ContextPacket } from '../../../core/context-packets';
import { captureKey } from '../../../core/harness-capture';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import type { StateManager } from '../../../state-manager';
import type { IssuedWaveReviewerProtocol } from '../../../core/review-output';
import { WAVE_REVIEW_AGENTS } from '../../../core/model-profiles';
import { renderCurrentWaveRetryTask, specCheckRetryDiagnostic, waveRetryDiagnostic } from '../../../core/reviewer-retry';
import { persistedWaveAttemptTwoCompatibilityProblem } from '../../../core/wave-gate-membership';
import { reviewerRejectionReason } from '../../../core/wave-reviewer-transcript';
import { markWaveSpecCheckRetryIssuedTransition, markWaveTaskReviewRetriesIssuedTransition, type WaveTaskReviewRetry } from '../../../core/wave-review-issuance';
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import { durableCaptureRejection, durableRefutationRequests, isCaptureRejectionOf, publicationResolver } from './durable-requests';
import { failed, type FacadeDriveResult } from './program-result';
import { publishLegacyInitialBatch, publishReviewInitialBatch } from './request-publication';
import { renderReviewProgramSpawn, renderSpawnTask } from './spawn-task';
import { proceed, rederive, settled, waveBlocked, type WavePhase } from './wave-gate-outcome';
import { applyWaveFacadeSubmission } from './wave-gate-submission';
import { issuedWaveProtocol, readWaveRequestContext } from './wave-review-context';

export function deriveWaveAttemptTwo(
  handle: RunDirHandle,
  attemptOne: AgentRequestAuthority,
  retryReason: string | null = null,
): Readonly<{ request: InitialSpawnRequestInput; packet: ContextPacket }> {
  if (attemptOne.program !== "wave-gate" || attemptOne.attempt !== 1) {
    throw new Error(`slot ${attemptOne.slotId} has no canonical Wave attempt-1 authority`);
  }
  const requestId = parseRequestId(attemptOne.requestId.replace(/:1$/, ":2"));
  if (!requestId.ok || requestId.value === attemptOne.requestId) {
    throw new Error(`Wave request ${attemptOne.requestId} cannot derive canonical attempt-2 identity`);
  }
  const original = handle.readContext(attemptOne.contextDigest);
  if (!original.ok) throw new Error(original.error.message);
  if (original.value.schemaVersion === 2 && retryReason === null) {
    throw new Error("current Wave reviewer retry requires its rejection diagnostic");
  }
  // Attempt 1 was rejected. Surface the parser's exact reason plus the exact
  // required schema so the model corrects the specific defect instead of
  // re-emitting the same malformed shape into its final attempt — a silent
  // identical retry is how a whole reviewer batch exhausts its allowance.
  const variableContext = retryReason === null
    ? original.value.variableContext
    : (() => {
        const diagnostic = waveRetryDiagnostic(retryReason, original.value.schemaVersion === 2 ? 2 : 1);
        const section = encodeByteSection("wave-review-attempt-1-rejection", diagnostic);
        if (!section.ok) throw new Error(section.error.message);
        return Object.freeze([...original.value.variableContext, section.value]);
      })();
  const retryPacket = { ...original.value, requestId: requestId.value, variableContext };
  const packet = parseContextPacket({ ...retryPacket, digest: contextPacketDigest(retryPacket) });
  if (!packet.ok) throw new Error(packet.error.message);
  // Stored mode: attemptOne was read back from this run's durable artifacts, so
  // its role->profile/skill couplings belong to the policy tables in force when
  // it was ISSUED. Re-checking them against today's tables strands every run on
  // disk across an agent's profile promotion, and would also disagree with
  // persistedWaveAttemptTwoCompatibilityProblem, which derives this same
  // attempt-2 in stored mode.
  const authority = parseStoredAgentRequestAuthority({
    ...attemptOne,
    requestId: requestId.value,
    attempt: 2,
    contextDigest: packet.value.digest,
    outputSlot: {
      kind: "fixed-artifact-slot",
      path: attemptOne.outputSlot.path.replace(/attempt-1\.raw$/, "attempt-2.raw"),
    },
  });
  if (!authority.ok) throw new Error(authority.error.violations.map(({ message }) => message).join("; "));
  return Object.freeze({
    request: Object.freeze({
      authority: authority.value,
      context: Object.freeze({
        digest: packet.value.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` }),
      }),
    }),
    packet: packet.value,
  });
}

function persistedWaveReviewerRetry(
  handle: RunDirHandle,
  taskId: string,
  protocol: IssuedWaveReviewerProtocol,
  derived: ReturnType<typeof deriveWaveAttemptTwo>,
  storedRequests: readonly AgentRequestAuthority[],
): ReturnType<typeof deriveWaveAttemptTwo> {
  const first = protocol.request;
  const stored = storedRequests.filter((request) => request.program === "wave-gate" &&
    request.slotId === first.slotId && request.role === first.role && request.attempt === 2);
  if (stored.length > 1) throw new Error(`Task ${taskId}/${first.role} has multiple stored retry authorities`);
  if (stored[0] === undefined) return derived;
  const second = handle.readContext(stored[0].contextDigest);
  if (!second.ok) throw new Error(second.error.message);
  const problem = persistedWaveAttemptTwoCompatibilityProblem(first, stored[0], protocol.packet, second.value);
  if (problem !== null) throw new Error(problem);
  if (protocol.protocolVersion === 2 && derived.packet.digest !== second.value.digest) {
    throw new Error("current retry diagnostic differs from the captured attempt-1 rejection");
  }
  return { request: { authority: stored[0], context: { digest: second.value.digest,
    slot: { kind: "fixed-artifact-slot", path: `contexts/${second.value.digest}.json` } } }, packet: second.value };
}

export async function currentWaveTaskReviewRetries(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  graph: ReturnType<StateManager["load"]>,
  issued: readonly AgentRequestAuthority[],
): Promise<readonly WaveTaskReviewRetry[]> {
  const events = await handle.readEvents();
  const storedRequests = handle.readIssuedRequests();
  if (!storedRequests.ok) throw new Error(storedRequests.error.message);
  const rejectionReason = (authority: AgentRequestAuthority): string | null => {
    const found = events.find(({ event }) => isCaptureRejectionOf(event, authority));
    if (found === undefined || typeof found.event !== "object" || found.event === null) {
      const marker = handle.readCaptureRejection(authority);
      if (!marker.ok) throw new Error(marker.error.message);
      return marker.value;
    }
    const diagnostic = (found.event as Record<string, unknown>).diagnostic;
    return typeof diagnostic === "string" && diagnostic.trim() !== "" ? diagnostic : "capture was rejected without a diagnostic";
  };
  return graph.tasks.filter((task) => registration.taskIds.includes(task.id) && task.review_run !== undefined)
    .flatMap((task) => {
      const run = task.review_run!;
      if (run.slot_authority === undefined || run.slot_authority.length !== run.expected_agents.length ||
          (run.reviewer_protocol !== undefined && !canonicalStructuralEquals(run.expected_agents, WAVE_REVIEW_AGENTS))) {
        throw new Error(`Task ${task.id} active Review Run lacks engine-issued exact slot authority`);
      }
      return run.expected_agents.flatMap((agent, index) => {
        if (run.evidence.some((entry) => entry.agent === agent)) return [];
        const slot = run.slot_authority![index];
        if (slot === undefined || slot.agent !== agent) {
          throw new Error(`Task ${task.id}/${agent} active Review Run slot authority drifted`);
        }
        const attemptOne = issued.find((authority) => authority.program === "wave-gate" && authority.attempt === 1 &&
          authority.slotId === slot.slot_id && authority.role === agent);
        if (attemptOne === undefined) {
          throw new Error(`Task ${task.id}/${agent} has no issued attempt-1 authority for current packet ${run.packet_id}`);
        }
        const captured = handle.readTranscriptBytes(attemptOne);
        const retryReason = captured.ok
          ? reviewerRejectionReason(task, agent, captured.value, issuedWaveProtocol(handle, registration, attemptOne)) ??
            "attempt 1 was accepted but did not close this outstanding slot"
          : rejectionReason(attemptOne) ?? task.review_error ?? captured.error.message;
        const protocol = issuedWaveProtocol(handle, registration, attemptOne);
        const derived = deriveWaveAttemptTwo(handle, attemptOne, retryReason);
        const retry = persistedWaveReviewerRetry(handle, task.id, protocol, derived, storedRequests.value);
        return [Object.freeze({
          taskId: task.id,
          packetId: run.packet_id,
          agent,
          slotId: slot.slot_id,
          retryReason,
          protocol,
          request: retry.request,
          packet: retry.packet,
        })];
      });
    });
}

export async function markWaveTaskReviewRetriesIssued(
  manager: StateManager,
  retries: readonly WaveTaskReviewRetry[],
): Promise<void> {
  if (retries.length === 0) return;
  await manager.update((locked) => {
    const next = markWaveTaskReviewRetriesIssuedTransition(locked, retries);
    if (!next.ok) throw new Error(next.error.message);
    return next.value;
  });
}

async function markWaveSpecCheckRetryIssued(
  manager: StateManager,
  authority: AgentRequestAuthority,
  batchEpoch: string,
): Promise<void> {
  if (authority.role !== "spec-check-invoker" || authority.attempt !== 2) {
    throw new Error("spec-check retry issuance requires exact attempt-2 authority");
  }
  await manager.update((locked) => {
    const next = markWaveSpecCheckRetryIssuedTransition(locked, authority, batchEpoch);
    if (!next.ok) throw new Error(next.error.message);
    return next.value;
  });
}

/** Resume phase: while any registered Task's Review Packet is collecting,
 *  recover or publish every outstanding slot's attempt-2 retry, replay
 *  captured retries, and report exhaustion once no retry remains spawnable. */
export async function driveWaveReviewRetries(
  handle: RunDirHandle,
  manager: StateManager,
  registration: RegisteredWaveGateProgram,
  currentIssued: readonly AgentRequestAuthority[],
  captured: ReadonlySet<string>,
): Promise<WavePhase> {
  const refreshed = manager.load();
  const collecting = refreshed.tasks.some((task) => registration.taskIds.includes(task.id) && task.review_run !== undefined);
  if (collecting) {
    const retries = await currentWaveTaskReviewRetries(handle, registration, refreshed, currentIssued);
    if (retries.length === 0) return settled(waveBlocked(handle, "active Wave Review Packets have no recoverable outstanding reviewer slots"));
    const resolver = publicationResolver(handle);
    const durableRequests: SpawnRequest[] = [];
    for (const retry of retries) {
      const label = `wave-gate-retry:${retry.slotId}`;
      const recovered = durableRefutationRequests(handle, [retry.request], resolver, label);
      if (recovered.kind === "corrupt") return settled(waveBlocked(handle, recovered.message));
      if (recovered.kind === "found") {
        durableRequests.push(...recovered.requests);
        continue;
      }
      const published = await publishReviewInitialBatch(handle, [retry.request], [retry.packet], label, registration);
      if (!published.ok) return settled(failed(published.message));
      durableRequests.push(...published.requests);
    }
    await markWaveTaskReviewRetriesIssued(manager, retries);
    const spawnRetries = (requests: readonly SpawnRequest[]): FacadeDriveResult => ({ ok: true, action: {
      kind: "spawn-batch", runId: handle.runId,
      requests: requests.map((request) => {
        const retry = retries.find(({ slotId }) => slotId === request.authority.slotId);
        const spawn = renderReviewProgramSpawn(handle, request.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH, then retry the exact current Wave Review Packet slot.", registration);
        return {
          ...request,
          task: renderCurrentWaveRetryTask(spawn.task, spawn.route, retry === undefined
            ? { kind: "unattributed" }
            : { kind: "rejected", reason: retry.retryReason, protocolVersion: retry.protocol.protocolVersion }),
        };
      }),
    } });
    const captureRejected: { request: SpawnRequest; rejection: string }[] = [];
    for (const request of durableRequests) {
      const rejection = await durableCaptureRejection(handle, request.authority);
      if (rejection !== null) captureRejected.push({ request, rejection });
    }
    const capturedRetries = durableRequests.filter(({ authority }) =>
      captured.has(captureKey(authority.slotId, authority.attempt)));
    for (const request of capturedRetries) {
      const bytes = handle.readTranscriptBytes(request.authority);
      if (!bytes.ok) return settled(waveBlocked(handle, bytes.error.message));
      const applied = await applyWaveFacadeSubmission(handle, request.authority, bytes.value);
      if (!applied.ok) return settled(waveBlocked(handle, `captured Wave retry could not be reconciled: ${applied.message}`));
    }
    const afterReplay = manager.load();
    const packetRejected = capturedRetries.filter(({ authority }) => {
      const retry = retries.find(({ slotId }) => slotId === authority.slotId);
      const task = retry === undefined ? undefined : afterReplay.tasks.find(({ id }) => id === retry.taskId);
      return retry === undefined || (task?.review_run !== undefined &&
        !task.review_run.evidence.some(({ agent }) => agent === retry.agent));
    });
    const rejectedRequestIds = new Set(captureRejected.map(({ request }) => request.authority.requestId));
    const pendingRetries = durableRequests.filter(({ authority }) =>
      !captured.has(captureKey(authority.slotId, authority.attempt)) &&
      !rejectedRequestIds.has(authority.requestId));
    // A terminal retry in one slot must not hide exact attempt-2 authority
    // that is still safely spawnable in another. Drain every pending slot
    // before reporting exhaustion, so restart sees one coherent terminal
    // reviewer generation rather than a mixed exhausted/pending state.
    if (pendingRetries.length > 0) return settled(spawnRetries(pendingRetries));
    if (captureRejected.length > 0) {
      return settled(waveBlocked(handle, `Wave reviewer attempt 2 exhausted after capture rejection: ${captureRejected[0]!.rejection}`));
    }
    if (packetRejected.length > 0) {
      return settled(waveBlocked(handle, `Wave reviewer attempt 2 exhausted without accepted packet evidence: ${packetRejected.map(({ authority }) => authority.role).join(", ")}`));
    }
    if (capturedRetries.length > 0) return rederive;
    return settled(waveBlocked(handle, "active Wave Review Packets have no recoverable attempt-2 reviewer slots"));
  }
  return proceed();
}

/** Resume phase: until the current Wave carries accepted spec-check evidence,
 *  recover or publish the current epoch's spec-check attempt-2 retry and
 *  replay it once captured. Proceeds with the freshly loaded graph. */
export async function driveWaveSpecCheckRetry(
  handle: RunDirHandle,
  manager: StateManager,
  registration: RegisteredWaveGateProgram,
  currentIssued: readonly AgentRequestAuthority[],
  captured: ReadonlySet<string>,
): Promise<WavePhase<ReturnType<StateManager["load"]>>> {
  const refreshed = manager.load();
  const specAccepted = refreshed.spec_check?.wave === registration.input.wave &&
    refreshed.spec_check.verdict !== "EVIDENCE_CAPTURE_FAILED";
  if (!specAccepted) {
    // Attempt-2 must derive from the CURRENT epoch's attempt-1, never the
    // first spec-check authority in the issued journal. The journal spans
    // every batch epoch a run has installed, and in this non-collecting
    // phase currentIssued is the unfiltered journal: a role-only find picks
    // an OLD epoch's authority whose fixed packet binds an older batchEpoch,
    // and the captured retry then fails the exact-epoch gate in
    // applyWaveFacadeSubmission as a durable terminal block (loom#20 Finding
    // 5). Reviewer retries are immune because their attempt-1 lookup is keyed
    // by current-packet slot identity; mirror that binding here by matching
    // the persisted epoch's batchEpoch before deriving the attempt-2 context.
    const epoch = refreshed.wave_review_epoch;
    // Linear scan so an unreadable/corrupt context can DEGRADE to a wave
    // verdict (like the sibling candidate scan above) instead of throwing
    // out of the facade: a pruned context packet must not hard-fail resume.
    // Fail-closed note: the batchEpoch lives INSIDE the context, so the
    // epoch cannot be filtered before reading — every attempt-1 context is
    // read, and a corrupt context for ANY candidate attempt-1 (even a stale
    // one from an older epoch) blocks resume rather than risking a retry
    // derived from an identity that cannot be proven current. That is the
    // same judgment applyWaveFacadeSubmission would make on the retry
    // packet, surfaced earlier with a better diagnostic.
    let attemptOne: AgentRequestAuthority | undefined;
    if (epoch !== undefined) {
      for (const authority of currentIssued) {
        if (authority.program !== "wave-gate" || authority.attempt !== 1 || authority.role !== "spec-check-invoker") continue;
        const read = readWaveRequestContext(handle, authority, false);
        if (!read.ok) return settled(read.result);
        const context = read.context;
        if (context.kind === "loaded" && context.value.batchEpoch === epoch.batchEpoch) {
          attemptOne = authority;
          break;
        }
      }
    }
    if (attemptOne === undefined || epoch === undefined) {
      return settled(waveBlocked(handle, "current Wave spec-check has no issued attempt-1 authority"));
    }
    const retry = deriveWaveAttemptTwo(handle, attemptOne);
    const recovered = durableRefutationRequests(
      handle, [retry.request], publicationResolver(handle), "wave-gate-spec-retry",
    );
    if (recovered.kind === "corrupt") return settled(waveBlocked(handle, recovered.message));
    let durable: SpawnRequest;
    if (recovered.kind === "found") durable = recovered.requests[0]!;
    else {
      // The spec-check slot is an explicit extraction-only request (FR-001):
      // it publishes with no emission authority, so its retry task advertises
      // no emission tool regardless of the parent route.
      const published = await publishLegacyInitialBatch(handle, [retry.request], [retry.packet], "wave-gate-spec-retry");
      if (!published.ok) return settled(failed(published.message));
      durable = published.requests[0]!;
    }
    await markWaveSpecCheckRetryIssued(manager, durable.authority, epoch.batchEpoch);
    const captureRejection = await durableCaptureRejection(handle, durable.authority);
    if (captureRejection !== null) {
      return settled(waveBlocked(handle, `Wave spec-check attempt 2 exhausted after capture rejection: ${captureRejection}`));
    }
    if (captured.has(captureKey(durable.authority.slotId, durable.authority.attempt))) {
      const bytes = handle.readTranscriptBytes(durable.authority);
      if (!bytes.ok) return settled(waveBlocked(handle, bytes.error.message));
      const applied = await applyWaveFacadeSubmission(handle, durable.authority, bytes.value);
      if (!applied.ok) return settled(waveBlocked(handle, `captured Wave spec-check retry could not be reconciled: ${applied.message}`));
      const accepted = manager.load().spec_check;
      if (accepted?.wave !== registration.input.wave || accepted.verdict === "EVIDENCE_CAPTURE_FAILED") {
        return settled(waveBlocked(handle, "Wave spec-check attempt 2 exhausted without accepted current-wave evidence"));
      }
      return rederive;
    }
    const attemptOneFailure = refreshed.spec_check?.wave === registration.input.wave &&
      refreshed.spec_check.verdict === "EVIDENCE_CAPTURE_FAILED"
      ? refreshed.spec_check.error
      : "attempt 1 produced no accepted current-wave spec-check evidence";
    return settled({ ok: true, action: {
      kind: "spawn-batch", runId: handle.runId,
      requests: [{
        ...durable,
        // Extraction-only render: the spec-check slot carries no emission
        // descriptor and keeps the caller's instruction verbatim (FR-020).
        task: [
          renderSpawnTask(handle, durable.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH, then retry the exact current Wave spec-check slot."),
          specCheckRetryDiagnostic(attemptOneFailure),
        ].join("\n"),
      }],
    } });
  }
  return proceed(refreshed);
}
