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
 *
 * The ADDITIVE EMISSION sections (AD-8, FR-002/FR-006/FR-007/FR-013/FR-014)
 * extend this shared vocabulary with the emission side of the same seam. This
 * module owns the emission observation/rejection vocabulary: how a harness
 * adapter reports assistant emission-tool calls (frames — complete, or
 * incomplete/failed with a reason), the ONE fold from frames to the closed
 * emission observation (absent / one complete call / multiple distinct calls /
 * unusable with a reason), and the observation-refusal codes. Adapters observe
 * ASSISTANT TOOL CALLS, never JSON pasted into user or tool-result text: a
 * final-message payload is a `FinalPayloadCandidate`, never an emission
 * observation — the two vocabularies cannot be confused at the type level
 * because they never share a constructor. Alongside the observation vocabulary,
 * the module carries the two tool-surface contracts the real Pi registration
 * shell binds to: the constrained-sampling request every emission tool
 * registers with (`strict: "prefer"`, FR-002/INV-1) and the execute-shell
 * decision (minimal terminating acknowledgment, or the typed refusal the shell
 * throws — FR-013). The selection OVER the observation is `emission-ingestion`'s
 * contract; this module mints only what the fold and the tool surface need.
 */

import { sha256Bytes, sha256Hex } from "./digest";
import { admitIssuedEmissionArguments, type EmissionParseFailureCode, type EmissionSchemaVersion, type IssuedEmissionBinding } from "./emission-tool";
import {
  canonicalRecord,
  canonicalStructuralEquals,
  parseArtifactByteLength,
  parseRequestId,
  parseSlotId,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type ArtifactRef,
  type DomainResult,
  type RequestId,
  type SemanticAttempt,
} from "./orchestration-contract";
import type { PayloadProducerKind } from "./model-profiles";

export const CAPTURE_SCHEMA_VERSION = 1;

/**
 * Why a result could not be accepted BY THESE RULES.
 *
 * This union is only the pure request/payload rejection vocabulary.
 * Harness observation and run-directory failures belong to `CaptureOutcome`
 * and its boundary constructors in `harness-capture-runtime`; those diagnostics
 * intentionally remain wider than this domain union.
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
 * The ONE construction of a final payload from its text: encoded ONCE,
 * verbatim — no trim, no join, no re-indent — with the byte length and digest
 * derived from those exact bytes. Both payload sources build through it (the
 * extracted final message here, validated emission arguments in
 * `emission-ingestion`), so the encode-once rule cannot drift between them.
 */
export function finalPayloadOf(origin: string, text: string): FinalPayload {
  const bytes = encoder.encode(text);
  return canonicalRecord({
    origin,
    text,
    bytes: Object.freeze(Array.from(bytes)),
    byteLength: bytes.length,
    digest: sha256Bytes(bytes) as ArtifactDigest,
  });
}

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
  return accept(finalPayloadOf(only.origin, only.text));
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

/** Write-ahead identity only; never a capture/publication receipt or replay authority. */
export function nativeCaptureObservation(
  request: AgentRequestAuthority,
  receipt: CaptureReceipt,
  origin: string,
): string {
  return JSON.stringify(canonicalRecord({ kind: "native-capture-observed", request, receipt, origin }));
}

