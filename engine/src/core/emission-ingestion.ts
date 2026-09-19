/**
 * The ONE observation/selection decision for the ingestion seams (AD-8/AD-9):
 * the closed emission observation is folded once from the transport frames,
 * every observed call is checked against the issued binding, the distinct-call
 * count decides, and only the single-call state reaches schema selection.
 * Reviewer and verdict paths keep their distinct output construction
 * (canonical payload bytes vs verdict rawJson) on top of the shared decision —
 * provenance and refusal diagnostics are returned BY the decision, never
 * reconstructed by callers from the input records.
 *
 * The decision pipeline is fixed and ordered:
 *
 *   unusable observation refuses
 *   → every observed call is bound to the issued request attempt, producer
 *     kind and schema version (wrong request / unexpected kind / unexpected
 *     version refuses — FR-014; a misbound call is never filtered away, never
 *     self-decoded, and can never be absorbed into a mere ambiguity count)
 *   → the count of DISTINCT tool-call identities decides
 *     (zero → extraction verbatim; one → schema admission; ≥2 → ambiguity)
 *   → the single-call state admits the arguments through the registry's
 *     `admitEmissionArguments` (schema selection)
 *
 * Wrong kind/version/request and unusable observations therefore reject before
 * schema selection, and they are REFUSALS, not absence: the boundary
 * classifies them (evidence/infrastructure), the kernel never invents a
 * successful fallback for them. The two semantic rejection arms —
 * `duplicate-emission-call` and `refused-call-no-fallback` — are the rows that
 * consume the existing request-slot attempt budget (one rejection, not two;
 * attempt 1 may advance to a fresh attempt-2 spawn, attempt 2 is terminal).
 * Startup/transport infrastructure unavailability produces no observation at
 * all and stays the shell's existing infrastructure recovery.
 *
 * Pure module: no I/O, no clock, no randomness; it must not import
 * panel-program.ts or any I/O adapter (the boundary the cross-import linter
 * enforces). PR #52's fail-closed extraction is consumed verbatim
 * (`parseFinalPayload` — never modified, called exactly as the capture runtime
 * calls it), so wherever the selection is extraction the fallback behavior is
 * exactly today's: any behavioral divergence from the no-op baseline can only
 * originate from the validated, deterministic emission path. That containment
 * law holds for the zero-call state and for the single-refused-call state
 * where extraction is selected — and deliberately claims NOTHING for duplicate
 * or misbound calls (AD-9: property tests assert those rejection outcomes
 * rather than skip them under a misleading universal containment name).
 */

import { createHash } from "node:crypto";
import {
  admitEmissionArguments,
  EMISSION_TOOL_SPECS,
  type EmissionArgumentAdmission,
  type EmissionParseFailure,
  type EmissionSchemaVersion,
  type IssuedEmissionBinding,
  type IssuedEmissionBindingOf,
} from "./emission-tool";
import {
  parseFinalPayload,
  type CaptureRejection,
  type FinalPayload,
  type FinalPayloadCandidate,
} from "./harness-capture";
import {
  canonicalRecord,
  canonicalStructuralEquals,
  type ArtifactDigest,
  type DomainResult,
} from "./orchestration-contract/identity";
import type { PayloadProducerKind } from "./model-profiles";

// ---------------------------------------------------------------------------
// Observed transport frames and the closed emission observation (AD-8)
// ---------------------------------------------------------------------------

/**
 * One complete, request-bound emission-tool call as the harness adapters
 * observe it: the issued request attempt the frame was observed under (the
 * adapter's attribution — verified, never trusted, by the selection's binding
 * check), the transport's tool-call identity, the producer kind and schema
 * version the call's tool carries, and the arguments as observed. Untrusted
 * transport data: the selection compares `requestId` against the issued
 * binding rather than re-parsing it, so a malformed id can only fail the
 * match (wrong-request refusal), never impersonate the issued request.
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
  | Readonly<{ kind: "multiple-calls"; calls: readonly EmissionToolCall[] }>
  | Readonly<{ kind: "unusable"; reason: string }>;

/**
 * The contract-field projection of one observed call. Adapter provenance
 * beyond the contract fields is projected away at the fold, so the
 * observation — and therefore the selection — is a function of the contract
 * fields only and never of how much provenance an adapter attached.
 */
