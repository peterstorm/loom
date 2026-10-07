/**
 * The emission observation vocabulary (AD-8, FR-002/FR-006/FR-007/FR-014):
 * how a harness adapter reports assistant emission-tool calls (frames —
 * complete, or incomplete/failed with a reason), the ONE fold from frames to
 * the closed emission observation (absent / one complete call / multiple
 * distinct calls / unusable with a reason), and the observation-refusal codes.
 *
 * Adapters observe ASSISTANT TOOL CALLS, never JSON pasted into user or
 * tool-result text: a final-message payload is `harness-capture`'s
 * `FinalPayloadCandidate`, never an emission observation, and the two
 * vocabularies cannot be confused at the type level because they never share a
 * constructor. The only constructor the two sides share is `finalPayloadOf`,
 * which `emission-ingestion` calls to build the accepted payload. The selection
 * OVER the observation is `emission-ingestion`'s contract; this module mints
 * only what the fold needs.
 *
 * Pure module: no I/O, and only type-level knowledge of the emission registry,
 * so the capture vocabulary's dependency closure stays small.
 */

import { canonicalRecord, canonicalStructuralEquals } from "./orchestration-contract/identity";
import type { EmissionSchemaVersion } from "./emission-tool";
import type { PayloadProducerKind } from "./agent-catalog-projections";

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
