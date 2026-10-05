/**
 * Initial batch publication: publish every Context Packet, reserve every
 * request, durably write the batch receipt, then reconcile issuance and
 * render each spawn task. Two routes — the archived extraction-only route and
 * the review-program route whose emission authority is required in its type.
 */
import { createHash } from 'node:crypto';
import { publishStandalonePanelView } from '../../../orchestration/standalone-panel-context';
import {
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  parseEffectId,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
  type AgentRequestAuthority,
  type InitialSpawnRequestInput,
  type SpawnRequest,
} from '../../../core/orchestration-contract';
import type { ContextPacket, StandaloneReviewerContextPacketV3 } from '../../../core/context-packets';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { parseRegisteredFacadeProgram, type RegisteredReviewProgram } from './registration';
import { publicationFile } from './durable-requests';
import { renderReviewProgramSpawnTask, renderSpawnTask } from './spawn-task';
import { reviewerEmissionEligible } from '../../../core/reviewer-emission-route';
import type { FacadePublishedSpawnBatch } from './program-result';

/** Private publication core: `emissionAuthority` is REQUIRED and typed
 *  `RegisteredReviewProgram | null` — `null` is the explicit archived
 *  extraction-only route, a registration is the issued-descriptor route, and
 *  there is no third (implicit/undefined) state. The exported wrappers below
 *  are honest about which state they hand the core. */
async function publishInitialBatch(
  handle: RunDirHandle,
  requests: readonly InitialSpawnRequestInput[],
  packets: readonly (ContextPacket | StandaloneReviewerContextPacketV3)[],
  label: string,
  emissionAuthority: RegisteredReviewProgram | null,
): Promise<Readonly<{ ok: true; requests: readonly SpawnRequest[]; action: FacadePublishedSpawnBatch }> | Readonly<{ ok: false; message: string }>> {
  const effectId = parseEffectId(`effect:${label}:${createHash("sha256").update(requests.map((entry) =>
    (entry.authority as AgentRequestAuthority).requestId).join("|")).digest("hex")}`);
  if (!effectId.ok) return { ok: false, message: effectId.error.message };
  const intent = prepareInitialBatchPublicationIntent(handle.runId, effectId.value, requests);
  if (!intent.ok) return { ok: false, message: intent.error.message };
  for (const packet of packets) {
    const published = await handle.publishContext(packet);
    if (!published.ok) return { ok: false, message: published.error.message };
    if (packet.schemaVersion === 1 && packet.role === "review-verifier-agent") {
      const raw = handle.readProgramRegistration(16_777_216);
      if (!raw.ok) return { ok: false, message: raw.error.message };
      const registration = parseRegisteredFacadeProgram(raw.value);
      if (registration.kind === "invalid") return { ok: false, message: registration.message };
      if (registration.kind === "registered" && registration.program.kind === "standalone-review" && registration.program.schemaVersion === 3) {
        await publishStandalonePanelView(handle, packet);
      }
    }
  }
  for (const request of intent.value.issuedRequests) {
    const reserved = await handle.reserveRequest(request.authority);
    if (!reserved.ok) return { ok: false, message: reserved.error.message };
  }
  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    kind: "batch-published" as const,
    effectId: intent.value.identity.effectId,
    runId: intent.value.identity.runId,
    requestIds: intent.value.requestIds,
    contextDigests: intent.value.contextDigests,
    issuedRequests: intent.value.issuedRequests,
    publicationDigest: intent.value.identity.publicationDigest,
  });
  const receiptBytes = Buffer.from(JSON.stringify(receipt), "utf8");
  const publishedReceipt = await handle.publishArtifactSet([{ relativePath: publicationFile(effectId.value), bytes: [...receiptBytes] }]);
  if (!publishedReceipt.ok) return { ok: false, message: publishedReceipt.error.message };
  const effectPort = createInitialPublicationEffectPort(() => ({ ok: true, value: Object.freeze([...receiptBytes]) }));
  const claimPort = createAtomicInitialPublicationClaimPort((request) => ({ ok: true, value: Object.freeze({
    schemaVersion: 1 as const,
    kind: "initial-publication-claimed" as const,
    key: request.key,
    identity: request.identity,
  }) }));
  const issuance = createInitialBatchPublicationReconciler(effectPort, claimPort)(intent.value);
  if (!issuance.ok) return { ok: false, message: issuance.error.message };
  const action = spawnBatchAction(issuance.value, requests);
  if (!action.ok) return { ok: false, message: action.error.message };
  const standalone = label.startsWith("standalone");
  return { ok: true, requests: action.value.requests, action: Object.freeze({
    ...action.value,
    requests: Object.freeze(action.value.requests.map((request) => Object.freeze({
      ...request,
      task: emissionAuthority === null
        ? renderSpawnTask(handle, request.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.", { standalone })
        : renderReviewProgramSpawnTask(handle, request.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.", emissionAuthority, { standalone }),
    }))),
  }) };
}

/** Archived route (schema-1 registration, panel verdicts, extraction-only
 *  requests): publishes with NO emission authority, rendering every task
 *  extraction-only. Fails closed before any durable effect when any request is
 *  emission-eligible but the run's durable program registration does not prove
 *  an archived schema-1 review program — including when that registration
 *  cannot be read or parsed. */
export async function publishLegacyInitialBatch(
  handle: RunDirHandle,
  requests: readonly InitialSpawnRequestInput[],
  packets: readonly (ContextPacket | StandaloneReviewerContextPacketV3)[],
  label: string,
): Promise<Readonly<{ ok: true; requests: readonly SpawnRequest[]; action: FacadePublishedSpawnBatch }> | Readonly<{ ok: false; message: string }>> {
  const eligible = requests.some(({ authority }) => reviewerEmissionEligible(authority as AgentRequestAuthority));
  if (!eligible) return publishInitialBatch(handle, requests, packets, label, null);
  const raw = handle.readProgramRegistration(16_777_216);
  if (!raw.ok) {
    return { ok: false, message: `legacy publication route refused an emission-eligible request: the run's program registration is unreadable (${raw.error.message})` };
  }
  const registration = parseRegisteredFacadeProgram(raw.value);
  if (registration.kind !== "registered") {
    const reason = registration.kind === "invalid"
      ? registration.message
      : "no program registration is durably claimed for this run";
    return { ok: false, message: `legacy publication route refused an emission-eligible request: the run's program registration is unparseable (${reason})` };
  }
  const program = registration.program;
  if ((program.kind === "standalone-review" || program.kind === "wave-gate") && program.schemaVersion >= 2) {
    return { ok: false, message: `legacy publication route refused an emission-eligible request: the run's registered ${program.kind} program is current (schemaVersion ${program.schemaVersion}), not an archived schema-1 contract` };
  }
  return publishInitialBatch(handle, requests, packets, label, null);
}

/** Review-program publication requires issued descriptor authority in its
 *  type: the required `RegisteredReviewProgram` parameter makes publication
 *  without an emission authority unrepresentable on this route. */
export function publishReviewInitialBatch(
  handle: RunDirHandle,
  requests: readonly InitialSpawnRequestInput[],
  packets: readonly (ContextPacket | StandaloneReviewerContextPacketV3)[],
  label: string,
  emissionAuthority: RegisteredReviewProgram,
): ReturnType<typeof publishInitialBatch> {
  return publishInitialBatch(handle, requests, packets, label, emissionAuthority);
}