const canonicalCall = (call: EmissionToolCall): EmissionToolCall =>
  canonicalRecord({
    requestId: call.requestId,
    toolCallId: call.toolCallId,
    kind: Object.freeze({ kind: call.kind.kind }),
    version: call.version,
    arguments: call.arguments,
  });

/**
 * The ONE fold from observed transport frames to the closed emission
 * observation — the observation decision both selection functions share, not
 * a caller-maintained policy. The fold is binding-blind: it classifies by
 * tool-call identity alone, so the same fold serves every issued binding and
 * every path (misbinding is the selection's check against the issued
 * binding).
 *
 * - Any incomplete/failed frame refuses the attempt with its reason: the
 *   observation is unusable, never reclassified as absence (AD-8), and the
 *   first incomplete frame in observation order names the refusal.
 * - Frames sharing one tool-call identity are the same call replayed:
 *   idempotent when every frame carries the identical record (request id,
 *   kind, version and structurally-equal arguments — FR-007's "same observed
 *   call"), and contradictory — unusable — when any frame differs (FR-007's
 *   "contradictory records sharing call identity MUST refuse rather than
 *   deduplicate silently"). Replayed frames with the same identity and bytes
 *   therefore add no consumption and no publication.
 * - The DISTINCT identities decide the count, in first-observed order: zero →
 *   absent, one → single-call, ≥2 → multiple-calls (which is ambiguity by the
 *   time the selection sees it).
 * - An empty tool-call identity cannot be bound or replay-deduplicated, so a
 *   complete frame carrying one makes the observation unusable.
 */
export function observeEmissionCalls(frames: readonly EmissionCallFrame[]): EmissionObservation {
  const identities: string[] = [];
  const callsByIdentity = new Map<string, EmissionToolCall>();
  for (const frame of frames) {
    if (frame.kind === "incomplete") {
      return canonicalRecord({
        kind: "unusable" as const,
        reason: frame.toolCallId === null
          ? `an emission tool call was observed incomplete: ${frame.reason}`
          : `emission tool call ${frame.toolCallId} was observed incomplete: ${frame.reason}`,
      });
    }
    const call = canonicalCall(frame.call);
    if (call.toolCallId.length === 0) {
      return canonicalRecord({
        kind: "unusable" as const,
        reason: "an observed emission tool call carries an empty tool-call identity",
      });
    }
    const seen = callsByIdentity.get(call.toolCallId);
    if (seen === undefined) {
      callsByIdentity.set(call.toolCallId, call);
      identities.push(call.toolCallId);
    } else if (!canonicalStructuralEquals(seen, call)) {
      return canonicalRecord({
        kind: "unusable" as const,
        reason: `contradictory duplicate transport frames for emission tool call ${call.toolCallId}`,
      });
    }
    // else: an exact replay of one already-observed call — idempotent (FR-007).
  }
  if (identities.length === 0) return canonicalRecord({ kind: "absent" as const });
  if (identities.length === 1) {
    return canonicalRecord({ kind: "single-call" as const, call: callsByIdentity.get(identities[0]!)! });
  }
  return canonicalRecord({
    kind: "multiple-calls" as const,
    calls: Object.freeze(identities.map((toolCallId) => callsByIdentity.get(toolCallId)!)),
  });
}

// ---------------------------------------------------------------------------
// Binding check and count decision — shared by both selection functions
// ---------------------------------------------------------------------------

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

/**
 * The binding-checked, count-decided observation decision both selection
 * functions share: refusal before counting, counting before schema selection.
 */
type ObservationDecision =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "single-call"; call: EmissionToolCall }>
  | Readonly<{ kind: "duplicate-emission-call" }>
  | Readonly<{ kind: "observation-refused"; refusal: EmissionObservationRefusal }>;

