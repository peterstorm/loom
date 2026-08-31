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
  parseRequestId,
  parseSlotId,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type DomainResult,
  type RequestId,
  type SemanticAttempt,
} from "./orchestration-contract";

export const CAPTURE_SCHEMA_VERSION = 1;

/**
 * Why a result could not be accepted BY THESE RULES.
 *
 * This is the core vocabulary only. Harness adapters mint observation reasons:
 * Claude owns `transcript-json` and `transcript-locator`; Pi owns
 * `transcript-shape`, `agent-failed`, and `capture-crashed`. The shared
 * run-directory runtime owns `run-authority`, `run-directory`, `correlator`,
 * `requests`, `context`, `context-binding`, `transcript`, `wrong-agent-role`,
 * and `rejection-persistence`. `CaptureOutcome.reason` is therefore a wider
 * string, and an adapter/runtime reason is not a violation of this union.
 */
export type CaptureRejectionReason =
  | "no-final-payload"
  | "ambiguous-final-payload"
  | "empty-final-payload"
  | "unknown-request"
  | "identity-mismatch"
  | "attempt-mismatch"
  | "duplicate-capture";

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
  /** Where the adapter found it, e.g. `content[2].text` or `transcript.line[7]`. */
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
 * Neither harness hands the request id back. Each supplies only its own native
 * correlator — Pi a roster id built from `toolCallId`, the result index and the
 * agent type; Claude the `agent_id` its SubagentStop payload carries — and
 * `captureHarnessResult` reconstructs `requestId` and `attempt` from the durable
 * correlator binding the spawn side recorded beside the reservation. So
 * `requestId` and `attempt` are not claims the harness is trusted with: they are
 * looked up from engine-written authority. What the adapter does claim is the
 * native id, and the checks below re-verify that claim against issued authority.
 */
export type HarnessResultIdentity = Readonly<{
  harness: "pi" | "claude";
  /** The request this result CLAIMS to answer. Verified, never trusted. */
  requestId: string;
  attempt: number;
  /** Opaque native correlator, recorded for audit (toolCallId / agent_id). */
  nativeId: string;
}>;

declare const CAPTURE_KEY: unique symbol;
export type CaptureKey = string & { readonly [CAPTURE_KEY]: true };

export function captureKey(slotId: string, attempt: SemanticAttempt): CaptureKey {
  return `${slotId}:attempt-${attempt}` as CaptureKey;
}

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
 * Four refusals, in the order they are checked: a request this run never issued
 * (`unknown-request`), the right request at the wrong attempt
 * (`attempt-mismatch`), a semantic attempt that already accepted a capture
 * (`duplicate-capture`), and a result carrying no harness-native correlator to
 * bind by (`identity-mismatch`). The run itself is NOT among them and the
 * function takes no run id: the caller already resolved `issued` from one
 * anchored run directory, so a foreign request cannot appear in it — it fails as
 * `unknown-request` instead.
 *
 * They are refusals rather than warnings because the accepted transcript becomes
 * the evidence a roster proof is built from: a result admitted under the wrong
 * identity would be indistinguishable from the genuine one it displaced.
 */
export function bindCapture(input: Readonly<{
  issued: readonly AgentRequestAuthority[];
  identity: HarnessResultIdentity;
  payload: FinalPayload;
  /**
   * Exact semantic attempts that already accepted a capture in this run.
   * Required, not optional: an omitted set silently disabled the
   * duplicate-capture refusal, which is the one guard that stops an accepted
   * transcript being replaced by a result that arrived twice.
   */
  alreadyCaptured: ReadonlySet<CaptureKey>;
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
  if (input.alreadyCaptured.has(captureKey(request.slotId, request.attempt))) {
    return reject(
      "duplicate-capture",
      request.requestId,
      `slot ${request.slotId} attempt ${request.attempt} already accepted a capture; a duplicate result cannot replace it`,
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

// ---------------------------------------------------------------------------
// Rejection audit record
// ---------------------------------------------------------------------------

/**
 * The journal record kind written beside a terminalised capture rejection.
 *
 * Named once, here, because more than one adapter writes it AND the legacy panel
 * translator has to recognise it. It deliberately carries no `type` field: it is
 * durable evidence of a refusal, not a machine transition, and no program
 * reducer has a rule for it. Feeding it to a reducer instead is what wedged a
 * registered panel run at every later `resume` — a record no machine can fold is
 * exactly the corruption risk that keeps `RunAbandonment` out of this journal
 * too.
 */
export const CAPTURE_REJECTION_EVENT_KIND = "request-capture-rejected";

export type CaptureRejectionAuditRecord = Readonly<{
  kind: typeof CAPTURE_REJECTION_EVENT_KIND;
  requestId: RequestId;
  slotId: AgentRequestAuthority["slotId"];
  attempt: SemanticAttempt;
  diagnostic: string;
}>;

/**
 * Journal identity for one rejected attempt.
 *
 * Shared because it IS journal identity: derived differently on each side, one
 * refused attempt journals twice under two keys and replay counts a refusal that
 * happened once as two.
 */
export function captureRejectionDedupKey(requestId: RequestId, attempt: SemanticAttempt): string {
  return `capture-rejected:${createHash("sha256").update(`${requestId}:${attempt}`).digest("hex")}`;
}

/** Build the one audit record a terminalised rejection is allowed to write. */
export function captureRejectionAuditRecord(
  request: Pick<AgentRequestAuthority, "requestId" | "slotId" | "attempt">,
  diagnostic: string,
): CaptureRejectionAuditRecord {
  return canonicalRecord({
    kind: CAPTURE_REJECTION_EVENT_KIND as typeof CAPTURE_REJECTION_EVENT_KIND,
    requestId: request.requestId,
    slotId: request.slotId,
    attempt: request.attempt,
    diagnostic,
  });
}

/**
 * True only for a record shaped EXACTLY like this module's audit record.
 *
 * The panel translator uses this to carry an audit record past the reducer, so a
 * loose test here would quietly swallow real journal corruption: every field and
 * the exact key set are checked, and anything else stays the error it was.
 */
export function isCaptureRejectionAuditRecord(raw: unknown): raw is CaptureRejectionAuditRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 5 || keys.join(",") !== "attempt,diagnostic,kind,requestId,slotId" ||
      record["kind"] !== CAPTURE_REJECTION_EVENT_KIND ||
      (record["attempt"] !== 1 && record["attempt"] !== 2) ||
      typeof record["diagnostic"] !== "string") return false;
  return parseRequestId(record["requestId"]).ok && parseSlotId(record["slotId"]).ok;
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