/** A fresh independently bound native observation must match BOTH durable identity and raw bytes. */
export function recoverNativeCaptureArtifact(input: Readonly<{
  request: AgentRequestAuthority;
  receipt: CaptureReceipt;
  payload: FinalPayload;
  observation: Uint8Array | null;
  capturedBytes: Uint8Array;
}>): DomainResult<ArtifactRef, string> {
  if (input.receipt.requestId !== input.request.requestId || input.receipt.slotId !== input.request.slotId ||
      input.receipt.attempt !== input.request.attempt || input.receipt.digest !== input.payload.digest ||
      input.receipt.byteLength !== input.payload.byteLength) {
    return { ok: false, error: "native recapture receipt does not bind the fresh request and payload" };
  }
  const expected = encoder.encode(nativeCaptureObservation(input.request, input.receipt, input.payload.origin));
  const observation = input.observation;
  if (observation === null || observation.length !== expected.length ||
      !expected.every((byte, index) => observation[index] === byte)) {
    return { ok: false, error: "native recapture differs from its original request/context/correlator observation" };
  }
  if (input.capturedBytes.length !== input.payload.bytes.length ||
      !input.capturedBytes.every((byte, index) => input.payload.bytes[index] === byte)) {
    return { ok: false, error: "native recapture differs from the exact already-written transcript bytes" };
  }
  const byteLength = parseArtifactByteLength(input.payload.byteLength);
  if (!byteLength.ok) return { ok: false, error: byteLength.error.message };
  return { ok: true, value: canonicalRecord({ runId: input.request.runId, slot: input.request.outputSlot,
    digest: input.payload.digest, byteLength: byteLength.value }) };
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
  return `capture-rejected:${sha256Hex(`${requestId}:${attempt}`)}`;
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

// ---------------------------------------------------------------------------
// Additive emission observation/rejection vocabulary (AD-8, FR-007/FR-014)
// ---------------------------------------------------------------------------

/**
 * One complete, request-bound emission-tool call as the harness adapters
 * observe it: the issued request attempt the frame was observed under (the
 * adapter's attribution — verified, never trusted, by the selection's binding
 * check in `emission-ingestion`), the transport's tool-call identity, the
 * producer kind and schema version the call's tool carries, and the arguments
 * as observed. Untrusted transport data: the selection compares `requestId`
 * against the issued binding rather than re-parsing it, so a malformed id can
 * only fail the match (wrong-request refusal), never impersonate the issued
 * request.
 */
export type EmissionToolCall = Readonly<{
  requestId: string;
  toolCallId: string;
  kind: PayloadProducerKind;
  version: EmissionSchemaVersion;
  arguments: unknown;
}>;

/**
 * One observed emission-tool transport frame — complete (a full call with
 * arguments) or incomplete/failed (the harness saw an emission call but could
 * not observe it completely). The incomplete arm exists so an incomplete or
 * failed observation is REPRESENTABLE as itself: the fold refuses it with a
 * reason and never reclassifies it as absence (AD-8). `toolCallId` is null
 * when the adapter could not recover which call failed; the refusal is the
 * same either way.
 */
export type EmissionCallFrame =
  | Readonly<{ kind: "complete"; call: EmissionToolCall }>
  | Readonly<{ kind: "incomplete"; toolCallId: string | null; reason: string }>;

/**
 * The closed emission observation (AD-8): absent, one complete call, multiple
 * distinct calls, or unusable with a reason. The vocabulary is closed — a
 * consumer switching on `kind` over these four arms is exhaustive.
 */
export type EmissionObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "single-call"; call: EmissionToolCall }>
  | Readonly<{ kind: "multiple-calls"; calls: readonly [EmissionToolCall, EmissionToolCall, ...EmissionToolCall[]] }>
  | Readonly<{ kind: "unusable"; reason: string }>;

/**
 * The contract-field projection of one observed call, shared by the fold and
 * by the selection's accepted-call provenance. Adapter provenance beyond the
 * contract fields is projected away, so the observation — and therefore the
 * selection — is a function of the contract fields only and never of how much
 * provenance an adapter attached.
 */
export function canonicalCall(call: EmissionToolCall): EmissionToolCall {
  return canonicalRecord({
    requestId: call.requestId,
    toolCallId: call.toolCallId,
    kind: Object.freeze({ kind: call.kind.kind }),
    version: call.version,
    arguments: call.arguments,
  });
}

/**
 * The first contract field on which two contradictory frames sharing one
 * tool-call identity differ, in the FR-014 contract-field order (request id,
 * producer kind, schema version, arguments). The retained refusal names WHAT
 * differed — the model's correction surface and the operator's journal read
 * the reason, never just that a contradiction exists. The tool-call identity
 * itself cannot be the differing field: the fold groups frames by it.
 */
const firstDifferingField = (seen: EmissionToolCall, call: EmissionToolCall): string => {
  if (seen.requestId !== call.requestId) return "requestId";
  if (!canonicalStructuralEquals(seen.kind, call.kind)) return "kind";
  if (seen.version !== call.version) return "version";
  return "arguments";
};

/**
 * The frame fold's first phase: replay-deduplicate complete frames by
 * tool-call identity (exact replays idempotent, contradictions refused with
 * the FR-014 differing field), refuse incomplete frames and empty identities
 * outright. The returned union keeps the refusal as data so the observation
 * selection below stays a pure projection.
 */