/** The first misbinding of one observed call against the issued binding, or
 *  null when the call is correctly bound. Field order is the FR-014 check
 *  order: request attempt, then producer kind, then schema version. */
const misbindingOf = (
  expected: IssuedEmissionBinding,
  call: EmissionToolCall,
): EmissionObservationRefusal | null => {
  if (call.requestId !== expected.requestId) {
    return canonicalRecord({
      code: "wrong-request" as const,
      message: `emission tool call ${call.toolCallId} was observed under request ${call.requestId} rather than the issued request ${expected.requestId}`,
    });
  }
  if (call.kind.kind !== expected.kind.kind) {
    return canonicalRecord({
      code: "unexpected-kind" as const,
      message: `emission tool call ${call.toolCallId} carries producer kind ${call.kind.kind} rather than the issued ${expected.kind.kind}`,
    });
  }
  if (call.version !== expected.version) {
    return canonicalRecord({
      code: "unexpected-version" as const,
      message: `emission tool call ${call.toolCallId} carries schema version ${call.version} rather than the issued ${expected.version}`,
    });
  }
  return null;
};

/** Every complete call the observation carries, in observation order — the
 *  binding check's scan list. Exhaustive over the closed observation, so a
 *  new arm fails to compile here instead of silently skipping its calls. */
function observationCalls(observation: EmissionObservation): readonly EmissionToolCall[] {
  switch (observation.kind) {
    case "single-call": return [observation.call];
    case "multiple-calls": return observation.calls;
    case "absent":
    case "unusable": return [];
  }
}

/** The binding-scoped admission: the arguments are admitted through the
 *  ISSUED binding's registry cell — the schema selection happens here and
 *  only here, after the binding check, never from the call's own claims. */
const admitBoundCall = (
  expected: IssuedEmissionBinding,
  call: EmissionToolCall,
): EmissionArgumentAdmission =>
  admitEmissionArguments(EMISSION_TOOL_SPECS[expected.kind.kind], expected.version, call.arguments);

/** The retained single-call refusal (FR-006): the admission's code and
 *  message verbatim, canonical-recorded so the diagnostic is bounded. */
const retainedRefusalOf = (
  admitted: Extract<EmissionArgumentAdmission, { kind: "refused" }>,
): EmissionParseFailure => canonicalRecord({ code: admitted.code, message: admitted.message });

function decideBoundObservation(
  expected: IssuedEmissionBinding,
  observation: EmissionObservation,
): ObservationDecision {
  if (observation.kind === "unusable") {
    return canonicalRecord({
      kind: "observation-refused" as const,
      refusal: canonicalRecord({ code: "unusable-observation" as const, message: observation.reason }),
    });
  }
  for (const call of observationCalls(observation)) {
    const misbinding = misbindingOf(expected, call);
    if (misbinding !== null) {
      return canonicalRecord({ kind: "observation-refused" as const, refusal: misbinding });
    }
  }
  if (observation.kind === "single-call") {
    return canonicalRecord({ kind: "single-call" as const, call: observation.call });
  }
  if (observation.kind === "multiple-calls") {
    return canonicalRecord({ kind: "duplicate-emission-call" as const });
  }
  return canonicalRecord({ kind: "absent" as const });
}

// ---------------------------------------------------------------------------
// The reviewer payload path: canonical-payload selection
// ---------------------------------------------------------------------------

