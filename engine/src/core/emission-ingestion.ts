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
 *     (zero → extraction verbatim; one → schema admission; ≥2 → ambiguity,
 *     with the ambiguity arm carrying its observed calls)
 *   → the single-call state admits the arguments through
 *     `admitIssuedEmissionArguments` (schema-driven wire-form
 *     canonicalization of the observed transport form, then schema selection
 *     through the issued registry cell — the execute shell's own admission).
 *     The canonicalization matters here because the transcript records what
 *     the model emitted, not what the child executed: on routes without
 *     server-side constrained decoding a conforming payload is observed with
 *     JSON-encoded strings for declared non-string fields. The binding is
 *     nominal (mint-only), so its registry cell is certified by type (AD-8)
 *     and accepted-call provenance can only carry a minted schema digest.
 *
 * The observation side of that pipeline — the transport frames, the closed
 * emission observation and its ONE fold — lives in `harness-capture` (the
 * additive emission observation/rejection vocabulary's stated home, shared
 * with the tool-surface contracts); this module imports it and owns the
 * BINDING and the SELECTION over it. Wrong kind/version/request and unusable
 * observations therefore reject before schema selection, and they are
 * REFUSALS, not absence: the boundary
 * classifies them (evidence/infrastructure), the kernel never invents a
 * successful fallback for them. The two semantic rejection arms —
 * `duplicate-emission-call` and `refused-call-no-fallback` — are the rows that
 * consume the existing request-slot attempt budget (one rejection, not two;
 * attempt 1 may advance to a fresh attempt-2 spawn, attempt 2 is terminal).
 * Startup/transport infrastructure unavailability produces no observation at
 * all and stays the shell's existing infrastructure recovery.
 *
 * Pure module: no I/O, no clock, no randomness; it must not import
 * the panel modules (panel-verdict-source.ts, persistent-panel.ts) or any I/O adapter (a placement constraint this header
 * states and review audits: the cross-import linter admits core-to-core
 * imports and the module is not enrolled in the purity closure, so this
 * declaration is the invariant's stated home, not an automated gate). PR
 * #52's fail-closed extraction is consumed verbatim
 * (`parseFinalPayload` — never modified, called exactly as the capture runtime
 * calls it), so wherever the selection is extraction the fallback behavior is
 * exactly today's: any behavioral divergence from the no-op baseline can only
 * originate from the validated, deterministic emission path. That containment
 * law holds for the zero-call state and for the single-refused-call state
 * where extraction is selected — and deliberately claims NOTHING for duplicate
 * or misbound calls (AD-9: property tests assert those rejection outcomes
 * rather than skip them under a misleading universal containment name).
 */

import {
  admitIssuedEmissionArguments,
  type EmissionArgumentAdmission,
  type EmissionParseFailure,
  type IssuedEmissionBinding,
  type IssuedEmissionBindingOf,
} from "./emission-tool";
import {
  canonicalCall,
  finalPayloadOf,
  parseFinalPayload,
  type CaptureRejection,
  type EmissionObservation,
  type EmissionObservationRefusal,
  type EmissionToolCall,
  type FinalPayload,
  type FinalPayloadCandidate,
} from "./harness-capture";
import {
  canonicalRecord,
  parseRequestId,
  type DomainResult,
} from "./orchestration-contract/identity";

// ---------------------------------------------------------------------------
// Binding check and count decision — shared by both selection functions
// ---------------------------------------------------------------------------

/**
 * The binding-checked, count-decided observation decision both selection
 * functions share: refusal before counting, counting before schema selection.
 * The duplicate arm carries the ambiguity's content — the observed DISTINCT
 * calls in first-observed order — so the selection's rejection names what was
 * observed instead of a bare count (FR-007), never reconstructed by callers
 * from the input frames.
 */
type ObservationDecision =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "single-call"; call: EmissionToolCall }>
  | Readonly<{ kind: "duplicate-emission-call"; calls: readonly EmissionToolCall[] }>
  | Readonly<{ kind: "observation-refused"; refusal: EmissionObservationRefusal }>;

/** The first misbinding of one observed call against the issued binding, or
 *  null when the call is correctly bound. Field order is the FR-014 check
 *  order: request attempt, then producer kind, then schema version.
 *
 *  The observed request id is untrusted transport data (the adapter's
 *  attribution), so it is PARSED here — where it first meets issued
 *  authority — and compared brand to brand: a malformed id and a foreign id
 *  are the same `wrong-request` refusal, never a raw string compared against
 *  a branded identity. */
const misbindingOf = (
  expected: IssuedEmissionBinding,
  call: EmissionToolCall,
): EmissionObservationRefusal | null => {
  const observedRequest = parseRequestId(call.requestId);
  if (!observedRequest.ok || observedRequest.value !== expected.requestId) {
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
  // Exhaustive over the guard-narrowed observation: every arm — the zero-call
  // arm included — is an explicit case, never an implicit fall-through return,
  // so a new observation arm fails to compile here instead of silently
  // selecting the extraction baseline.
  switch (observation.kind) {
    case "single-call":
      return canonicalRecord({ kind: "single-call" as const, call: observation.call });
    case "multiple-calls":
      return canonicalRecord({
        kind: "duplicate-emission-call" as const,
        calls: Object.freeze([...observation.calls]),
      });
    case "absent":
      return canonicalRecord({ kind: "absent" as const });
  }
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
 *   still one call (the fold). The rejection carries the ambiguity's content:
 *   the observed distinct calls in first-observed order.
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
       *  ambiguity rejection vocabulary the caller terminalises as today.
       *  This arm IS the no-op baseline: NO emission call was observed, so
       *  there is no refusal to retain — the field this arm used to carry as a
       *  nullable is representable only on the refused-call arm below. */
      fallback: DomainResult<FinalPayload, CaptureRejection>;
      source: "extraction";
    }>
  | Readonly<{
      kind: "extraction-over-refused-call";
      /** PR #52's parseFinalPayload result, verbatim (same contract as the
       *  baseline arm). Extraction was selected OVER a single engine-refused
       *  call and consumed no retry (FR-006). */
      fallback: DomainResult<FinalPayload, CaptureRejection>;
      source: "extraction";
      /** FR-006: the retained refusal of the single engine-refused emission
       *  call that led here — REQUIRED, not nullable: the arm exists only
       *  because a refusal was observed and retained. */
      emissionRefusal: EmissionParseFailure;
    }>
  | Readonly<{
      kind: "duplicate-emission-call";
      /** FR-007: the ambiguity's content — the observed DISTINCT calls in
       *  first-observed order, returned by the decision so the caller's
       *  terminal diagnostics name what was observed instead of a bare
       *  count, and never reconstructed from the input frames. */
      calls: readonly EmissionToolCall[];
    }>
  | Readonly<{
      kind: "refused-call-no-fallback";
      /** The single refused call's retained refusal (FR-006). */
      emissionRefusal: EmissionParseFailure;
      /** The extraction's existing rejection — both causes retained by one
       *  rejection, not two (AD-9). */
      extraction: CaptureRejection;
    }>
  | Readonly<{ kind: "observation-refused"; refusal: EmissionObservationRefusal }>;

/**
 * The canonical payload bytes for validated emission arguments: the ADMITTED
 * value (the registry parser's output) serialized deterministically, then
 * built through the fallback's own encode-once constructor. The stored bytes
 * are therefore this canonical encoding of what was admitted, not the
 * observed transport bytes — Pi exposes only parsed arguments at this seam
 * (ADR-0015), so no "exact admitted bytes" exist to store instead.
 */
const finalPayloadOfArguments = (payload: unknown): FinalPayload =>
  finalPayloadOf("emission-tool-arguments", JSON.stringify(payload, null, 2));

export function selectCanonicalPayload(
  expected: IssuedEmissionBindingOf<"reviewer-payload">,
  observation: EmissionObservation,
  finalMessageCandidates: readonly FinalPayloadCandidate[],
): IngestionSelection {
  const decision = decideBoundObservation(expected, observation);
  switch (decision.kind) {
    case "observation-refused":
    case "duplicate-emission-call":
      return decision;
    case "single-call": {
      const admitted = admitIssuedEmissionArguments(expected, decision.call.arguments);
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
          kind: "extraction-over-refused-call" as const,
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
    case "absent":
      return canonicalRecord({
        kind: "final-message-extraction" as const,
        fallback: parseFinalPayload(finalMessageCandidates),
        source: "extraction" as const,
      });
  }
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
       *  deterministic winner in every state and the caller's fold is uniform.
       *  The no-op baseline arm: NO emission call was observed, no refusal
       *  retained. */
      rawJson: string;
      source: "extraction";
    }>
  | Readonly<{
      kind: "extraction-over-refused-call";
      /** The caller's existing rawJson, byte-verbatim (same contract as the
       *  baseline arm). Extraction was selected OVER a single engine-refused
       *  call — the submission seam accepts it (no retry consumed) or rejects
       *  holding both causes (FR-006). */
      rawJson: string;
      source: "extraction";
      /** FR-006: the retained refusal of the single engine-refused emission
       *  call that led here — REQUIRED, not nullable. */
      emissionRefusal: EmissionParseFailure;
    }>
  | Readonly<{
      kind: "duplicate-emission-call";
      /** FR-007: the ambiguity's content — the observed DISTINCT calls in
       *  first-observed order (same contract as the reviewer path's arm),
       *  returned by the decision, never reconstructed from the frames. */
      calls: readonly EmissionToolCall[];
    }>
  | Readonly<{ kind: "observation-refused"; refusal: EmissionObservationRefusal }>;

export function selectVerdictSource(
  expected: IssuedEmissionBindingOf<"judge-verdict" | "refutation-verdict">,
  observation: EmissionObservation,
  existingRawJson: string,
): VerdictSourceSelection {
  const decision = decideBoundObservation(expected, observation);
  switch (decision.kind) {
    case "observation-refused":
    case "duplicate-emission-call":
      return decision;
    case "single-call": {
      const admitted = admitIssuedEmissionArguments(expected, decision.call.arguments);
      if (admitted.kind === "valid") {
        return canonicalRecord({
          kind: "emission-tool-arguments" as const,
          rawJson: JSON.stringify(admitted.payload, null, 2),
          source: "emission-tool" as const,
          call: canonicalCall(decision.call),
        });
      }
      return canonicalRecord({
        kind: "extraction-over-refused-call" as const,
        rawJson: existingRawJson,
        source: "extraction" as const,
        emissionRefusal: retainedRefusalOf(admitted),
      });
    }
    case "absent":
      return canonicalRecord({
        kind: "final-message-extraction" as const,
        rawJson: existingRawJson,
        source: "extraction" as const,
      });
  }
}
