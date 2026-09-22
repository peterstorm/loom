import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
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
function documentPathWithinProject(path: string, projectRoot: string): string {
  const root = resolve(projectRoot);
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../") ||
      fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) {
    throw new Error(`Wave spec-check document ${path} is outside TaskGraph Project Boundary ${root}`);
  }
  return absolute;
}

function observeDocument(path: string | null, projectRoot: string): ObservedDocument {
  if (path === null) {
    return Object.freeze({
      kind: "absent",
      authority: Object.freeze({ path: null, contentDigest: null }),
    });
  }
  let bytes: Buffer;
  try {
    bytes = readRunBytesNoFollow(documentPathWithinProject(path, projectRoot));
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

export type WaveSpecCheckDocumentObservationRequest = Readonly<{
  specFile: string | null;
  planFile: string | null;
  projectRoot: string;
}>;

/** Imperative-shell byte observation. Call before entering any TaskGraph lock.
 * One request binds both document names to one required Project Boundary. */
export function observeWaveSpecCheckDocuments(
  request: WaveSpecCheckDocumentObservationRequest,
): WaveSpecCheckObservation {
  const spec = observeDocument(request.specFile, request.projectRoot);
  const plan = observeDocument(request.planFile, request.projectRoot);
  return Object.freeze({
    authority: Object.freeze({ spec: spec.authority, plan: plan.authority }),
    specIndex: indexOf(spec),
  });
}