/**
 * The reviewer payload path's deterministic canonical-payload selection —
 * every AD-9 row in one pure decision, with the extraction arm carrying its
 * existing `parseFinalPayload` result verbatim.
 *
 * - Zero emission calls: PR #52's extraction engages exactly as today, with
 *   no retained refusal — the no-op baseline (FR-004/FR-005/FR-010/AS-006).
 * - One complete, correctly bound call with valid arguments: emission wins
 *   deterministically, regardless of any final text (FR-003/AS-003) — the
 *   existing issuance joins still decide admission downstream.
 * - One complete, correctly bound call with refused arguments: the arguments
 *   are never ingested (FR-006). Usable final extraction is accepted with the
 *   refusal RETAINED and no retry consumed; unusable extraction is the
 *   `refused-call-no-fallback` rejection carrying BOTH causes — one rejection,
 *   not two (AD-9).
 * - Two or more DISTINCT calls: ambiguity, even when one call is valid or a
 *   final message is present (FR-007/AS-019) — the record-count semantics are
 *   validity-blind and identity-based: identical arguments under different
 *   call identities are still two calls, and an exact replay of one call is
 *   still one call (the fold).
 * - Misbound (wrong request/kind/version) or unusable observations: the
 *   `observation-refused` typed refusal — never absence, never a fallback
 *   (FR-014/AD-9); the boundary classifies it.
 *
 * The expected binding is the reviewer-payload refinement of the issued
 * binding (type-level path scoping), so the selection admits only through the
 * registry's reviewer parser and an unexpected kind can never select its own
 * decoder.
 */
export type IngestionSelection =
  | Readonly<{
      kind: "emission-tool-arguments";
      payload: FinalPayload;
      source: "emission-tool";
      /** The accepted call, projected to the contract fields — the provenance
       *  the capture runtime journals beside the accepted payload (FR-009),
       *  returned by the decision, never reconstructed from input records. */
      call: EmissionToolCall;
    }>
  | Readonly<{
      kind: "final-message-extraction";
      /** PR #52's parseFinalPayload result, verbatim: success carries the
       *  admitted payload, rejection carries the existing zero-candidate and
       *  ambiguity rejection vocabulary the caller terminalises as today. */
      fallback: DomainResult<FinalPayload, CaptureRejection>;
      source: "extraction";
      /** FR-006: the retained refusal of the single engine-refused emission
       *  call that led here — null when no call was observed (the no-op
       *  baseline). A non-null refusal means extraction was selected over a
       *  refused call and consumed no retry. */
      emissionRefusal: EmissionParseFailure | null;
    }>
  | Readonly<{ kind: "duplicate-emission-call" }>
  | Readonly<{
      kind: "refused-call-no-fallback";
      /** The single refused call's retained refusal (FR-006). */
      emissionRefusal: EmissionParseFailure;
      /** The extraction's existing rejection — both causes retained by one
       *  rejection, not two (AD-9). */
      extraction: CaptureRejection;
    }>
  | Readonly<{ kind: "observation-refused"; refusal: EmissionObservationRefusal }>;

const encoder = new TextEncoder();

/**
 * The canonical payload bytes for validated emission arguments: encoded ONCE,
 * deterministically — no trim, no join, no re-indent — the same encode-once
 * rule the fallback's `parseFinalPayload` applies to harness text.
 */
function finalPayloadOfArguments(payload: unknown): FinalPayload {
  const text = JSON.stringify(payload, null, 2);
  const bytes = encoder.encode(text);
  return canonicalRecord({
    origin: "emission-tool-arguments",
    text,
    bytes: Object.freeze(Array.from(bytes)),
    byteLength: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex") as ArtifactDigest,
  });
}

export function selectCanonicalPayload(
  expected: IssuedEmissionBindingOf<"reviewer-payload">,
  observation: EmissionObservation,
  finalMessageCandidates: readonly FinalPayloadCandidate[],
): IngestionSelection {
  const decision = decideBoundObservation(expected, observation);
  if (decision.kind === "observation-refused" || decision.kind === "duplicate-emission-call") {
    return decision;
  }
  if (decision.kind === "single-call") {
    const admitted = admitBoundCall(expected, decision.call);
    if (admitted.kind === "valid") {
      return canonicalRecord({
        kind: "emission-tool-arguments" as const,
        payload: finalPayloadOfArguments(admitted.payload),
        source: "emission-tool" as const,
        call: canonicalCall(decision.call),
      });
    }
    const emissionRefusal = retainedRefusalOf(admitted);
    const fallback = parseFinalPayload(finalMessageCandidates);
    if (fallback.ok) {
      return canonicalRecord({
        kind: "final-message-extraction" as const,
        fallback,
        source: "extraction" as const,
        emissionRefusal,
      });
    }
    return canonicalRecord({
      kind: "refused-call-no-fallback" as const,
      emissionRefusal,
      extraction: fallback.error,
    });
  }
  return canonicalRecord({
    kind: "final-message-extraction" as const,
    fallback: parseFinalPayload(finalMessageCandidates),
    source: "extraction" as const,
    emissionRefusal: null,
  });
}