const foldFramesToCalls = (
  frames: readonly EmissionCallFrame[],
): { kind: "observed"; calls: readonly EmissionToolCall[] } | { kind: "refused"; reason: string } => {
  // One structure carries first-observed order: a Map's insertion order IS
  // first-observed order, so the distinct-call set needs no parallel array to
  // keep in agreement with it.
  const callsByIdentity = new Map<string, EmissionToolCall>();
  for (const frame of frames) {
    if (frame.kind === "incomplete") {
      return { kind: "refused", reason: frame.toolCallId === null
        ? `an emission tool call was observed incomplete: ${frame.reason}`
        : `emission tool call ${frame.toolCallId} was observed incomplete: ${frame.reason}` };
    }
    const call = canonicalCall(frame.call);
    if (call.toolCallId.length === 0) {
      // The reason names the observed producer kind: the operator journal reads
      // this diagnostic to find WHICH family's calls cannot be bound, without
      // re-opening the transcript.
      return { kind: "refused", reason: `an observed ${call.kind.kind} emission tool call carries an empty tool-call identity` };
    }
    const seen = callsByIdentity.get(call.toolCallId);
    if (seen === undefined) {
      callsByIdentity.set(call.toolCallId, call);
    } else if (!canonicalStructuralEquals(seen, call)) {
      return { kind: "refused", reason:
        `contradictory duplicate transport frames for emission tool call ${call.toolCallId} ` +
        `(differing: ${firstDifferingField(seen, call)})` };
    }
    // else: an exact replay of one already-observed call — idempotent (FR-007).
  }
  return { kind: "observed", calls: Object.freeze([...callsByIdentity.values()]) };
};

/**
 * The ONE fold from observed transport frames to the closed emission
 * observation — the observation decision both selection functions in
 * `emission-ingestion` share, not a caller-maintained policy. The fold is
 * binding-blind: it classifies by tool-call identity alone, so the same fold
 * serves every issued binding and every path (misbinding is the selection's
 * check against the issued binding).
 *
 * - Any incomplete/failed frame refuses the attempt with its reason: the
 *   observation is unusable, never reclassified as absence (AD-8), and the
 *   first incomplete frame in observation order names the refusal.
 * - Frames sharing one tool-call identity are the same call replayed:
 *   idempotent when every frame carries the identical record (request id,
 *   kind, version and structurally-equal arguments — FR-007's "same observed
 *   call"), and contradictory — unusable — when any frame differs (FR-007's
 *   "contradictory records sharing call identity MUST refuse rather than
 *   deduplicate silently"), with the refusal naming the first differing
 *   contract field in FR-014 order (request id, producer kind, schema
 *   version, arguments). Replayed frames with the same identity and bytes
 *   therefore add no consumption and no publication.
 * - The DISTINCT identities decide the count, in first-observed order: zero →
 *   absent, one → single-call, ≥2 → multiple-calls (which is ambiguity by the
 *   time the selection sees it).
 * - An empty tool-call identity cannot be bound or replay-deduplicated, so a
 *   complete frame carrying one makes the observation unusable.
 */
export function observeEmissionCalls(frames: readonly EmissionCallFrame[]): EmissionObservation {
  const folded = foldFramesToCalls(frames);
  if (folded.kind === "refused") {
    return canonicalRecord({ kind: "unusable" as const, reason: folded.reason });
  }
  const [first, second, ...rest] = folded.calls;
  if (first === undefined) return canonicalRecord({ kind: "absent" as const });
  if (second === undefined) return canonicalRecord({ kind: "single-call" as const, call: first });
  return canonicalRecord({
    kind: "multiple-calls" as const,
    calls: Object.freeze([first, second, ...rest] as const),
  });
}

/**
 * The closed refusal vocabulary for observations that are not a semantic
 * payload decision (AD-9): an unusable observation (incomplete/failed or
 * contradictory frames), or a call bound to the wrong request attempt,
 * producer kind, or schema version. Never absence, never a fallback — the
 * boundary classifies these as evidence/infrastructure, never as a consumed
 * semantic attempt.
 */
export type EmissionObservationRefusalCode =
  | "unusable-observation"
  | "wrong-request"
  | "unexpected-kind"
  | "unexpected-version";

export type EmissionObservationRefusal = Readonly<{
  code: EmissionObservationRefusalCode;
  message: string;
}>;

// ---------------------------------------------------------------------------
// Additive emission tool-surface contracts (FR-002/INV-1, FR-013)
// ---------------------------------------------------------------------------

