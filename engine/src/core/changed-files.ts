/**
 * The one derivation of a Task's changed files at stop (INV-7, FR-019,
 * FR-034). The Claude stop dispatcher, the Pi report-only stop and
 * `helper stop-check-plan` supply only the attempt epoch's ledger events and
 * a stop-time existence predicate. None of them filters, dedupes or
 * relativizes a path itself.
 *
 * The steps, in order:
 * - take the epoch's FileWrite paths, deduplicated in first-write order;
 * - drop paths outside the repository;
 * - drop paths the predicate says are absent at stop time;
 * - parse the rest into `ChangedFiles`.
 *
 * A renamed file arrives under its new path as its own `mv`/`cp` destination
 * FileWrite, so it needs no special case here.
 *
 * Pure and total: the predicate is the only fact from the filesystem, and it is injected.
 */

import type { ChangedFilePath, ChangedFiles, ChangedFilesAtStopFn } from "./affected-stop-check-types";
import { nonEmpty } from "./acceptance-contract/kernel";
import { parseRepositoryPath } from "./repository-path";
import { parseReviewPath } from "./review-packet";

/** No changed files: the derivation over an epoch with none, and the plan
 *  input wherever only the acceptance arm is asked about. */
export const NO_CHANGED_FILES: ChangedFiles = Object.freeze({ kind: "none" });

/**
 * A FileWrite path as a canonical repository-relative path, or null when it
 * lies outside the repository or is not a path at all. A relative path is
 * read against the repository root, the directory an agent's tools run from.
 */
function changedFilePath(repositoryRoot: string, raw: string): ChangedFilePath | null {
  const inside = parseRepositoryPath(repositoryRoot, raw);
  if (!inside.ok) return null;
  const parsed = parseReviewPath(inside.value.relative);
  return parsed.ok ? parsed.value : null;
}

export const changedFilesAtStop: ChangedFilesAtStopFn = (events, repositoryRoot, exists) => {
  const written = events.flatMap((event) => {
    if (event.kind !== "FileWrite") return [];
    const path = changedFilePath(repositoryRoot, event.path);
    return path === null ? [] : [path];
  });
  const files = nonEmpty([...new Set(written)].filter((path) => exists(path)));
  return files === null ? NO_CHANGED_FILES : Object.freeze({ kind: "some", files });
};
