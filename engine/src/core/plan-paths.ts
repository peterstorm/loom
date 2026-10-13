/**
 * How a path a plan declares (a lifecycle machine file, an invariant's owner,
 * siblings and matrix test) is matched against the paths Tasks declare in
 * their `file_list`. One rule, shared by plan-binding validation, the Wave
 * Gate's lifecycle artifact check and the implementation brief, so a path the
 * validator accepted is the same path the brief tells a Task it changes.
 */

import type { InvariantOwnership, SiblingEntryPoint } from "../types";

/** Forward slashes, no leading `./`. */
export function normalizePlanPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * One-directional, suffix-tolerant match: the task path may be an absolute or
 * deeper form of the declared plan path, never the reverse — a bare-basename
 * file_list entry must not satisfy a fully-pathed declaration. A declared
 * path with no directory segment only matches exactly.
 */
export function pathsMatch(taskFile: string, declared: string): boolean {
  const nt = normalizePlanPath(taskFile);
  const nd = normalizePlanPath(declared);
  if (nt === nd) return true;
  if (!nd.includes("/")) return false;
  return nt.endsWith(`/${nd}`);
}

export type OwnedInvariant = Extract<InvariantOwnership, { kind: "owned" }>;

/** The roles one Task's `file_list` plays in an owned invariant family. */
export type InvariantRoles = Readonly<{
  owner: boolean;
  /** The sibling entry points the file list changes, in declared order. */
  siblings: readonly SiblingEntryPoint[];
  matrixTest: boolean;
}>;

/**
 * Which roles a file list plays in one owned invariant family. Plan
 * validation and the implementation brief both classify through here, so a
 * Task the validator holds to the owner-first rule is the Task the brief
 * calls a sibling.
 */
export function invariantRoles(fileList: readonly string[], ownership: OwnedInvariant): InvariantRoles {
  const changes = (path: string): boolean => fileList.some((file) => pathsMatch(file, path));
  return {
    owner: changes(ownership.owner),
    siblings: ownership.siblings.filter(({ path }) => changes(path)),
    matrixTest: changes(ownership.matrixTest),
  };
}

/** Whether the roles change the family's rule: its owner or a sibling. */
export function changesFamily(roles: InvariantRoles): boolean {
  return roles.owner || roles.siblings.length > 0;
}
