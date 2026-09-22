import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { parseArtifactDigest } from "../core/orchestration-contract";
import type { SpecIndexAvailability, WaveSpecCheckObservation } from "../core/wave-review-authority";
import { projectSpecBytes } from "./spec-index-observation";
import type { WaveSpecCheckDocumentAuthority } from "../types";
import { readRunBytesNoFollow } from "./no-follow-fs";

export type { WaveSpecCheckObservation } from "../core/wave-review-authority";

type ObservedDocument =
  | Readonly<{
      kind: "absent";
      authority: Readonly<{ path: null; contentDigest: null }>;
    }>
  | Readonly<{
      kind: "observed";
      authority: Extract<WaveSpecCheckDocumentAuthority, Readonly<{ path: string }>>;
      bytes: Buffer;
    }>;

/**
 * Gate-time read policy: a recorded document that cannot be read is a refusal,
 * not a degradation. Gate evidence must name exact bytes, so there is no
 * `unreadable` outcome on this path — the observation throws instead.
 */
function observeDocument(path: string | null, projectRoot?: string): ObservedDocument {
  if (path === null) {
    return Object.freeze({
      kind: "absent",
      authority: Object.freeze({ path: null, contentDigest: null }),
    });
  }
  if (!isAbsolute(path) && projectRoot === undefined) {
    throw new Error(`cannot read project-relative Wave spec-check document ${path} without a TaskGraph Project Boundary`);
  }
  let bytes: Buffer;
  try {
    bytes = readRunBytesNoFollow(isAbsolute(path) ? path : resolve(projectRoot!, path));
  } catch (error) {
    throw new Error(
      `cannot read Wave spec-check document ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const digest = parseArtifactDigest(createHash("sha256").update(bytes).digest("hex"));
  if (!digest.ok) throw new Error(digest.error.message);
  return Object.freeze({
    kind: "observed",
    authority: Object.freeze({ path, contentDigest: digest.value }),
    bytes,
  });
}

/** Project the observed spec bytes, never a second read of the same path. */
function indexOf(spec: ObservedDocument): SpecIndexAvailability {
  return spec.kind === "absent"
    ? Object.freeze({ kind: "unavailable", reason: Object.freeze({ kind: "no-spec-file" }) })
    : projectSpecBytes(spec.authority.path, spec.bytes);
}

/** Imperative-shell byte observation. Call before entering any TaskGraph lock. */
export function observeWaveSpecCheckDocuments(
  specFile: string | null,
  planFile: string | null,
  projectRoot?: string,
): WaveSpecCheckObservation {
  const spec = observeDocument(specFile, projectRoot);
  const plan = observeDocument(planFile, projectRoot);
  return Object.freeze({
    authority: Object.freeze({ spec: spec.authority, plan: plan.authority }),
    specIndex: indexOf(spec),
  });
}
