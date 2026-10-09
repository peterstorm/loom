/**
 * Refutation Panel request issuance shared by the standalone and Wave Gate
 * programs: executable verifier spawn tasks (attempt 2 names the rejection),
 * and recovery-or-publication of one verifier's attempt-2 retry, routing a
 * terminal capture rejection back to the panel as data.
 */
import { sameAgentRequestAuthority, type AgentRequestAuthority, type PublicationAuthorityResolver, type SpawnRequest } from '../../../core/orchestration-contract';
import { refutationRetryTask } from '../../../core/reviewer-retry';
import type { PreparedVerifierRequest } from './refutation-verifiers';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { durableCaptureRejection, durableRefutationRequests } from './durable-requests';
import { publishLegacyInitialBatch } from './request-publication';
import { renderSpawnTask } from './spawn-task';

export function executableRefutationRequests(
  handle: RunDirHandle,
  requests: readonly SpawnRequest[],
  standalone: boolean,
  retryDiagnostic: string | null = null,
): readonly Readonly<SpawnRequest & { task: string }>[] {
  return requests.map((request) => {
    const task = renderSpawnTask(
      handle,
      request.authority,
      "Read the immutable context packet at LOOM_CONTEXT_PATH, then complete the exact pending Refutation Panel request.",
      { standalone },
    );
    return Object.freeze({
      ...request,
      task: request.authority.attempt === 2 ? refutationRetryTask(task, retryDiagnostic) : task,
    });
  });
}

/**
 * What recovering (or publishing) one refutation attempt-2 retry turned up.
 *
 * `capture-rejected` is a PANEL rejection, not a publication failure: the
 * attempt's bytes never landed (the harness terminally rejected the capture),
 * so re-issuing the spawn can never land evidence. The failure carries the
 * rejection and the durable attempt-2 request AS DATA — the identity the
 * panel rejection records — so the caller routes it into the panel's own
 * rejection path (`rejectRefutationVerdict`) instead of matching prose. The
 * tombstone proves the attempt was issued, so the durable request is
 * recoverable here; `null` request degrades only when the prepared input
 * itself is gone, and the caller falls back to the raw message.
 */
export type RefutationRetryRecovery =
  | Readonly<{ ok: true; request: SpawnRequest }>
  | Readonly<{ ok: false; kind: "capture-rejected"; rejection: string; request: SpawnRequest | null; message: string }>
  | Readonly<{ ok: false; kind: "unrecoverable"; message: string }>;

export async function recoverOrPublishRefutationRetry(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  retryInputs: readonly PreparedVerifierRequest[],
  resolver: PublicationAuthorityResolver,
  label: string,
): Promise<RefutationRetryRecovery> {
  const rejection = await durableCaptureRejection(handle, authority);
  const prepared = retryInputs.find(({ input }) => input.authority.requestId === authority.requestId);
  const retryLabel = `${label}-retry:${authority.slotId}`;
  if (rejection !== null) {
    // The attempt-2 capture was TERMINALLY rejected: the capture runtime
    // refuses any future capture for this slot, so re-issuing the spawn can
    // never land evidence — that is the attempt-2 doom loop this guard exists
    // to break. The tombstone proves the attempt was issued, so the durable
    // request the panel rejection records is recoverable here; the panel
    // machine owns the rejection decision, and the failure carries it as data
    // instead of leaving the caller to match prose.
    const recovered = prepared === undefined ? { kind: "absent" as const }
      : durableRefutationRequests(handle, [prepared.input], resolver, retryLabel);
    return {
      ok: false,
      kind: "capture-rejected" as const,
      rejection,
      request: recovered.kind === "found" ? recovered.requests[0]! : null,
      message: `refutation attempt 2 exhausted after capture rejection: ${rejection}`,
    };
  }
  // The prepared retry is the panel's recorded (or, for an unrecorded panel,
  // freshly minted) authority: it is compared as it is, never re-minted
  // against today's catalog (ADR-0023).
  if (prepared === undefined || !sameAgentRequestAuthority(prepared.input.authority, authority)) {
    return { ok: false, kind: "unrecoverable" as const, message: `refutation retry ${authority.requestId} is not exact prepared attempt-2 authority` };
  }
  const recovered = durableRefutationRequests(handle, [prepared.input], resolver, retryLabel);
  if (recovered.kind === "corrupt") return { ok: false, kind: "unrecoverable" as const, message: recovered.message };
  if (recovered.kind === "found") return { ok: true, request: recovered.requests[0]! };
  const published = await publishLegacyInitialBatch(handle, [prepared.input], [prepared.packet], retryLabel);
  return published.ok
    ? { ok: true, request: published.requests[0]! }
    : { ok: false, kind: "unrecoverable" as const, message: published.message };
}
