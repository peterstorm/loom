/**
 * Existing issued-successor entry surface for capture and protocol consumers.
 * Admission and aggregation share the Standalone Review aggregate's private
 * prepared-source/evidence membership; there is no second lifecycle here.
 *
 * The surface also carries the successor's OWN half of the emission seam's
 * issuance join (T9, AD-6/AD-7/AD-8, FR-001/FR-012): the issued v3 authority
 * `standaloneSuccessorEmissionBinding` parses the successor registration's
 * raw protocol descriptor with the exact frozen-v3 parser and derives the
 * successor's `reviewer-payload` emission binding — locked to the successor's
 * own cell by the v3 literal, so the successor surface cannot derive a v2,
 * judge, or refutation binding (the path scoping is a type fact, never a
 * runtime claim). The capture runtime and the request programs independently
 * re-derive the same binding from the durable registration through the ONE
 * frozen-registry mint; this typed derivation is the successor-side half
 * those independent derivations must agree with, and the agreement is the
 * FR-012 issuance join the successor suites pin. The successor's
 * prior-origin/coverage admission joins below are SOURCE-BLIND by
 * construction: they parse and join captured bytes the same way whether the
 * emission tool or the final message produced them, so an emission-selected
 * payload crosses the identical joins and a source can never override
 * issuance.
 *
 * Purity boundary: this module is a declared pure module (the shipped
 * `no-io-in-pure-modules` closure), so it never imports the emission
 * transport modules (`emission-tool`/`emission-ingestion`) — they sit outside
 * the closure with the zod dependency. The binding shape and the frozen
 * vocabulary below are structural mirrors of the kernel's contract, derived
 * from the surface's OWN frozen bytes (`STANDALONE_REVIEWER_SCHEMA_V3` — the
 * exact bytes the registry's v3 cell carries, pinned byte-for-byte by the
 * successor suites); a kernel drift fails the successor suites' agreement
 * test against the ONE registry mint, never silently.
 */
export {
  standaloneSuccessorReviewerRegistration,
  buildStandaloneSuccessorReviewerContext,
  parseIssuedStandaloneSuccessorReviewer,
  admitStandaloneSuccessorReviewer,
  aggregateIssuedStandaloneSuccessorEvidence,
  type IssuedStandaloneSuccessorReviewer,
} from "./standalone-review";

import { sha256Hex } from "./review-packet";
import {
  parseStandaloneReviewerProtocolV3,
  STANDALONE_REVIEWER_SCHEMA_V3,
} from "./standalone-lineage-contract";
import {
  canonicalRecord,
  failure,
  parseRequestId,
  success,
  type ArtifactDigest,
  type DomainResult,
  type RequestId,
} from "./orchestration-contract/identity";

/** The successor's derived emission binding — the structural mirror of the
 *  emission kernel's issued reviewer-payload binding, version-locked to the
 *  successor's own v3 cell. Every field is derived here from the ONE frozen
 *  source (the descriptor parse and the frozen schema bytes), never trusted
 *  from a claim. */
export type StandaloneSuccessorEmissionBinding = Readonly<{
  requestId: RequestId;
  kind: Readonly<{ kind: "reviewer-payload" }>;
  version: "v3";
  toolName: "loom_emit_reviewer_payload";
  schemaDigest: ArtifactDigest;
}>;

/** The successor surface's own closed emission-refusal vocabulary, ahead of
 *  the ONE registry mint's wider one: a protocol descriptor that is not the
 *  exact frozen v3 descriptor cannot select the successor's emission identity
 *  at all, and a non-canonical request identity refuses through the shared
 *  identity kernel's parse. The v3-locked derivation leaves the mint's other
 *  refusal arms (unknown kind, unsupported version, tool-name or digest
 *  mismatch) unrepresentable here. */
export type StandaloneSuccessorEmissionRefusal =
  | Readonly<{ code: "successor-protocol-mismatch"; message: string }>
  | Readonly<{ code: "invalid-request-identity"; message: string }>;

/** The registry's frozen reviewer-payload emission tool name — structural
 *  mirror of the kernel's `EmissionToolName` member for this kind. The ONE
 *  truth is the frozen registry; the successor suites' agreement test derives
 *  the same field through the real mint, so a drift fails loudly there. */
const SUCCESSOR_EMISSION_TOOL_NAME = "loom_emit_reviewer_payload" as const;

/**
 * The successor's issued emission authority (T9): parse the successor
 * registration's raw protocol descriptor and derive the successor's v3-locked
 * `reviewer-payload` emission binding. The descriptor parse is the gate —
 * only the EXACT frozen v3 descriptor reaches the derivation, and the
 * binding's schema digest is re-derived from the surface's OWN frozen schema
 * bytes (the same bytes the registry's v3 cell carries and the packet's
 * reviewer-payload-schema section embeds — one schema, one contract, AD-5),
 * never read from the claim. A drifted or foreign descriptor refuses with the
 * successor surface's own arm; a non-canonical request identity refuses
 * through the shared identity kernel's parse. Never a default, never a
 * current-default version.
 *
 * Pure: no I/O, no ambient reads. Raw claims in, validated binding or a
 * typed refusal out — parse, don't validate.
 */
export function standaloneSuccessorEmissionBinding(issued: Readonly<{
  requestId: string;
  protocolDescriptor: unknown;
}>): DomainResult<StandaloneSuccessorEmissionBinding, StandaloneSuccessorEmissionRefusal> {
  const descriptor = parseStandaloneReviewerProtocolV3(issued.protocolDescriptor);
  if (!descriptor.ok) {
    return failure(canonicalRecord({
      code: "successor-protocol-mismatch" as const,
      message: `the successor protocol descriptor does not certify the frozen standalone-successor v3 contract, so it selects no emission identity: ${descriptor.error.message}`,
    }));
  }
  const requestId = parseRequestId(issued.requestId);
  if (!requestId.ok) {
    return failure(canonicalRecord({
      code: "invalid-request-identity" as const,
      message: `the successor emission binding carries no canonical request id: ${requestId.error.message}`,
    }));
  }
  // The digest is RE-DERIVED from the frozen v3 schema bytes — the same
  // derivation the protocol descriptor's own schemaDigest and the registry's
  // v3 cell apply — so the certified digest can never drift from the bytes.
  // The descriptor parse above already certified this exact digest; the
  // derivation keeps the binding's own field anchored to the ONE source.
  return success(canonicalRecord({
    requestId: requestId.value,
    kind: canonicalRecord({ kind: "reviewer-payload" as const }),
    version: "v3" as const,
    toolName: SUCCESSOR_EMISSION_TOOL_NAME,
    schemaDigest: sha256Hex(STANDALONE_REVIEWER_SCHEMA_V3) as ArtifactDigest,
  }));
}
