/**
 * no-duplicate-block — a block of code written twice is a second owner.
 *
 * Fires when the file being linted holds a run of tokens that also appears in
 * another project file, or again in itself (`clones/clone-detection.ts` defines
 * the run). It runs on every edit, so the copy is refused while its author
 * still knows what it is a copy of, and again at the Wave Gate.
 *
 * Test files are in scope: a fixture builder pasted into a second test file is
 * the commonest copy there is, and the one that comes back after every
 * consolidation.
 *
 * Pure given its corpus: the rule decides from the file's text and the sources
 * the corpus nominates. The corpus is the shell (`clones/project-corpus.ts`).
 */

import { makeViolation, type Violation } from "../types";
import {
  clonesBetween,
  fingerprint,
  type Clone,
  type CloneCorpus,
  type CloneOptions,
} from "../clones/clone-detection";
import { baselineCounter, baselineKey, projectRelative, type Baseline, type BaselineKey } from "./baseline";

export const RULE_NAME = "no-duplicate-block";

export const FIX_HINT =
  "Import the existing code instead of copying it, or move the shared part into one module both places import " +
  "(a test builder belongs in a shared fixtures module). Pre-existing copies: `lint-project --write-baseline`.";

export type DuplicateBlockOptions = Readonly<{
  clone: CloneOptions;
  /** Grandfathered `path::otherPath@digest` keys, one copy each. */
  baseline: Baseline;
  /** The project root baseline keys and corpus paths are relative to, or null with no project. */
  projectRoot: string | null;
}>;

/** Every clone the file holds: of itself, then of each source the corpus nominates. */
function clonesIn(content: string, path: string, corpus: CloneCorpus, options: CloneOptions): readonly Clone[] {
  const target = fingerprint(path, content, options);
  return [
    ...clonesBetween(target, target, options),
    ...corpus.candidates(target).flatMap((other) => clonesBetween(target, other, options)),
  ];
}

/** What a baseline entry names: the other side of the copy and the copied tokens' digest. */
const keyOf = (clone: Clone): BaselineKey => baselineKey(clone.here.path, `${clone.there.path}@${clone.digest}`);

const lineRange = (site: Clone["here"]): string => `${site.startLine}-${site.endLine}`;

const describe = (clone: Clone): string =>
  `lines ${lineRange(clone.here)} repeat ${clone.there.path}:${lineRange(clone.there)} (${clone.tokens} tokens)`;

/** The keys of every copy the rule would flag absent its baseline. */
export function detectedCloneKeys(
  content: string,
  filePath: string,
  corpus: CloneCorpus,
  options: DuplicateBlockOptions,
): readonly BaselineKey[] {
  return clonesIn(content, projectRelative(filePath, options.projectRoot), corpus, options.clone).map(keyOf);
}

export function handler(
  content: string,
  filePath: string,
  corpus: CloneCorpus,
  options: DuplicateBlockOptions,
): readonly Violation[] {
  const baseline = baselineCounter(options.baseline);
  return clonesIn(content, projectRelative(filePath, options.projectRoot), corpus, options.clone)
    .filter((clone) => !baseline.consume(keyOf(clone)))
    .map((clone) => makeViolation(RULE_NAME, filePath, clone.here.startLine, describe(clone), FIX_HINT));
}
