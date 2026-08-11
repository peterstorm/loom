/**
 * Harness-independent capture rules.
 *
 * Pi and Claude Code observe a finished Agent in completely different ways —
 * Pi sees a `tool_result` carrying content blocks, Claude sees a SubagentStop
 * payload naming a transcript. Everything AFTER "what did this Agent finally
 * say" is identical, and this module owns that shared part so the two adapters
 * cannot drift into disagreeing about which results are acceptable.
 *
 * Two rules do the work:
 *
 * Exactly one unambiguous final payload. A result carrying no final text and a
 * result carrying two candidate finals are BOTH rejections. Picking the last
 * candidate, or joining them, would silently invent a payload the Agent never
 * emitted — and the joined bytes would then be hashed and accepted as
 * evidence.
 *
 * Encode once, verbatim. The payload becomes UTF-8 bytes exactly as the
 * harness produced it: no trim, no join, no re-indent, no newline
 * normalisation. Byte equality across harnesses is a stated acceptance
 * criterion, and any normalisation applied on one side and not the other would
 * break it while leaving both sides looking correct.
 */

import { createHash } from "node:crypto";
import {
  canonicalRecord,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type DomainResult,
  type RequestId,
  type SemanticAttempt,
} from "./orchestration-contract";

export const CAPTURE_SCHEMA_VERSION = 1;

/** Why a result could not be accepted. Every case is audited, never silent. */
export type CaptureRejectionReason =
  | "no-final-payload"
  | "ambiguous-final-payload"
  | "empty-final-payload"
  | "unknown-request"
  | "identity-mismatch"
  | "attempt-mismatch"
  | "duplicate-capture"
  | "run-mismatch";

export type CaptureRejection = Readonly<{
  kind: "capture-rejected";
  reason: CaptureRejectionReason;
  requestId: RequestId | null;
  message: string;
}>;

const reject = <T>(
  reason: CaptureRejectionReason,
  requestId: RequestId | null,
  message: string,
): DomainResult<T, CaptureRejection> =>
  ({ ok: false, error: canonicalRecord({ kind: "capture-rejected" as const, reason, requestId, message }) });

const accept = <T>(value: T): DomainResult<T, CaptureRejection> => ({ ok: true, value });

// ---------------------------------------------------------------------------
// Final payload
// ---------------------------------------------------------------------------

/**
 * A candidate final payload observed by a harness adapter, with enough
 * provenance to explain an ambiguity rather than just reporting one.
 */
export type FinalPayloadCandidate = Readonly<{
  /** Where the adapter found it, e.g. "content[2].text" or "transcript.last". */
  origin: string;
  text: string;
}>;

export type FinalPayload = Readonly<{
  origin: string;
  text: string;
  bytes: readonly number[];
  byteLength: number;
  digest: ArtifactDigest;
}>;

const encoder = new TextEncoder();

/**
 * Reduce observed candidates to the single final payload, or reject.
 *
 * An adapter is expected to hand over every candidate it found rather than
 * pre-selecting one: pre-selection is exactly where "pick the last text block"
 * hides an ambiguity the engine should have refused.
 */
export function parseFinalPayload(
  candidates: readonly FinalPayloadCandidate[],
  requestId: RequestId | null = null,
): DomainResult<FinalPayload, CaptureRejection> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return reject("no-final-payload", requestId, "result carried no final text payload");
  }
  if (candidates.length > 1) {
    return reject(
      "ambiguous-final-payload",
      requestId,
      `result carried ${candidates.length} candidate final payloads (${candidates.map(({ origin }) => origin).join(", ")}); exactly one is required`,
    );
  }
  const only = candidates[0];
  if (only === undefined || typeof only.text !== "string" || only.text.length === 0) {
    return reject("empty-final-payload", requestId, "final payload is empty");
  }

  // Encoded ONCE, verbatim. Nothing here trims, joins, or reformats.
  const bytes = Array.from(encoder.encode(only.text));
  return accept(canonicalRecord({
    origin: only.origin,
    text: only.text,
    bytes: Object.freeze(bytes),
    byteLength: bytes.length,
    digest: createHash("sha256").update(Uint8Array.from(bytes)).digest("hex") as ArtifactDigest,
  }));
}

