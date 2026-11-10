/**
 * The one no-follow read of a repository leaf that the skeleton observation
 * (`skeleton-observation.ts`) and the conformance observation
 * (`contract-conformance-observation.ts`) both make: what is at a path,
 * following no link at any component.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { DomainResult } from "../core/orchestration-contract";
import { readRunBytesNoFollow } from "../utils/no-follow-fs";
import { describeCause } from "../utils/describe-cause";

/** What one repository path holds, read without following any link. */
export type RepositoryLeaf =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "not-a-regular-file" }>
  | Readonly<{ kind: "file"; bytes: Buffer }>;

const ABSENT_LEAF: RepositoryLeaf = Object.freeze({ kind: "absent" });
const NOT_REGULAR: RepositoryLeaf = Object.freeze({ kind: "not-a-regular-file" });

/**
 * Read the leaf at `path` under the resolved repository root: absent when
 * nothing (or a non-directory ancestor) is there, `not-a-regular-file` for a
 * link, directory or other kind, else its bytes, read without following any
 * link. Why it could not be read is the error, phrased to follow the path.
 */
export function readRepositoryLeafNoFollow(realRoot: string, path: string): DomainResult<RepositoryLeaf, string> {
  const absolute = join(realRoot, path);
  try {
    if (!lstatSync(absolute).isFile()) return { ok: true, value: NOT_REGULAR };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { ok: true, value: ABSENT_LEAF }
      : { ok: false, error: `cannot observe it (${describeCause(error)})` };
  }
  try {
    return { ok: true, value: Object.freeze({ kind: "file", bytes: readRunBytesNoFollow(absolute) }) };
  } catch (error) {
    return { ok: false, error: `cannot read it without following a link (${describeCause(error)})` };
  }
}