/**
 * The ONE constrained-sampling request every emission tool registers with
 * (FR-002/INV-1): JSON-schema constrained sampling requested with strict
 * PREFERRED, never required. The harness's capability resolver
 * (pi-ai's `resolveJsonSchemaStrictSampling`) resolves a preferred request on
 * a strict-incapable ROUTE to "no strict flag", and (pi-ai ≥0.84) it likewise
 * declines — never throws — a preferred request whose parameters the schema
 * strictifier cannot strictify (the frozen bytes carry $defs/$ref and v2/v3's
 * root oneOf, which the strictifier rejects); the wire request still goes out
 * and the engine stays validity/count authoritative (AD-2's
 * unconstrained-emission class). A required request is the INV-1 failure mode:
 * the resolver THROWS on every decline path, failing the child's request
 * before the extraction fallback could ever engage. The checkable INV-1 rule
 * file is `.claude/linter/rules/inv-1-no-strict-require-constraint.json`; its
 * regex is a spelling guard, and the behavioral acceptance crosses the REAL
 * resolver (engine/tests/pi/emission-tool.test.ts). The resolver's
 * strict-flag truth table is qualification evidence, not an engine contract:
 * the installed 0.83.0 runtime carried `strict: true` for all four frozen
 * schemas (the committed qualification recordings), and a resolver behavior
 * change is a feasibility §2.8 requalification trigger.
 *
 * The shape is structurally pi-ai's `ConstrainedSamplingConfig`; the pi
 * registration surface claims it as one — the same confined-cast pattern as
 * `frozenPayloadSchemaParameters`' TSchema claim — because the engine core
 * imports no pi package. The frozen registry's tool specs carry no separate
 * request: ONE request vocabulary for every emission tool, minted here and
 * nowhere else.
 */
export type EmissionConstrainedSamplingRequest = Readonly<{
  type: "json_schema";
  strict: "prefer";
}>;

export const EMISSION_CONSTRAINED_SAMPLING_REQUEST: EmissionConstrainedSamplingRequest =
  Object.freeze({ type: "json_schema", strict: "prefer" });

/**
 * The minimal terminating tool result (FR-013): one bounded text line naming
 * the outcome, empty details, and the harness's terminating flag. It NEVER
 * echoes the payload (AD-3: no large payload echo in acknowledgment content),
 * and `terminate: true` suppresses the follow-up model turn only when EVERY
 * finalized result in the batch is terminating (pi 0.83.0 documented
 * semantics) — the shell returns it verbatim, never wraps it.
 */
export type EmissionToolAcknowledgment = Readonly<{
  content: readonly [Readonly<{ type: "text"; text: string }>];
  details: Readonly<Record<string, never>>;
  terminate: true;
}>;

/**
 * The execute shell's ONE decision (FR-013): the arguments are admitted
 * through the frozen registry's parser (the parse IS the gate — the same
 * admission the engine's selection later re-runs), and the shell either
 * returns the minimal terminating acknowledgment or carries the refusal the
 * shell THROWS at the harness boundary. A refusal must never become a
 * successful tool result: returning an error-labeled object does not set the
 * harness's error flag, so the throw IS the error signal (AD-3). The outcome
 * is closed — a consumer switching on `kind` is exhaustive — and the refused
 * arm carries the admission's own code and message verbatim, so the model's
 * correction surface (and the engine's retained diagnostics, FR-006) is the
 * parse's vocabulary, never a shell-invented string.
 */
export type EmissionExecutionOutcome =
  | Readonly<{ kind: "acknowledged"; acknowledgment: EmissionToolAcknowledgment }>
  | Readonly<{ kind: "refused"; code: EmissionParseFailureCode; message: string }>;

/**
 * The production execute shell's decision, minted once: admit the untrusted
 * arguments through the issued binding — `admitIssuedEmissionArguments`, the
 * SAME admission the engine's selection runs over the observed call — and
 * acknowledge or refuse. The real Pi tool surface (T5's registration) calls
 * exactly this, so the acceptance suite drives the same policy seam as
 * production — never a test twin.
 */
export function acknowledgeEmissionExecution(
  binding: IssuedEmissionBinding,
  args: unknown,
): EmissionExecutionOutcome {
  const admitted = admitIssuedEmissionArguments(binding, args);
  if (admitted.kind === "refused") {
    return canonicalRecord({ kind: "refused" as const, code: admitted.code, message: admitted.message });
  }
  return canonicalRecord({
    kind: "acknowledged" as const,
    acknowledgment: canonicalRecord({
      content: Object.freeze([Object.freeze({ type: "text" as const, text: "payload acknowledged" })]),
      details: Object.freeze({}),
      terminate: true as const,
    }),
  });
}
