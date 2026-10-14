/**
 * Decompose-time Spec Index observation.
 *
 * Distinct from the Wave Gate's observation on purpose. At the gate, a spec
 * that cannot be read is a refusal: evidence must name exact bytes. Here the
 * read never throws: a missing, unreadable, or non-canonical specification is
 * a stated reason, and population decides what it means — it refuses every
 * reason but `no-spec-file`, and refuses that one too once a Task names a
 * Requirement id.
 *
 * The read policy is all that differs between the two observers; the
 * bytes-to-availability projection they share lives in `projectSpecBytes`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SpecIndexAvailability } from "../core/requirement-coverage";
import { parseSpec } from "../core/parse-spec";
import { parseArtifactDigest, type ArtifactDigest } from "../core/orchestration-contract";

/**
 * The one bytes-to-availability projection, shared by both observers.
 *
 * The digest and parse outcome come from the exact supplied bytes. `path` is
 * caller-provided document identity; the Wave observer couples it to its
 * authority and the consumer proves that pair against protected state.
 */
function digestSpecBytes(bytes: Buffer): ArtifactDigest {
  const parsed = parseArtifactDigest(createHash("sha256").update(bytes).digest("hex"));
  if (!parsed.ok) throw new Error(`SHA-256 produced an invalid Artifact Digest: ${parsed.error.message}`);
  return parsed.value;
}

export function projectSpecBytes(path: string, bytes: Buffer): SpecIndexAvailability {
  const contentDigest = digestSpecBytes(bytes);
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason: Object.freeze({
        kind: "invalid-encoding",
        path,
        contentDigest,
        reason: error instanceof Error ? error.message : String(error),
      }),
    });
  }
  const parsed = parseSpec(markdown);
  return parsed.ok
    ? Object.freeze({ kind: "indexed", path, contentDigest, index: parsed.value })
    : Object.freeze({
        kind: "unavailable",
        reason: Object.freeze({ kind: "unparsed", path, contentDigest, errors: parsed.errors }),
      });
}

/** Imperative-shell read. Never throws: every failure is a stated reason. */
export function observeSpecIndex(specFile: string | null): SpecIndexAvailability {
  if (specFile === null) {
    return Object.freeze({ kind: "unavailable", reason: Object.freeze({ kind: "no-spec-file" }) });
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(specFile);
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason: Object.freeze({
        kind: "unreadable",
        path: specFile,
        reason: error instanceof Error ? error.message : String(error),
      }),
    });
  }
  return projectSpecBytes(specFile, bytes);
}
