/**
 * Decompose-time Spec Index observation.
 *
 * Distinct from the Wave Gate's observation on purpose. At the gate, a spec
 * that cannot be read is a refusal: evidence must name exact bytes. Here,
 * recording Requirement content hashes is an enhancement over a graph that
 * would otherwise report drift as unverifiable — so a missing, unreadable, or
 * non-canonical specification degrades to a stated reason instead of failing a
 * decompose that is otherwise valid.
 *
 * The read policy is all that differs between the two observers; the
 * bytes-to-availability projection they share lives in `projectSpecBytes`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SpecIndexAvailability } from "../core/requirement-coverage";
import { parseSpec } from "../core/parse-spec";

/**
 * The one bytes-to-availability projection, shared by both observers.
 *
 * The digest is taken from the very bytes that were parsed, so an `indexed`
 * result cannot name a document it was not derived from — the property both
 * observers' callers rely on and neither should re-establish for itself.
 */
export function projectSpecBytes(path: string, bytes: Buffer): SpecIndexAvailability {
  const parsed = parseSpec(bytes.toString("utf8"));
  const contentDigest = createHash("sha256").update(bytes).digest("hex");
  return parsed.ok
    ? Object.freeze({ kind: "indexed", path, contentDigest, index: parsed.value })
    : Object.freeze({
        kind: "unavailable",
        reason: Object.freeze({ kind: "unparsed", path, errors: parsed.errors }),
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
