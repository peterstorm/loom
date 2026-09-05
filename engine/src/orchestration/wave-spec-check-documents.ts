import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArtifactDigest } from "../core/orchestration-contract";
import type { SpecIndexAvailability } from "../core/requirement-coverage";
import { parseSpec } from "../core/parse-spec";
import type {
  WaveSpecCheckDocumentAuthority,
  WaveSpecCheckDocumentsAuthority,
} from "../types";

/**
 * One spec-check observation: the serializable document authority and the Spec
 * Index projected from the very bytes that authority's digest names.
 *
 * They travel together because they are one fact. Observing the digest and the
 * Spec Index through two reads would let the file change in between, and a
 * projection attributed to a digest it was not derived from is worse than no
 * projection at all — it reads as evidence.
 */
export type WaveSpecCheckObservation = Readonly<{
  authority: WaveSpecCheckDocumentsAuthority;
  specIndex: SpecIndexAvailability;
}>;

type ObservedDocument = Readonly<{
  authority: WaveSpecCheckDocumentAuthority;
  bytes: Buffer | null;
}>;

function observeDocument(path: string | null): ObservedDocument {
  if (path === null) return Object.freeze({ authority: Object.freeze({ path: null, contentDigest: null }), bytes: null });
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(
      `cannot read Wave spec-check document ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const digest = parseArtifactDigest(createHash("sha256").update(bytes).digest("hex"));
  if (!digest.ok) throw new Error(digest.error.message);
  return Object.freeze({ authority: Object.freeze({ path, contentDigest: digest.value }), bytes });
}

/** Project the observed spec bytes, never a second read of the same path. */
function indexOf(spec: ObservedDocument): SpecIndexAvailability {
  if (spec.authority.path === null || spec.bytes === null) {
    return Object.freeze({ kind: "unavailable", reason: Object.freeze({ kind: "no-spec-file" }) });
  }
  const parsed = parseSpec(spec.bytes.toString("utf8"));
  return parsed.ok
    ? Object.freeze({ kind: "indexed", path: spec.authority.path, index: parsed.value })
    : Object.freeze({
        kind: "unavailable",
        reason: Object.freeze({ kind: "unparsed", path: spec.authority.path, errors: parsed.errors }),
      });
}

/** Imperative-shell byte observation. Call before entering any TaskGraph lock. */
export function observeWaveSpecCheckDocuments(
  specFile: string | null,
  planFile: string | null,
): WaveSpecCheckObservation {
  const spec = observeDocument(specFile);
  const plan = observeDocument(planFile);
  return Object.freeze({
    authority: Object.freeze({ spec: spec.authority, plan: plan.authority }),
    specIndex: indexOf(spec),
  });
}
