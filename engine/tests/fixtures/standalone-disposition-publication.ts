import { canonicalStructuralEquals } from "../../src/core/orchestration-contract";
import { readPublishedStandaloneDisposition, type PreparedStandaloneDisposition, type StandaloneDispositionPublicationReader } from "../../src/core/standalone-review";
import { valueOf } from "./standalone-remediation-authority";

/** In-memory publication adapter. Production uses authenticated Run registration/receipt/artifact reads. */
export function dispositionPublicationFixture(prepared: PreparedStandaloneDisposition) {
  const reference = Object.freeze({ locator: `/owned/dispositions/revision-${prepared.digest}`, runId: `revision-${prepared.digest}`, dispositionDigest: prepared.digest });
  const recordBytes = new TextEncoder().encode(JSON.stringify(prepared.record));
  const receipt = { kind: "artifact-set-published", effectId: `effect:standalone-disposition:${prepared.digest}`, runId: reference.runId,
    artifacts: [{ runId: reference.runId, slot: { kind: "fixed-artifact-slot", path: "artifacts/disposition.json" }, digest: prepared.digest, byteLength: recordBytes.length }] };
  const reader: StandaloneDispositionPublicationReader = lookup => canonicalStructuralEquals(lookup, reference)
    ? { ok: true, value: { recordBytes, receipt } } : { ok: false, error: { message: "publication missing" } };
  return { reference, recordBytes, receipt, reader, published: valueOf(readPublishedStandaloneDisposition(prepared, reference, reader)) };
}
