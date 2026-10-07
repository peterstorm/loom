/**
 * Durable request recovery: the publication receipts a Run Directory holds,
 * the exact issued requests they prove, and the durable capture rejections
 * recorded against them. Every program's resume recovers issued requests here
 * — by parsing receipt bytes, never by re-deriving authority from prose —
 * before deciding whether a batch still needs publication.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  createPublicationAuthorityResolver,
  parseBatchPublishedReceipt,
  parseEffectId,
  parseIssuedSpawnRequest,
  sameAgentRequestAuthority,
  type AgentRequestAuthority,
  type BatchPublishedReceipt,
  type EffectId,
  type InitialSpawnRequestInput,
  type PublicationAuthorityResolver,
  type SpawnRequest,
} from '../../../core/orchestration-contract';
import { readRunBytesNoFollow, openDirectoryNoFollow, closeAnchoredDirectory, listDirectoryNamesNoFollow, readDirectoryFileNoFollow } from '../../../orchestration/no-follow-fs';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import type { ProgramParse } from './program-result';

export function publicationFile(effectId: string): string {
  return `publications/${createHash("sha256").update(effectId).digest("hex")}.json`;
}

export function publicationResolver(handle: RunDirHandle, maximumBytes?: number): PublicationAuthorityResolver {
  return createPublicationAuthorityResolver((lookup) => {
    try {
      const bytes = readRunBytesNoFollow(`${handle.runDirectory}/artifacts/${publicationFile(lookup.effectId)}`, maximumBytes);
      return { ok: true, value: Object.freeze([...bytes]) };
    } catch (error) {
      return { ok: false, error: {
        kind: "publication-authority-unavailable",
        field: "registration",
        message: error instanceof Error ? error.message : String(error),
      } };
    }
  });
}

/** Read the exact durable publication; reservation or packet hashes alone do not issue a request. */
export function publishedReviewerRequest(handle: RunDirHandle, request: AgentRequestAuthority, maximumBytes?: number): ProgramParse<SpawnRequest> {
  const reserved = handle.readIssuedRequests();
  if (!reserved.ok) return { ok: false, message: "reviewer request reservations are unavailable" };
  const matching = reserved.value.filter((entry) => entry.requestId === request.requestId);
  if (matching.length !== 1 || !sameAgentRequestAuthority(matching[0]!, request)) {
    return { ok: false, message: "reviewer request does not match its exact durable reservation" };
  }
  const directory = openDirectoryNoFollow(join(handle.runDirectory, "artifacts", "publications"));
  try {
    const candidates: SpawnRequest[] = [];
    for (const name of listDirectoryNamesNoFollow(directory, maximumBytes === undefined ? undefined : 128)) {
      if (!name.endsWith(".json")) continue;
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readDirectoryFileNoFollow(directory, name, maximumBytes)));
      const receipt = parseBatchPublishedReceipt(raw);
      if (!receipt.ok || receipt.value.runId !== handle.runId || publicationFile(receipt.value.effectId) !== `publications/${name}`) {
        return { ok: false, message: "reviewer publication receipt is malformed or belongs to another run/effect" };
      }
      const batchIndex = receipt.value.issuedRequests.findIndex((entry) => entry.authority.requestId === request.requestId);
      if (batchIndex < 0) continue;
      const entry = receipt.value.issuedRequests[batchIndex]!;
      if (!sameAgentRequestAuthority(entry.authority, request)) {
        return { ok: false, message: "reviewer publication differs from the exact requested authority" };
      }
      const issued = parseIssuedSpawnRequest(publicationResolver(handle, maximumBytes), {
        ...entry, issuance: { schemaVersion: 1, kind: "issued-spawn-request-proof", runId: handle.runId,
          effectId: receipt.value.effectId, publicationDigest: receipt.value.publicationDigest, batchIndex },
      });
      if (!issued.ok) return { ok: false, message: "reviewer publication cannot prove request issuance" };
      candidates.push(issued.value);
    }
    return candidates.length === 1
      ? { ok: true, value: candidates[0]! }
      : { ok: false, message: "reviewer request must have exactly one durable publication" };
  } finally {
    closeAnchoredDirectory(directory);
  }
}

