/**
 * Decompose-time Spec Index observation.
 *
 * Distinct from the Wave Gate's observation on purpose. At the gate, a spec
 * that cannot be read is a refusal: evidence must name exact bytes. Here,
 * recording Requirement content hashes is an enhancement over a graph that
 * would otherwise report drift as unverifiable — so a missing, unreadable, or
 * non-canonical specification degrades to a stated reason instead of failing a
 * decompose that is otherwise valid.
 */

import { readFileSync } from "node:fs";
import type { SpecIndexAvailability } from "../core/requirement-coverage";
import { parseSpec } from "../core/parse-spec";

/** Imperative-shell read. Never throws: every failure is a stated reason. */
export function observeSpecIndex(specFile: string | null): SpecIndexAvailability {
  if (specFile === null) {
    return Object.freeze({ kind: "unavailable", reason: Object.freeze({ kind: "no-spec-file" }) });
  }
  let text: string;
  try {
    text = readFileSync(specFile, "utf8");
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
  const parsed = parseSpec(text);
  return parsed.ok
    ? Object.freeze({ kind: "indexed", path: specFile, index: parsed.value })
    : Object.freeze({
        kind: "unavailable",
        reason: Object.freeze({ kind: "unparsed", path: specFile, errors: parsed.errors }),
      });
}
