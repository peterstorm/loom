/**
 * The deterministic payload-source selection for the ingestion seams: the
 * reviewer payload path's canonical-payload selection and the panel verdict
 * paths' verdict-source selection. Additive preference, fallback preservation,
 * and duplicate rejection are each a discriminated-union member — the
 * "both sources present and valid" state's deterministic winner is encoded in
 * the union, not a caller convention, so provenance cannot drift.
 *
 * Pure module: no I/O, no clock, no randomness. PR #52's fail-closed extraction
 * is consumed verbatim (`parseFinalPayload` — never modified), so wherever the
 * selection is not emission-tool-arguments the fallback behavior is exactly
 * today's: any behavioral divergence from the no-op baseline can only originate
 * from the validated, deterministic emission path (the containment property).
 */

import { createHash } from "node:crypto";
import {
  admitEmissionArguments,
  EMISSION_TOOL_SPECS,
  type EmissionSchemaVersion,
} from "./emission-tool";
import {
  parseFinalPayload,
  type CaptureRejection,
  type FinalPayload,
  type FinalPayloadCandidate,
} from "./harness-capture";
import {
  canonicalRecord,
  type ArtifactDigest,
  type DomainResult,
} from "./orchestration-contract/identity";
import type { PayloadProducerKind } from "./model-profiles";

/**
 * The narrow view of an observed emission-tool call that the selection
 * functions read: the producer kind (the ADT `producerKindsOfAgent` mints),
 * the schema version the spawn was bound to, and the arguments as the harness
 * observed them. The harness adapters' full emission-tool record satisfies
 * this structurally — the selection reads no harness provenance, so a record
 * carrying more than this is admitted unchanged.
 */
export type EmissionToolCallRecord = Readonly<{
  kind: PayloadProducerKind;
  version: EmissionSchemaVersion;
  arguments: unknown;
}>;

/**
 * The reviewer payload path's deterministic canonical-payload selection.
 *
 * Exactly one emission record with arguments valid per the registry's
 * schema-level parse wins deterministically over final-message extraction
 * (FR-003/AS-003); extraction is not consulted. Zero records, or an invalid
 * record, leave PR #52's `parseFinalPayload` engaging exactly as today
 * (FR-004/FR-005/AS-006) — invalid records are never-ingestable (FR-006), and
 * the caller journals the consumed retry round from the records it passed in.
 * More than one record is ambiguity, fail-closed to the emission-tool budget
 * (FR-007/AS-007).
 *
 * The selection is scoped to the canonical path's producer kind: records for
 * the other kinds belong to their own paths and are not consulted here — a
 * judge record in a reviewer spawn's transcript is ignored and the fallback
 * engages exactly as today (the no-op baseline).
 */
export type IngestionSelection =
  | Readonly<{ kind: "emission-tool-arguments"; payload: FinalPayload; source: "emission-tool" }>
  | Readonly<{
      kind: "final-message-extraction";
      /** PR #52's parseFinalPayload result, verbatim: success carries the
       *  admitted payload, rejection carries the existing zero-candidate and
       *  ambiguity rejection vocabulary the caller terminalises as today. */
      fallback: DomainResult<FinalPayload, CaptureRejection>;
      source: "extraction";
    }>
  | Readonly<{ kind: "duplicate-emission-call" }>;

const encoder = new TextEncoder();

/**
 * The canonical payload bytes for validated emission arguments: encoded ONCE,
 * deterministically — no trim, no join, no re-indent — the same encode-once
 * rule the fallback's `parseFinalPayload` applies to harness text.
 */
function finalPayloadOfArguments(payload: unknown, origin: string): FinalPayload {
  const text = JSON.stringify(payload, null, 2);
  const bytes = Array.from(encoder.encode(text));
  return canonicalRecord({
    origin,
    text,
    bytes: Object.freeze(bytes),
    byteLength: bytes.length,
    digest: createHash("sha256").update(Uint8Array.from(bytes)).digest("hex") as ArtifactDigest,
  });
}

export function selectCanonicalPayload(
  emissionRecords: readonly EmissionToolCallRecord[],
  finalMessageCandidates: readonly FinalPayloadCandidate[],
): IngestionSelection {
  const reviewerRecords = emissionRecords.filter((record) => record.kind.kind === "reviewer-payload");
  if (reviewerRecords.length > 1) {
    return Object.freeze({ kind: "duplicate-emission-call" as const });
  }
  if (reviewerRecords.length === 1) {
    const record = reviewerRecords[0]!;
    const admitted = admitEmissionArguments(REVIEWER_PAYLOAD_SPEC, record.version, record.arguments);
    if (admitted.kind === "valid") {
      return Object.freeze({
        kind: "emission-tool-arguments" as const,
        payload: finalPayloadOfArguments(admitted.payload, "emission-tool-arguments"),
        source: "emission-tool" as const,
      });
    }
  }
  return Object.freeze({
    kind: "final-message-extraction" as const,
    fallback: parseFinalPayload(finalMessageCandidates),
    source: "extraction" as const,
  });
}

const REVIEWER_PAYLOAD_SPEC = EMISSION_TOOL_SPECS["reviewer-payload"];

/**
 * The panel verdict paths' deterministic verdict-source selection.
 *
 * Exactly one emission record with arguments valid per the registry's
 * schema-conformance parse wins deterministically; its serialized arguments
 * become the rawJson the submission seam parses — the authoritative engine-side
 * gate with the issuance-join inside (FR-012 retained verbatim). Zero records,
 * or invalid records, leave the caller's existing rawJson standing byte-verbatim:
 * the kernel's fail-closed extraction engages exactly as today. More than one
 * valid record is ambiguity, fail-closed to the emission-tool budget
 * (FR-007/AS-007).
 *
 * The selection is scoped to the verdict producer kinds: records for the
 * canonical path's kind are not consulted here.
 */
export type VerdictSourceSelection =
  | Readonly<{ kind: "emission-tool-arguments"; rawJson: string; source: "emission-tool" }>
  | Readonly<{
      kind: "final-message-extraction";
      /** The caller's existing rawJson — the captured attempt bytes it already
       *  submits — returned byte-verbatim, so the union carries the
       *  deterministic winner in every state and the caller's fold is uniform. */
      rawJson: string;
      source: "extraction";
    }>
  | Readonly<{ kind: "duplicate-emission-call" }>;

export function selectVerdictSource(
  transcriptText: string,
  emissionRecords: readonly EmissionToolCallRecord[],
): VerdictSourceSelection {
  const verdictRecords = emissionRecords.filter((record) => record.kind.kind !== "reviewer-payload");
  const validRawJson = verdictRecords.flatMap((record) => {
    const admitted = admitEmissionArguments(
      EMISSION_TOOL_SPECS[record.kind.kind],
      record.version,
      record.arguments,
    );
    return admitted.kind === "valid" ? [JSON.stringify(admitted.payload, null, 2)] : [];
  });
  if (validRawJson.length > 1) {
    return Object.freeze({ kind: "duplicate-emission-call" as const });
  }
  if (validRawJson.length === 1) {
    return Object.freeze({
      kind: "emission-tool-arguments" as const,
      rawJson: validRawJson[0]!,
      source: "emission-tool" as const,
    });
  }
  return Object.freeze({
    kind: "final-message-extraction" as const,
    rawJson: transcriptText,
    source: "extraction" as const,
  });
}