export type DurableRequestRecovery =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "found"; requests: readonly SpawnRequest[] }>
  | Readonly<{ kind: "corrupt"; message: string }>;

/**
 * The one durable-publication accessor: the receipt bytes are PARSED, never
 * cast, and must name exactly this run/effect — reservation or packet hashes
 * alone do not issue a request. Consumers recover either the parsed receipt
 * with its proven digest, or the absent/corrupt diagnosis; the digest is a
 * projection of the parsed receipt, never an independent untyped read.
 */
export function durablePublishedReceipt(
  handle: RunDirHandle,
  effectId: EffectId,
):
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "found"; receipt: BatchPublishedReceipt; digest: string }>
  | Readonly<{ kind: "corrupt"; message: string }> {
  const path = `${handle.runDirectory}/artifacts/${publicationFile(effectId)}`;
  let bytes: Buffer;
  try {
    bytes = readRunBytesNoFollow(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "corrupt", message: `cannot read durable publication receipt: ${error instanceof Error ? error.message : String(error)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    return { kind: "corrupt", message: `durable publication receipt is invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const receipt = parseBatchPublishedReceipt(raw);
  if (!receipt.ok) return { kind: "corrupt", message: `durable publication receipt is invalid: ${receipt.error.message}` };
  if (receipt.value.runId !== handle.runId || receipt.value.effectId !== effectId) {
    return { kind: "corrupt", message: "durable publication receipt does not match run/effect authority" };
  }
  return { kind: "found", receipt: receipt.value, digest: receipt.value.publicationDigest };
}

export function durablePublicationDigest(
  handle: RunDirHandle,
  effectId: EffectId,
): Readonly<{ kind: "absent" }> | Readonly<{ kind: "found"; digest: string }> | Readonly<{ kind: "corrupt"; message: string }> {
  const receipt = durablePublishedReceipt(handle, effectId);
  return receipt.kind === "found" ? { kind: "found", digest: receipt.digest } : receipt;
}

export function durableRefutationRequests(
  handle: RunDirHandle,
  inputs: readonly InitialSpawnRequestInput[],
  resolver: PublicationAuthorityResolver,
  label = "standalone-refutation",
): DurableRequestRecovery {
  const effectId = parseEffectId(`effect:${label}:${createHash("sha256").update(inputs.map((input) =>
    (input.authority as AgentRequestAuthority).requestId).join("|")).digest("hex")}`);
  if (!effectId.ok) return { kind: "corrupt", message: effectId.error.message };
  const publication = durablePublicationDigest(handle, effectId.value);
  if (publication.kind !== "found") return publication;
  const requests: SpawnRequest[] = [];
  for (const [batchIndex, input] of inputs.entries()) {
    const parsed = parseIssuedSpawnRequest(resolver, {
      ...input,
      issuance: { schemaVersion: 1, kind: "issued-spawn-request-proof", runId: handle.runId,
        effectId: effectId.value, publicationDigest: publication.digest, batchIndex },
    });
    if (!parsed.ok) return { kind: "corrupt", message: `durable refutation request is invalid: ${parsed.error.message}` };
    requests.push(parsed.value);
  }
  return { kind: "found", requests: Object.freeze(requests) };
}

/** Whether one journal event is the harness's capture rejection of exactly this request attempt. */
export function isCaptureRejectionOf(event: unknown, authority: AgentRequestAuthority): boolean {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
  const record = event as Record<string, unknown>;
  return record.kind === "request-capture-rejected" && record.requestId === authority.requestId &&
    record.slotId === authority.slotId && record.attempt === authority.attempt;
}

/** The durable capture-rejection diagnostic of one request attempt (journal
 *  event first, then the run's rejection marker), or `null` when none exists. */
export async function durableCaptureRejection(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
): Promise<string | null> {
  const events = await handle.readEvents();
  const rejected = events.find(({ event }) => isCaptureRejectionOf(event, authority));
  if (rejected !== undefined && typeof rejected.event === "object" && rejected.event !== null) {
    const diagnostic = (rejected.event as Record<string, unknown>).diagnostic;
    return typeof diagnostic === "string" ? diagnostic : "capture was rejected without a diagnostic";
  }
  const marker = handle.readCaptureRejection(authority);
  if (!marker.ok) throw new Error(marker.error.message);
  return marker.value;
}
