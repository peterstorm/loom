/**
 * Observe the bytes an Acceptance Freeze names. Shared by the Wave Gate's
 * completion suite (stamp and drift) and the operator Contract Revision, so
 * both judge the same digest of the same no-follow read.
 */

import { join } from "node:path";
import { sha256Bytes } from "../core/digest";
import { parseArtifactDigest, type ArtifactDigest } from "../core/orchestration-contract";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";
import { readRunBytesNoFollow } from "./no-follow-fs";

/** The digest of each path's current repository bytes; null when it is
 *  absent or cannot be read without following a link. */
export function observeFrozenDigests(
  root: CanonicalRepositoryRoot,
  paths: readonly string[],
): ReadonlyMap<string, ArtifactDigest | null> {
  return new Map(paths.map((path) => {
    try {
      const digest = parseArtifactDigest(sha256Bytes(readRunBytesNoFollow(join(root, path))));
      return [path, digest.ok ? digest.value : null] as const;
    } catch {
      return [path, null] as const;
    }
  }));
}
