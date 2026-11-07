/**
 * The engine's skeleton records as every writer step builds them: the
 * canonical skeleton of one bound path (`SkeletonCandidate`), the record the
 * engine keeps once those bytes are on disk, and the one way a batch of new
 * records is installed into a TaskGraph's `skeletons`. Registration, the
 * contract stub step and the Contract Revision all record through these. Pure.
 */

import type { GeneratedSkeleton, SkeletonOrigin, SkeletonRecord } from "./types";

/** The canonical skeleton of one bound path, with the contract and types-file
 *  digest its record names. */
export type SkeletonCandidate = Readonly<{ skeleton: GeneratedSkeleton; contract: string; typesSha256: string }>;

/** The record of one canonical skeleton the engine wrote, adopted or refreshed. */
export const skeletonRecordOf = (candidate: SkeletonCandidate, origin: SkeletonOrigin): SkeletonRecord =>
  Object.freeze({
    path: candidate.skeleton.path,
    contract: candidate.contract,
    language: candidate.skeleton.language,
    origin,
    engineSha256: candidate.skeleton.sha256,
    typesSha256: candidate.typesSha256,
    stale: null,
  });

/**
 * The skeleton records with `added` installed: one record per path, an added
 * record replacing the one at its path, sorted by path in code-unit order
 * (the order the State File wire proves).
 */
export function installSkeletonRecords(
  current: readonly SkeletonRecord[],
  added: readonly SkeletonRecord[],
): readonly SkeletonRecord[] {
  const byPath = new Map([...current, ...added].map((record) => [record.path, record] as const));
  return Object.freeze([...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)));
}