// ---------------------------------------------------------------------------
// The panel verdict paths: verdict-source selection
// ---------------------------------------------------------------------------

/**
 * The panel verdict paths' deterministic verdict-source selection — the same
 * shared decision (`observeEmissionCalls` fold, binding check, count) with
 * the verdict paths' own output construction: the admitted arguments become
 * the rawJson the submission seam parses with the panel authority's bindings
 * inside (FR-012 retained verbatim); extraction preserves the caller's
 * existing raw input byte-verbatim.
 *
 * Identical AD-9 rows to `selectCanonicalPayload`, with one path-specific
 * difference: the verdict path's extraction usability is decided downstream
 * at the submission seam (the kernel preserves the existing raw input without
 * parsing it), so a single refused call always lands on the extraction arm
 * with the refusal RETAINED — the submission seam then either accepts the
 * rawJson (no retry consumed) or rejects, at which point the caller holds
 * both causes. There is deliberately no verdict-path
 * `refused-call-no-fallback` arm: the kernel cannot see the extraction
 * verdict here, and inventing one would be a caller-maintained policy.
 *
 * The expected binding is the verdict-kind refinement (judge-verdict or
 * refutation-verdict) of the issued binding — one kind per issued attempt
 * (AD-6), so a reviewer-payload call in a verdict attempt refuses as
 * unexpected-kind instead of being consulted or ignored, and the old
 * kind-filtered "verdict count spans both kinds" behavior is superseded by
 * the binding check (FR-014).
 */
export type VerdictSourceSelection =
  | Readonly<{
      kind: "emission-tool-arguments";
      rawJson: string;
      source: "emission-tool";
      /** The accepted call, projected to the contract fields — the accepted
       *  verdict's provenance (FR-009), returned by the decision. */
      call: EmissionToolCall;
    }>
  | Readonly<{
      kind: "final-message-extraction";
      /** The caller's existing rawJson — the captured attempt bytes it already
       *  submits — returned byte-verbatim, so the union carries the
       *  deterministic winner in every state and the caller's fold is uniform. */
      rawJson: string;
      source: "extraction";
      /** FR-006: the retained refusal of the single engine-refused emission
       *  call that led here — null when no call was observed (the no-op
       *  baseline). */
      emissionRefusal: EmissionParseFailure | null;
    }>
  | Readonly<{ kind: "duplicate-emission-call" }>
  | Readonly<{ kind: "observation-refused"; refusal: EmissionObservationRefusal }>;

export function selectVerdictSource(
  expected: IssuedEmissionBindingOf<"judge-verdict" | "refutation-verdict">,
  observation: EmissionObservation,
  existingRawJson: string,
): VerdictSourceSelection {
  const decision = decideBoundObservation(expected, observation);
  if (decision.kind === "observation-refused" || decision.kind === "duplicate-emission-call") {
    return decision;
  }
  if (decision.kind === "single-call") {
    const admitted = admitBoundCall(expected, decision.call);
    if (admitted.kind === "valid") {
      return canonicalRecord({
        kind: "emission-tool-arguments" as const,
        rawJson: JSON.stringify(admitted.payload, null, 2),
        source: "emission-tool" as const,
        call: canonicalCall(decision.call),
      });
    }
    return canonicalRecord({
      kind: "final-message-extraction" as const,
      rawJson: existingRawJson,
      source: "extraction" as const,
      emissionRefusal: retainedRefusalOf(admitted),
    });
  }
  return canonicalRecord({
    kind: "final-message-extraction" as const,
    rawJson: existingRawJson,
    source: "extraction" as const,
    emissionRefusal: null,
  });
}
