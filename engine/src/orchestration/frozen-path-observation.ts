/**
 * Observe the bytes an Acceptance Freeze names. Shared by the Wave Gate's
 * completion suite (stamp and drift) and the operator Contract Revision, so
 * both judge the same digest of the same no-follow read.
 */

import { join } from "node:path";
import { sha256Bytes } from "../core/digest";
import { parseArtifactDigest } from "../core/orchestration-contract";
import type { FrozenPathObservation, FrozenPathObservations } from "../core/acceptance-contract";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";
import { readRunBytesNoFollow } from "./no-follow-fs";

/** Each path's current repository bytes as a digest, or why they could not
 *  be read without following a link (absent, a link, a directory, denied). */
export function observeFrozenDigests(
  root: CanonicalRepositoryRoot,
  paths: readonly string[],
): FrozenPathObservations {
  return new Map(paths.map((path): readonly [string, FrozenPathObservation] => {
    try {
      const digest = parseArtifactDigest(sha256Bytes(readRunBytesNoFollow(join(root, path))));
      return [path, digest.ok
        ? Object.freeze({ kind: "digest", sha256: digest.value })
        : Object.freeze({ kind: "unreadable", reason: "the bytes did not hash to a sha256 digest" })];
    } catch (error) {
      return [path, Object.freeze({ kind: "unreadable", reason: error instanceof Error ? error.message : String(error) })];
    }
  }));
}