// ---------------------------------------------------------------------------
// Request binding
// ---------------------------------------------------------------------------

/**
 * The harness-native identity an adapter resolved for a finished Agent.
 *
 * Pi derives it from `toolCallId` plus the result index and agent; Claude from
 * `session_id`, `agent_id`, and `agent_type` against its pre-spawn receipt.
 * Both must arrive here as an explicit claim, because a claim can be checked
 * against issued authority and an assumption cannot.
 */
export type HarnessResultIdentity = Readonly<{
  harness: "pi" | "claude";
  /** The request this result CLAIMS to answer. Verified, never trusted. */
  requestId: string;
  attempt: number;
  /** Opaque native correlator, recorded for audit (toolCallId / agent_id). */
  nativeId: string;
}>;

export type CaptureReceipt = Readonly<{
  schemaVersion: typeof CAPTURE_SCHEMA_VERSION;
  kind: "capture-receipt";
  harness: "pi" | "claude";
  requestId: RequestId;
  slotId: AgentRequestAuthority["slotId"];
  attempt: SemanticAttempt;
  nativeId: string;
  byteLength: number;
  digest: ArtifactDigest;
}>;

/**
 * Bind one observed result to the exact issued request it claims to answer.
 *
 * Wrong run, unknown request, wrong attempt, or a slot that already accepted a
 * capture are all refusals. They are refusals rather than warnings because the
 * accepted transcript becomes the evidence a roster proof is built from: a
 * result admitted under the wrong identity would be indistinguishable from the
 * genuine one it displaced.
 */
export function bindCapture(input: Readonly<{
  issued: readonly AgentRequestAuthority[];
  identity: HarnessResultIdentity;
  payload: FinalPayload;
  /** Requests whose slot already accepted a capture in this run. */
  alreadyCaptured?: ReadonlySet<string>;
}>): DomainResult<CaptureReceipt, CaptureRejection> {
  const claimed = input.identity.requestId;
  const request = input.issued.find(({ requestId }) => requestId === claimed);
  if (request === undefined) {
    return reject("unknown-request", null, `result claims request ${claimed}, which this run never issued`);
  }
  if (request.attempt !== input.identity.attempt) {
    return reject(
      "attempt-mismatch",
      request.requestId,
      `result claims attempt ${input.identity.attempt} but request ${claimed} was issued for attempt ${request.attempt}`,
    );
  }
  if (input.alreadyCaptured?.has(request.slotId) === true) {
    return reject(
      "duplicate-capture",
      request.requestId,
      `slot ${request.slotId} already accepted a capture; a late or duplicate result cannot replace it`,
    );
  }
  if (typeof input.identity.nativeId !== "string" || input.identity.nativeId.length === 0) {
    return reject("identity-mismatch", request.requestId, "result carries no native harness correlator");
  }

  return accept(canonicalRecord({
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    kind: "capture-receipt" as const,
    harness: input.identity.harness,
    requestId: request.requestId,
    slotId: request.slotId,
    attempt: request.attempt,
    nativeId: input.identity.nativeId,
    byteLength: input.payload.byteLength,
    digest: input.payload.digest,
  }));
}

/**
 * Two receipts describe the same accepted result. Used by the acceptance suite
 * to prove Pi and Claude reach byte-identical outcomes: the harness and native
 * correlator differ by construction, so everything else must match exactly.
 */
export function capturesAgree(left: CaptureReceipt, right: CaptureReceipt): boolean {
  return left.requestId === right.requestId &&
    left.slotId === right.slotId &&
    left.attempt === right.attempt &&
    left.byteLength === right.byteLength &&
    left.digest === right.digest;
}
