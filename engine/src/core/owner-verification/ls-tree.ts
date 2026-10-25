/**
 * What `git ls-tree -z <base> -- <owner>` says about the owner at the Wave
 * base, as a pure function of the command's text (AD-8; FR-009). The shell
 * runs the command and reads the blob; this leaf only decides what the one
 * entry means.
 *
 * - No output: the owner did not exist at the base (a new file, so every
 *   line of it changed).
 * - One regular-file blob entry (mode `100644` or `100755`): its object id,
 *   the bytes the Wave's changed lines are diffed against.
 * - Anything else (a tree, a gitlink, or a symlink blob, mode `120000`,
 *   whose bytes are a link target and never the owner's text) is not a file
 *   at the base, so its changed lines cannot be trusted.
 */

export type OwnerAtBaseEntry =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "file"; blob: string }>
  | Readonly<{ kind: "not-a-file" }>;

const REGULAR_FILE_ENTRY = /^100(?:644|755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t[^\0]+\0?$/;

/** The owner's entry at the Wave base, read from `git ls-tree -z` output for exactly that one path. */
export function ownerAtBaseEntry(listing: string): OwnerAtBaseEntry {
  if (listing === "") return { kind: "absent" };
  const entry = REGULAR_FILE_ENTRY.exec(listing);
  return entry === null ? { kind: "not-a-file" } : { kind: "file", blob: entry[1]! };
}
